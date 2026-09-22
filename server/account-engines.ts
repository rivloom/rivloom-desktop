import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { engineRoot, dataRoot, startEngine } from './engine.ts';
import { ProviderConfigStore } from './provider-config.ts';
import { ProviderAccountStore } from './provider-accounts.ts';

type Engine = Awaited<ReturnType<typeof startEngine>>;
/** Async context is local to an operation; concurrent accounts never change global auth. */
export class AccountEnginePool {
  private context = new AsyncLocalStorage<string>();
  private running = new Map<string, Promise<Engine>>();
  private ready = new Map<string, Engine>();
  private closing = false;
  private maintenanceQueue = new Map<string, Promise<unknown>>();
  onExit: (id: string) => void = () => {};
  readonly accounts: ProviderAccountStore;
  private launch: typeof startEngine;
  constructor(accounts: ProviderAccountStore, launch = startEngine) {
    this.accounts = accounts;
    this.launch = launch;
  }
  current() {
    return this.context.getStore() || '';
  }
  client(id = this.current()) {
    const engine = this.ready.get(id);
    if (!engine) throw new Error('Account engine is not available. Reconnect this account.');
    return engine.client;
  }
  async get(id: string) {
    if (this.closing) throw new Error('Account engines are shutting down.');
    await this.maintenanceQueue.get(id)?.catch(() => {});
    if (this.closing) throw new Error('Account engines are shutting down.');
    const account = this.accounts.get(id);
    if (!account) throw new Error('Account not found.');
    let pending = this.running.get(id);
    if (!pending) {
      pending = (async () => {
        const root = this.accounts.directory(id);
        const custom = new ProviderConfigStore(this.accounts.root)
          .list()
          .find((p) => p.id === account.providerID);
        const config = new ProviderConfigStore(root);
        if (custom || !existsSync(config.file)) config.write(custom ? [custom] : []);
        const engine = await this.launch(dataRoot, 0, root, {
          workspace: true,
          providerID: account.providerID,
        });
        this.ready.set(id, engine);
        engine.child.once('exit', () => {
          this.ready.delete(id);
          this.onExit(id);
          // Keep the settled promise: never silently restart a crashed account during polling.
        });
        return engine;
      })();
      this.running.set(id, pending);
    }
    const engine = await pending;
    if (engine.child.exitCode !== null || engine.child.signalCode !== null)
      throw new Error('Account engine exited. Restart the application.');
    return engine;
  }
  async run<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (id) await this.get(id);
    return this.context.run(id, work);
  }
  /** Cleanup an explicitly recorded session even after its account credentials were disconnected. */
  maintenance<T>(id: string, work: (client: Engine['client']) => Promise<T>): Promise<T> {
    const previous = this.maintenanceQueue.get(id);
    const pending = (previous || Promise.resolve()).catch(() => {}).then(async () => {
      if (this.closing) throw new Error('Account engines are shutting down.');
      const running = this.running.get(id);
      if (running) {
        const engine = await running;
        if (engine.child.exitCode !== null || engine.child.signalCode !== null) throw new Error('Account engine exit is unresolved.');
        return work(engine.client);
      }
      const root = this.accounts.directory(id);
      if (!existsSync(root)) throw new Error('Recorded account Runtime directory is unavailable.');
      const key = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
      if (key(realpathSync(root)) !== key(join(realpathSync(this.accounts.root), 'accounts', id)))
        throw new Error('Account Runtime directory is outside its registered scope.');
      const engine = await this.launch(dataRoot, 0, root, { maintenance: true });
      try { return await work(engine.client); }
      finally { engine.close(); await engine.waitForExit(); }
    });
    this.maintenanceQueue.set(id, pending);
    void pending.finally(() => { if (this.maintenanceQueue.get(id) === pending) this.maintenanceQueue.delete(id); }).catch(() => {});
    return pending;
  }
  async dispose() {
    for (const engine of this.ready.values()) await engine.client.global.dispose();
  }
  async remove(id: string) {
    await this.maintenanceQueue.get(id)?.catch(() => {});
    const pending = this.running.get(id);
    if (!pending) return;
    const engine = await pending;
    engine.close();
    await engine.waitForExit();
    this.running.delete(id);
    this.ready.delete(id);
  }
  async close(wait = false) {
    this.closing = true;
    await Promise.allSettled(this.maintenanceQueue.values());
    const engines = await Promise.allSettled(this.running.values());
    const exits: Promise<void>[] = [];
    for (const result of engines)
      if (result.status === 'fulfilled') {
        result.value.close();
        if (wait) exits.push(result.value.waitForExit());
      }
    const results = await Promise.allSettled(exits);
    if (results.some((r) => r.status === 'rejected'))
      throw new Error('Account engine shutdown could not be confirmed.');
  }
}
export const providerAccounts = new ProviderAccountStore(engineRoot);
export const accountEngines = new AccountEnginePool(providerAccounts);
