import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { startEngine, dataRoot, ENGINE_VERSION } from '../server/engine.ts';

const directory = join(dataRoot, 'probe', String(Date.now()));
mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, 'slugify.mjs'), 'export function slugify(text) { return text; }\n');
writeFileSync(
  join(directory, 'slugify.test.mjs'),
  `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from './slugify.mjs';\ntest('slugify', () => { assert.equal(slugify(' Hello, World! '), 'hello-world'); assert.equal(slugify(' a   b '), 'a-b'); assert.equal(slugify('---Hi---'), 'hi'); });\n`,
);
execFileSync('git', ['init', '-q'], { cwd: directory });
execFileSync('git', ['add', '.'], { cwd: directory });
execFileSync(
  'git',
  ['-c', 'user.name=Rivloom Probe', '-c', 'user.email=probe@localhost', 'commit', '-qm', 'fixture'],
  { cwd: directory },
);
const engine = await startEngine(directory);
console.log('ENGINE', ENGINE_VERSION, engine.url);
const events: Record<string, number> = {};
const abort = new AbortController();
let deltas = 0;
const feed = await engine.client.event.subscribe({ directory }, { signal: abort.signal });
const collect = (async () => {
  for await (const event of feed.stream) {
    events[event.type] = (events[event.type] || 0) + 1;
    if (event.type === 'message.part.delta') deltas++;
    if (event.type === 'session.error') console.log('SESSION_ERROR', event.properties.error?.name);
  }
})();
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
try {
  const providers = (await engine.client.provider.list({ directory })).data!;
  const connected = providers.all.filter((p) => providers.connected.includes(p.id));
  console.log(
    'CONNECTED_MODELS',
    connected.map((p) => ({ id: p.id, models: Object.keys(p.models) })),
  );
  if (process.argv.includes('--inspect')) process.exitCode = 0;
  else {
    const provider =
      connected.find((p) => p.id === process.env.RIVLOOM_MODEL?.split('/')[0]) ||
      connected.find((p) => p.id === 'opencode') ||
      connected[0];
    assert(provider, '需要先运行 npm run engine:login 配置模型。');
    const modelID =
      process.env.RIVLOOM_MODEL?.split('/').slice(1).join('/') ||
      Object.keys(provider.models).find((m) => m.includes('minimax')) ||
      Object.keys(provider.models)[0];
    const model = { providerID: provider.id, modelID };
    console.log('MODEL', model);
    const session = (
      await engine.client.session.create({ directory, title: 'Rivloom real engine probe' })
    ).data!;
    await engine.client.session.promptAsync({
      directory,
      sessionID: session.id,
      model,
      parts: [
        {
          type: 'text',
          text: 'Fix slugify.mjs to pass the existing slugify.test.mjs. Use edit or apply_patch to modify ONLY slugify.mjs. Run exactly node --test slugify.test.mjs using bash to verify. Do not modify tests. Do not use subagents. Briefly report the result.',
        },
      ],
    });
    const approvals: string[] = [];
    let done = false;
    for (let i = 0; i < 240; i++) {
      await delay(1000);
      for (const p of (await engine.client.permission.list({ directory })).data || []) {
        if (p.sessionID !== session.id || approvals.includes(p.id)) continue;
        console.log(
          'APPROVAL_REQUEST',
          JSON.stringify({
            id: p.id,
            permission: p.permission,
            patterns: p.patterns,
            metadata: p.metadata,
          }),
        );
        const safe =
          (p.permission === 'edit' && p.patterns.every((f) => /(^|[\\/])slugify\.mjs$/.test(f))) ||
          (p.permission === 'bash' &&
            p.patterns.every((c) => c === 'node --test slugify.test.mjs'));
        assert(safe, '探针遇到超出固定测试范围的请求，未批准。');
        await engine.client.permission.reply({ directory, requestID: p.id, reply: 'once' });
        approvals.push(p.id);
        console.log('APPROVED_ONCE', p.id);
      }
      const messages = (await engine.client.session.messages({ directory, sessionID: session.id }))
        .data!;
      const status = (await engine.client.session.status({ directory })).data!;
      if (
        messages.some((m) => m.info.role === 'assistant' && m.info.time.completed) &&
        (!status[session.id] || status[session.id].type === 'idle')
      ) {
        done = true;
        break;
      }
    }
    assert(done, '真实任务未在 240 秒内完成');
    assert(approvals.length >= 2, '未验证编辑和命令审批');
    assert(deltas > 0, '未收到流式增量');
    const testOutput = execFileSync(process.execPath, ['--test', 'slugify.test.mjs'], {
      cwd: directory,
      encoding: 'utf8',
    });
    const messages = (await engine.client.session.messages({ directory, sessionID: session.id }))
      .data!;
    let diff = (await engine.client.session.diff({ directory, sessionID: session.id })).data!;
    for (let i = 0; !diff.length && i < 10; i++) {
      await delay(500);
      diff = (await engine.client.session.diff({ directory, sessionID: session.id })).data!;
    }
    const gitDiff = execFileSync('git', ['diff', '--no-ext-diff', 'HEAD', '--', '.'], {
      cwd: directory,
      encoding: 'utf8',
    });
    assert(
      gitDiff.includes('+export function slugify') || gitDiff.includes('+  return text'),
      'Git 未取得真实修改',
    );
    const stop = (await engine.client.session.create({ directory, title: 'Rivloom abort probe' }))
      .data!;
    await engine.client.session.promptAsync({
      directory,
      sessionID: stop.id,
      model,
      parts: [
        {
          type: 'text',
          text: 'Use edit to change slugify.mjs by adding a comment at the top. Do not run commands or use subagents.',
        },
      ],
    });
    let waiting = false;
    for (let i = 0; i < 90; i++) {
      await delay(1000);
      if (
        (await engine.client.permission.list({ directory })).data!.some(
          (p) => p.sessionID === stop.id,
        )
      ) {
        waiting = true;
        break;
      }
    }
    assert(waiting, '停止测试未进入真实等待审批状态');
    const beforeStop = readFileSync(join(directory, 'slugify.mjs'), 'utf8');
    assert.equal((await engine.client.session.abort({ directory, sessionID: stop.id })).data, true);
    await delay(1000);
    assert.equal(readFileSync(join(directory, 'slugify.mjs'), 'utf8'), beforeStop);
    const stale = (await engine.client.permission.list({ directory })).data!.filter(
      (p) => p.sessionID === stop.id,
    );
    for (const p of stale)
      await engine.client.permission.reply({ directory, requestID: p.id, reply: 'reject' });
    const stoppedStatus = (await engine.client.session.status({ directory })).data![stop.id];
    assert(!stoppedStatus || stoppedStatus.type === 'idle');
    assert(
      !(await engine.client.permission.list({ directory })).data!.some(
        (p) => p.sessionID === stop.id,
      ),
    );
    const result = {
      verifiedAt: new Date().toISOString(),
      version: ENGINE_VERSION,
      model,
      directory,
      sessionID: session.id,
      abortSessionID: stop.id,
      approvals: approvals.length,
      deltas,
      events,
      diff,
      result: messages
        .filter((m) => m.info.role === 'assistant')
        .flatMap((m) => m.parts.filter((p) => p.type === 'text').map((p) => p.text))
        .join('\n'),
      testOutput,
      stoppedBeforeWrite: true,
      approvalMode: 'fixture-only test operator; not an end-user usability test',
    };
    Object.assign(result, { gitDiff, diffSource: diff.length ? 'opencode' : 'git-fallback' });
    mkdirSync(join(dataRoot, 'verification'), { recursive: true });
    writeFileSync(
      join(dataRoot, 'verification', 'engine-probe.json'),
      JSON.stringify(result, null, 2),
    );
    console.log(
      'PROBE_PASS',
      JSON.stringify({
        sessionID: session.id,
        approvals: approvals.length,
        deltas,
        diffFiles: diff.length,
        stoppedBeforeWrite: true,
      }),
    );
  }
} finally {
  abort.abort();
  engine.close();
  await collect.catch(() => {});
}
