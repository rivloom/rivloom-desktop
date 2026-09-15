import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { isBindConflict, probeHttpPort, withHttpPort } from './http-ports.ts';
import { createOpencodeClient, type Config, type PermissionRuleset } from '@opencode-ai/sdk/v2';
import type { ApprovalMode } from '../shared/types.ts';
import { knowledgeEngineConfig } from './knowledge-engine.ts';
import { prepareEnginePluginDependencies } from './engine-plugin-dependencies.ts';

export const ENGINE_VERSION = '1.18.25';
export const dataRoot = resolve(process.env.RIVLOOM_DATA_DIR || '.data');
export const engineRoot = join(dataRoot, 'engine');
const require = createRequire(import.meta.url);
export function engineBinary() {
  if (process.platform !== 'win32') throw new Error('此 MVP 当前只验证 Windows x64。');
  return join(require.resolve('opencode-windows-x64/package.json'), '..', 'bin', 'opencode.exe');
}
export const permissions: Config['permission'] = {
  '*': 'ask',
  read: { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny', '*.pem': 'deny', '*auth.json': 'deny' },
  glob: 'allow',
  grep: 'allow',
  edit: 'ask',
  bash: 'ask',
  question: 'allow',
  task: 'deny',
  skill: 'deny',
  rivloom_knowledge_search: 'allow',
  rivloom_knowledge_read: 'allow',
  rivloom_memory_save: 'ask',
  external_directory: 'deny',
  webfetch: 'deny',
  websearch: 'deny',
};

export function sessionPermissions(mode: ApprovalMode): PermissionRuleset {
  const rules: PermissionRuleset = [
    { permission: '*', pattern: '*', action: mode === 'full' ? 'allow' : 'ask' },
    { permission: 'read', pattern: '*', action: 'allow' },
    { permission: 'glob', pattern: '*', action: 'allow' },
    { permission: 'grep', pattern: '*', action: 'allow' },
    { permission: 'list', pattern: '*', action: 'allow' },
    { permission: 'question', pattern: '*', action: 'allow' },
    { permission: 'rivloom_knowledge_search', pattern: '*', action: 'allow' },
    { permission: 'rivloom_knowledge_read', pattern: '*', action: 'allow' },
    { permission: 'rivloom_memory_save', pattern: '*', action: mode === 'ask' ? 'ask' : 'allow' },
  ];
  if (mode === 'auto' || mode === 'full') {
    rules.push(
      { permission: 'edit', pattern: '*', action: 'allow' },
      { permission: 'bash', pattern: '*', action: 'allow' },
    );
  }
  if (mode === 'full') {
    rules.push(
      { permission: 'webfetch', pattern: '*', action: 'allow' },
      { permission: 'websearch', pattern: '*', action: 'allow' },
      { permission: 'external_directory', pattern: '*', action: 'allow' },
    );
  } else {
    rules.push(
      { permission: 'webfetch', pattern: '*', action: 'ask' },
      { permission: 'websearch', pattern: '*', action: 'ask' },
      { permission: 'external_directory', pattern: '*', action: 'deny' },
    );
  }
  rules.push(
    { permission: 'read', pattern: '*.env', action: 'deny' },
    { permission: 'read', pattern: '*.env.*', action: 'deny' },
    { permission: 'read', pattern: '*.pem', action: 'deny' },
    { permission: 'read', pattern: '*.key', action: 'deny' },
    { permission: 'read', pattern: '*.p12', action: 'deny' },
    { permission: 'read', pattern: '*auth.json', action: 'deny' },
    { permission: 'read', pattern: '*credentials*', action: 'deny' },
    { permission: 'task', pattern: '*', action: 'deny' },
    { permission: 'skill', pattern: '*', action: 'deny' },
  );
  return rules;
}
export function engineEnv(password?: string, root = engineRoot): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      /^(path|systemroot|windir|comspec|pathext|userprofile|appdata|localappdata|programdata|programfiles|programfiles\(x86\)|systemdrive|https?_proxy|no_proxy)$/i.test(
        key,
      )
    )
      env[key] = value;
  }
  for (const [key, folder] of Object.entries({
    XDG_CONFIG_HOME: 'config',
    XDG_DATA_HOME: 'data',
    XDG_CACHE_HOME: 'cache',
    XDG_STATE_HOME: 'state',
    TEMP: 'temp',
    TMP: 'temp',
  })) {
    env[key] = join(root, folder);
    mkdirSync(env[key]!, { recursive: true });
  }
  const knowledge = root === engineRoot ? knowledgeEngineConfig() : null;
  if (knowledge) {
    prepareEnginePluginDependencies(root);
    env.RIVLOOM_KNOWLEDGE_BRIDGE_URL = knowledge.url;
    env.RIVLOOM_KNOWLEDGE_BRIDGE_TOKEN = knowledge.token;
  }
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    autoupdate: false,
    share: 'disabled',
    snapshot: false,
    permission: permissions,
    agent: { build: { permission: permissions } },
    ...(knowledge ? { plugin: [knowledge.plugin] } : {}),
  });
  const providerConfig = join(root, 'rivloom-providers.json');
  if (!existsSync(providerConfig)) writeFileSync(providerConfig, '{"provider":{}}', { mode: 0o600 });
  env.OPENCODE_CONFIG = providerConfig;
  if (password) {
    env.OPENCODE_SERVER_PASSWORD = password;
    env.OPENCODE_SERVER_USERNAME = 'rivloom';
  }
  return env;
}

export function importAuth(source: string) {
  const destination = join(engineRoot, 'data', 'opencode', 'auth.json');
  if (existsSync(destination)) throw new Error('独立引擎已有凭据，不会覆盖。');
  const auth = JSON.parse(readFileSync(source, 'utf8'));
  mkdirSync(join(destination, '..'), { recursive: true });
  writeFileSync(destination, JSON.stringify(auth), { mode: 0o600 });
  return Object.keys(auth);
}

export async function startEngine(cwd: string, port = 0, root = engineRoot) {
  const password = randomBytes(32).toString('hex');
  return withHttpPort(async (candidate) => {
    // The official CLI cannot inherit this socket. Probe, release, then validate its actual bind.
    await probeHttpPort(candidate);
    return startEngineOnPort(cwd, candidate, password, root);
  }, port);
}

async function stopFailedEngine(child: ChildProcess | undefined, requireSuccessfulExit = false) {
  const check = (code: number | null) => {
    if (requireSuccessfulExit && code !== 0) throw new Error('Owned OpenCode process tree did not exit cleanly.');
  };
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) { check(child?.exitCode ?? null); return; }
  await new Promise<void>((ok, fail) => {
    const finished = (code: number | null) => {
      clearTimeout(timeout);
      try { check(code); ok(); } catch (error) { fail(error); }
    };
    const timeout = setTimeout(() => {
      child.off('exit', finished);
      fail(new Error('启动失败的 OpenCode 子进程未及时退出；不继续创建新引擎。'));
    }, 8000);
    child.once('exit', finished);
    // engine-host owns and terminates only its official engine child on IPC disconnect.
    if (child.connected) child.disconnect();
  });
}

async function startEngineOnPort(cwd: string, port: number, password: string, root: string) {
  let child: ChildProcess | undefined;
  let announced = false;
  try {
    const url = await new Promise<string>((ok, fail) => {
      child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL('./engine-host.mjs', import.meta.url)),
          engineBinary(),
          'serve',
          '--hostname',
          '127.0.0.1',
          '--port',
          String(port),
        ],
        {
          cwd,
          env: engineEnv(password, root),
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          windowsHide: true,
        },
      );
      let output = '';
      const timeout = setTimeout(() => {
        if (child?.connected) child.disconnect();
        fail(new Error('OpenCode 启动超时'));
      }, 45_000);
      child.once('error', (error) => {
        clearTimeout(timeout);
        fail(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        fail(new Error(`OpenCode 退出 (${code}): ${output.slice(-1800)}`));
      });
      const onData = (data: Buffer) => {
        output = (output + data.toString()).slice(-4000);
        const match = output.match(/opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) {
          announced = true;
          clearTimeout(timeout);
          ok(match[1]);
        }
      };
      child.stdout!.on('data', onData);
      child.stderr!.on('data', onData);
    });
    if (url !== `http://127.0.0.1:${port}`)
      throw new Error('OpenCode 返回了非预期监听地址，不连接该服务。');
    const headers = {
      Authorization: `Basic ${Buffer.from(`rivloom:${password}`).toString('base64')}`,
    };
    const client = createOpencodeClient({
      baseUrl: url,
      headers,
      throwOnError: true,
      fetch: (input, init) => {
        const address = input instanceof Request ? input.url : String(input);
        if (new URL(address).pathname.endsWith('/event')) return fetch(input, init);
        const caller = init?.signal || (input instanceof Request ? input.signal : undefined);
        const timeout = /\/provider\/[^/]+\/oauth\/callback$/.test(new URL(address).pathname) ? 10 * 60_000 : 20000;
        const signal = caller
          ? AbortSignal.any([caller, AbortSignal.timeout(timeout)])
          : AbortSignal.timeout(timeout);
        return fetch(input, { ...init, signal });
      },
    });
    const health = await client.global.health();
    if (health.data?.version !== ENGINE_VERSION) {
      throw new Error(`引擎版本不匹配：需要 ${ENGINE_VERSION}`);
    }
    console.log(`RIVLOOM_ENGINE_READY ${url}`);
    return {
      client,
      url,
      child: child!,
      headers,
      close: () => {
        if (child!.connected) child!.disconnect();
      },
      waitForExit: () => stopFailedEngine(child, true),
    };
  } catch (error) {
    await stopFailedEngine(child);
    if (!announced) {
      // Official OpenCode may report only ServeError. Confirm a real bind conflict instead of
      // classifying every engine failure as a port error. Never retry a reported/health-failed server.
      try {
        await probeHttpPort(port);
      } catch (bindError) {
        if (isBindConflict(bindError)) {
          throw Object.assign(
            new Error(`OpenCode 启动时 HTTP 端口 ${port} 已不可用。`, { cause: error }),
            {
              code: (bindError as NodeJS.ErrnoException).code,
            },
          );
        }
      }
    }
    throw error;
  }
}
