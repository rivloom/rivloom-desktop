import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { Auth } from '@opencode-ai/sdk/v2';
import { startEngine, dataRoot } from './engine.ts';
import { safeOAuthURL, type OAuthStatus } from '../shared/model-providers.ts';

export type OAuthDriver = {
  authorize(
    provider: string,
    method: number,
    inputs: Record<string, string>,
  ): Promise<{ url: string; instructions: string; method: 'auto' | 'code' }>;
  complete(provider: string, method: number, code?: string): Promise<Auth>;
  close(): Promise<void>;
};
export async function isolatedOAuthDriver(): Promise<OAuthDriver> {
  const parent = resolve(dataRoot, 'oauth-staging');
  const root = resolve(parent, randomUUID());
  mkdirSync(root, { recursive: true });
  const engineRoot = join(root, 'engine');
  const engine = await startEngine(root, 0, engineRoot);
  let closing: Promise<void> | undefined;
  return {
    async authorize(providerID, method, inputs) {
      return (
        await engine.client.provider.oauth.authorize({
          providerID,
          method,
          inputs,
          directory: root,
        })
      ).data!;
    },
    async complete(providerID, method, code) {
      await engine.client.provider.oauth.callback({ providerID, method, code, directory: root });
      // Read only the newly created staging engine's result; never import another app's account.
      const credentials = JSON.parse(
        readFileSync(join(engineRoot, 'data', 'opencode', 'auth.json'), 'utf8'),
      );
      return z
        .discriminatedUnion('type', [
          z.object({
            type: z.literal('oauth'),
            access: z.string(),
            refresh: z.string(),
            expires: z.number(),
            accountId: z.string().optional(),
            enterpriseUrl: z.string().optional(),
          }),
          z.object({
            type: z.literal('api'),
            key: z.string().min(1),
            metadata: z.record(z.string(), z.string()).optional(),
          }),
        ])
        .parse(credentials[providerID]);
    },
    close() {
      return (closing ||= (async () => {
        engine.close();
        await engine.waitForExit();
        if (!root.startsWith(parent + sep) || root === parent)
          throw new Error('Invalid staging path');
        rmSync(root, { recursive: true, force: true });
      })());
    },
  };
}

type Attempt = {
  view: OAuthStatus;
  actorID: string;
  method: number;
  driver: Promise<OAuthDriver>;
  timer: ReturnType<typeof setTimeout>;
  closing?: Promise<void>;
  cleanupPending?: boolean;
};
export class ProviderOAuth {
  private current: Attempt | null = null;
  private readonly createDriver: () => Promise<OAuthDriver>;
  private readonly commit: (
    provider: string,
    auth: Auth,
    actorID: string,
    current: () => boolean,
    accepted: () => void,
  ) => Promise<void>;
  private readonly notify: () => void;
  private readonly lifetime: number;
  constructor(
    createDriver: () => Promise<OAuthDriver>,
    commit: (
      provider: string,
      auth: Auth,
      actorID: string,
      current: () => boolean,
      accepted: () => void,
    ) => Promise<void>,
    notify: () => void,
    lifetime = 10 * 60_000,
  ) {
    this.createDriver = createDriver;
    this.commit = commit;
    this.notify = notify;
    this.lifetime = lifetime;
  }
  get busy() {
    return (
      !!this.current &&
      (this.current.cleanupPending ||
        ['starting', 'waiting', 'connecting', 'saving'].includes(this.current.view.status))
    );
  }
  snapshot(actorID: string) {
    return this.current?.actorID === actorID ? { ...this.current.view } : null;
  }
  private active(attempt: Attempt) {
    return (
      this.current === attempt &&
      ['starting', 'waiting', 'connecting', 'saving'].includes(attempt.view.status)
    );
  }
  begin(actorID: string, providerID: string, method: number, inputs: Record<string, string>) {
    if (this.busy) throw new Error('OAuth already running');
    const attempt: Attempt = {
      view: {
        id: randomUUID(),
        providerID,
        status: 'starting',
        expiresAt: new Date(Date.now() + this.lifetime).toISOString(),
      },
      actorID,
      method,
      driver: Promise.resolve().then(this.createDriver),
      timer: setTimeout(
        () => void this.finish(attempt, 'failed', 'OAuth timed out. Start a new sign-in.'),
        this.lifetime,
      ),
    };
    attempt.timer.unref();
    this.current = attempt;
    void this.prepare(attempt, inputs);
    this.notify();
    return this.snapshot(actorID)!;
  }
  private async prepare(attempt: Attempt, inputs: Record<string, string>) {
    try {
      const driver = await attempt.driver;
      if (!this.active(attempt)) return;
      const auth = await driver.authorize(attempt.view.providerID, attempt.method, inputs);
      if (!this.active(attempt)) return;
      Object.assign(attempt.view, {
        url: safeOAuthURL(auth.url),
        instructions: auth.instructions.slice(0, 8000),
        mode: auth.method,
        status: 'waiting',
      });
      this.notify();
    } catch {
      if (this.active(attempt))
        await this.finish(attempt, 'failed', 'Could not start vendor sign-in. Please retry.');
    }
  }
  complete(actorID: string, id: string, code?: string) {
    const attempt = this.requireAttempt(actorID, id);
    if (attempt.view.status !== 'waiting') throw new Error('OAuth is not waiting');
    if (attempt.view.mode === 'code' && !code) throw new Error('Authorization code required');
    attempt.view.status = 'connecting';
    this.notify();
    void this.connect(attempt, code);
    return this.snapshot(actorID)!;
  }
  private async connect(attempt: Attempt, code?: string) {
    try {
      const auth = await (
        await attempt.driver
      ).complete(attempt.view.providerID, attempt.method, code);
      if (!this.active(attempt)) return;
      await this.commit(
        attempt.view.providerID,
        auth,
        attempt.actorID,
        () => this.active(attempt),
        () => {
          attempt.view.status = 'saving';
          clearTimeout(attempt.timer);
          this.notify();
        },
      );
      if (this.active(attempt)) await this.finish(attempt, 'connected');
    } catch {
      if (this.active(attempt))
        await this.finish(
          attempt,
          'failed',
          'Sign-in did not complete. Refresh provider status before trying again.',
        );
    }
  }
  private requireAttempt(actorID: string, id: string) {
    if (!this.current || this.current.actorID !== actorID || this.current.view.id !== id)
      throw new Error('OAuth attempt not found');
    return this.current;
  }
  url(actorID: string, id: string) {
    const attempt = this.requireAttempt(actorID, id);
    if (!this.active(attempt) || !attempt.view.url) throw new Error('No active authorization URL');
    return safeOAuthURL(attempt.view.url);
  }
  async cancel(actorID: string, id: string) {
    const attempt = this.requireAttempt(actorID, id);
    if (this.active(attempt) && attempt.view.status !== 'saving')
      await this.finish(attempt, 'cancelled');
    return this.snapshot(actorID)!;
  }
  async close() {
    if (this.current) await this.finish(this.current, 'cancelled');
  }
  private async finish(attempt: Attempt, status: OAuthStatus['status'], message?: string) {
    if (attempt.closing) return attempt.closing;
    attempt.view.status = status;
    attempt.view.message = message;
    delete attempt.view.url;
    delete attempt.view.instructions;
    attempt.cleanupPending = true;
    clearTimeout(attempt.timer);
    this.notify();
    attempt.closing = (async () => {
      let driver: OAuthDriver;
      try {
        driver = await attempt.driver;
      } catch {
        // startEngine owns cleanup of a failed launch; there is no returned driver to close.
        attempt.cleanupPending = false;
        this.notify();
        return;
      }
      try { await driver.close(); attempt.cleanupPending = false; }
      catch { attempt.view.message = 'Sign-in cleanup needs an application restart.'; }
      this.notify();
    })();
    return attempt.closing;
  }
}
