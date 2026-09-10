// Test infrastructure only: real Rivloom/OpenCode processes, deterministic loopback model.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import type { Bootstrap, NodeNetwork } from '../shared/types.ts';
import { listenHttp } from '../server/http-ports.ts';

export async function until<T>(
  read: () => Promise<T>,
  check: (value: T) => boolean,
  label: string,
  timeout = 45_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let value: T | undefined;
  let lastError = '';
  do {
    try {
      value = await read();
      if (check(value)) return value;
    } catch (error) {
      lastError = String(error);
    }
    await wait(100);
  } while (Date.now() < deadline);
  throw new Error(`${label}: timeout ${lastError}`);
}

export type FixtureModelReply = { content: string } | { toolName: string; arguments: Record<string, unknown> };
export async function modelFixture(timeout = 120_000, replyFor?: (input: any) => FixtureModelReply | Promise<FixtureModelReply>) {
  let released = false;
  let requests = 0;
  const pending = new Set<() => void>();
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(async (request, response: ServerResponse) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    requests += 1;
    const input = JSON.parse(body);
    const finish = async () => {
      pending.delete(finish);
      if (response.destroyed) return;
      const base = {
        id: 'chatcmpl-local-fixture',
        created: Math.floor(Date.now() / 1000),
        model: input.model,
      };
      let reply: FixtureModelReply;
      try { reply = await replyFor?.(input) || { content: 'M3.4 loopback fixture completed. No tools or files were changed.' }; }
      catch (error) { if (!response.destroyed) response.writeHead(500).end(String(error)); return; }
      if (response.destroyed) return;
      const toolCall = 'toolName' in reply ? { id: `call_fixture_${requests}`, type: 'function',
        function: { name: reply.toolName, arguments: JSON.stringify(reply.arguments) } } : null;
      const finishReason = toolCall ? 'tool_calls' : 'stop';
      if (input.stream) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(
          `data: ${JSON.stringify({
            ...base,
            object: 'chat.completion.chunk',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  ...(toolCall ? { tool_calls: [{ index: 0, ...toolCall }] } : { content: 'content' in reply ? reply.content : '' }),
                },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({
            ...base,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          })}\n\n`,
        );
        response.end('data: [DONE]\n\n');
      } else
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            ...base,
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', ...(toolCall ? { content: null, tool_calls: [toolCall] } : { content: 'content' in reply ? reply.content : 'M3.4 fixture' }) },
                finish_reason: finishReason,
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          }),
        );
    };
    if (released) finish();
    else pending.add(finish);
    response.once('close', () => pending.delete(finish));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await listenHttp(server, '127.0.0.1');
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    get requests() {
      return requests;
    },
    get pendingRequests() {
      return pending.size;
    },
    configure(root: string) {
      const config = join(root, 'engine', 'config', 'opencode');
      mkdirSync(config, { recursive: true });
      writeFileSync(
        join(config, 'opencode.json'),
        JSON.stringify({
          enabled_providers: ['fixture'],
          model: 'fixture/m34',
          small_model: 'fixture/m34',
          provider: {
            fixture: {
              name: 'M3.4 local test fixture',
              npm: '@ai-sdk/openai-compatible',
              options: {
                baseURL: `http://127.0.0.1:${address.port}/v1`,
                apiKey: 'local-test-only',
                timeout,
              },
              models: {
                m34: {
                  name: 'M3.4 deterministic fixture',
                  tool_call: true,
                  limit: { context: 32_000, output: 1000 },
                  cost: { input: 0, output: 0 },
                },
              },
            },
          },
        }),
      );
    },
    hold() {
      released = false;
    },
    releaseNext(count = 1) {
      assert(Number.isSafeInteger(count) && count > 0);
      for (const finish of [...pending].slice(0, count)) finish();
    },
    release() {
      released = true;
      for (const finish of pending) finish();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}

export class ServiceClient {
  cookie = '';
  base = '';
  output = '';
  child: ChildProcess | null = null;
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  async call<T = any>(
    path: string,
    body?: unknown,
    expected = 200,
    extra: Record<string, string> = {},
  ): Promise<T> {
    const response = await fetch(`${this.base}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Rivloom-Request': '1',
        Cookie: this.cookie,
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (response.headers.has('set-cookie'))
      this.cookie = response.headers.get('set-cookie')!.split(';')[0];
    const value = await response.json();
    assert.equal(response.status, expected, `${path}: ${JSON.stringify(value)}`);
    return value;
  }
  network() {
    return this.call<NodeNetwork>('/network');
  }
  bootstrap() {
    return this.call<Bootstrap>('/bootstrap');
  }
  async authenticate() {
    await this.call('/auth/desktop', {}, 200, {
      'X-Rivloom-Desktop-Token': readFileSync(
        join(this.root, 'desktop-auth-token.txt'),
        'utf8',
      ).trim(),
    });
  }
  async start(
    options: {
      runtimeDirectory?: string;
      clockOffsetMilliseconds?: number;
      discovery?: { port: number; mdns: boolean };
      logPath?: string;
      sessionCrashPoint?: 'before_create' | 'after_create';
    } = {},
  ) {
    assert(
      !this.child || this.child.exitCode !== null || this.child.signalCode !== null,
      'Stop this test child before restarting',
    );
    this.base = '';
    this.cookie = '';
    this.output = '';
    const args: string[] = [];
    const clockEnvironment: Record<string, string> = {};
    const discoveryEnvironment: Record<string, string> = {};
    if (options.sessionCrashPoint) {
      args.push('--import', pathToFileURL(resolve('scripts/m35-session-crash-fixture.ts')).href);
      clockEnvironment.RIVLOOM_TEST_SESSION_CRASH_POINT = options.sessionCrashPoint;
    }
    if (options.discovery) {
      assert(Number.isInteger(options.discovery.port));
      assert(options.discovery.port > 0 && options.discovery.port <= 65_535);
      discoveryEnvironment.RIVLOOM_DISCOVERY_PORT = String(options.discovery.port);
      discoveryEnvironment.RIVLOOM_MDNS_NETWORK = options.discovery.mdns ? 'enabled' : 'disabled';
      discoveryEnvironment.RIVLOOM_DISCOVERY_FALLBACK = 'enabled';
    }
    if (options.clockOffsetMilliseconds !== undefined) {
      assert(Number.isSafeInteger(options.clockOffsetMilliseconds));
      assert(Math.abs(options.clockOffsetMilliseconds) <= 60_000);
      args.push('--import', pathToFileURL(resolve('scripts/m34-clock-fixture.ts')).href);
      clockEnvironment.RIVLOOM_TEST_CLOCK_OFFSET_MS = String(options.clockOffsetMilliseconds);
    }
    this.child = spawn(process.execPath, [...args, 'server/desktop-entry.mjs'], {
      cwd: options.runtimeDirectory || resolve('.'),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...clockEnvironment,
        ...discoveryEnvironment,
        PORT: '0',
        RIVLOOM_DESKTOP: '1',
        RIVLOOM_DATA_DIR: this.root,
      },
    });
    const capture = (chunk: Buffer) => {
      if (options.logPath) appendFileSync(options.logPath, chunk);
      this.output = (this.output + chunk).slice(-6000);
      const match = this.output.match(/RIVLOOM_DESKTOP_READY (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) this.base = match[1];
    };
    this.child.stdout!.on('data', capture);
    this.child.stderr!.on('data', capture);
    await until(async () => !!this.base, Boolean, 'service URL');
    await until(
      () => this.call<{ engineReady: boolean }>('/health'),
      (health) => health.engineReady,
      `official engine ready (${this.root})`,
    );
    await this.authenticate();
    const bootstrap = await this.bootstrap();
    assert.deepEqual(
      bootstrap.engine.models.map((model) => model.id),
      ['fixture/m34'],
    );
  }
  async stop() {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise<void>((ok) => this.child!.once('exit', () => ok()));
    this.child.stdin!.end('shutdown\n');
    await Promise.race([exited, wait(9000)]);
    if (this.child.exitCode === null) {
      this.child.kill();
      await exited;
    }
  }
}

export async function pairServices(left: ServiceClient, right: ServiceClient) {
  const leftID = (await left.network()).local!.id;
  const rightID = (await right.network()).local!.id;
  await until(
    () => left.network(),
    (network) => network.nearby.some((node) => node.id === rightID && node.online),
    'peer discovery',
  );
  await until(
    () => right.network(),
    (network) => network.nearby.some((node) => node.id === leftID && node.online),
    'reverse discovery',
  );
  await left.call('/network/pairings', { nodeID: rightID }, 201);
  const pairing = (await left.network()).pairings.find((item) => item.nodeID === rightID)!;
  await left.call(`/network/pairings/${pairing.id}/confirm`, {});
  await right.call(`/network/pairings/${pairing.id}/confirm`, {});
  await until(
    () => left.network(),
    (network) => !!network.nearby.find((node) => node.id === rightID)?.channelReady,
    'secure channel',
  );
}
