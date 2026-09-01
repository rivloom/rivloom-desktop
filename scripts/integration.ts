// End-to-end verification against the real application and official engine; no mocks.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import type { Bootstrap, Task, User } from '../shared/types.ts';
import { createExample } from './example.ts';

const desktopExecutable = process.env.RIVLOOM_TEST_DESKTOP_EXECUTABLE;
const directory = resolve(
  '.data',
  desktopExecutable ? 'desktop-integration' : 'integration',
  String(Date.now()),
);
mkdirSync(directory, { recursive: true });
const repo = join(directory, 'workspace');
createExample(repo);
const port = 4317;
let base = `http://127.0.0.1:${port}`;
let processHandle: ChildProcess;
let output = '';
let feedAbort = new AbortController();
const proof: Record<string, unknown> = {
  date: new Date().toISOString(),
  kind: desktopExecutable
    ? 'packaged-tauri / real-engine / separate-authenticated-clients'
    : 'real-engine / separate-authenticated-clients',
  executable: desktopExecutable || null,
  directory,
  assertions: [] as string[],
};
const pass = (text: string) => {
  (proof.assertions as string[]).push(text);
  console.log('PASS', text);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function start() {
  output = '';
  processHandle = spawn(
    desktopExecutable || process.execPath,
    desktopExecutable ? [] : ['server/index.ts'],
    {
      cwd: process.cwd(),
      windowsHide: true,
      env: { ...process.env, PORT: String(port), RIVLOOM_DATA_DIR: directory },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  processHandle.stdout!.on('data', (data) => {
    output = (output + String(data)).slice(-4000);
  });
  processHandle.stderr!.on('data', (data) => {
    output = (output + String(data)).slice(-4000);
  });
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (processHandle.exitCode !== null) throw new Error(`App startup failed: ${output}`);
    try {
      if (desktopExecutable) {
        const runtime = JSON.parse(readFileSync(join(directory, 'desktop-runtime.json'), 'utf8'));
        if (runtime.desktopPID !== processHandle.pid) continue;
        base = runtime.url;
      }
      const r = await fetch(`${base}/api/health`);
      if ((await r.json()).engineReady) return;
    } catch {
      /* startup */
    }
  }
  throw new Error(`App not ready: ${output}`);
}
async function stop() {
  if (processHandle.exitCode !== null) return;
  let backendPID: number | undefined;
  if (desktopExecutable)
    backendPID = JSON.parse(
      readFileSync(join(directory, 'desktop-runtime.json'), 'utf8'),
    ).backendPID;
  processHandle.kill();
  await Promise.race([
    new Promise<void>((r) => processHandle.once('exit', () => r())),
    sleep(4000),
  ]);
  await sleep(desktopExecutable ? 9000 : 1500); // Native crash closes stdin; backend then closes the engine IPC owner.
  if (backendPID) {
    let alive = true;
    try {
      process.kill(backendPID, 0);
    } catch {
      alive = false;
    }
    assert(!alive, 'Native exit left its backend process alive');
  }
}
class Client {
  cookie = '';
  user!: User;
  async call<T>(
    path: string,
    body?: unknown,
    expected = 200,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const response = await fetch(`${base}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Rivloom-Request': '1',
        Cookie: this.cookie,
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.headers.has('set-cookie'))
      this.cookie = response.headers.get('set-cookie')!.split(';')[0];
    const data = await response.json();
    assert.equal(response.status, expected, `${path}: ${JSON.stringify(data)}`);
    return data;
  }
}
const owner = new Client(),
  member = new Client(),
  outsider = new Client();
const password = `Rivloom-${randomBytes(18).toString('hex')}`;
const taskBody = (projectID: string, title: string, description: string) => ({
  projectID,
  title,
  description,
  criteria: 'node --test slugify.test.mjs 通过，不修改测试文件',
  assigneeID: member.user.id,
  approverID: owner.user.id,
  reviewerID: owner.user.id,
  model: 'opencode/mimo-v2.5-free',
});
async function get(id: string) {
  return (await owner.call<{ task: Task }>(`/tasks/${id}`)).task;
}
try {
  await start();
  await new Client().call('/bootstrap', undefined, 401);
  pass('Anonymous clients cannot access workspace');
  const csrf = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.invalid' },
    body: '{}',
  });
  assert.equal(csrf.status, 403);
  pass('Cross-origin mutations rejected');
  if (desktopExecutable) {
    await owner.call('/auth/desktop', {}, 403);
    owner.user = await owner.call('/auth/desktop', {}, 200, {
      'X-Rivloom-Desktop-Token': readFileSync(
        join(directory, 'desktop-auth-token.txt'),
        'utf8',
      ).trim(),
    });
    pass('Desktop local operator requires the native launch token and needs no onboarding form');
  } else
    owner.user = await owner.call('/auth/setup', {
      username: 'owner',
      name: '林 · 发起与审批',
      password,
      code: readFileSync(join(directory, 'setup-code.txt'), 'utf8'),
    });
  const invite = await owner.call<{ code: string }>('/invitations', {});
  member.user = await member.call('/auth/join', {
    username: 'partner',
    name: '周 · 执行负责人',
    password,
    code: invite.code,
  });
  await outsider.call(
    '/auth/join',
    { username: 'outsider', name: '第三人', password, code: invite.code },
    403,
  );
  const secondInvite = await owner.call<{ code: string }>('/invitations', {});
  outsider.user = await outsider.call('/auth/join', {
    username: 'outsider',
    name: '非参与成员',
    password,
    code: secondInvite.code,
  });
  assert.notEqual(owner.cookie, member.cookie);
  pass('Two independent accounts, separate sessions, single-use invitation enforced');
  const project = await owner.call<{ id: string }>(
    '/projects',
    { name: 'Slugify · 真实协作验证', directory: repo, trusted: true },
    201,
  );
  await member.call('/projects', { name: 'Unauthorized', directory: repo, trusted: true }, 403);
  const created = await owner.call<Task>(
    '/tasks',
    taskBody(
      project.id,
      '修复 slugify 并通过回归测试',
      'Fix slugify.mjs to pass the existing tests. Files are already known: slugify.mjs and slugify.test.mjs. Use read to inspect them; do not list directories. Modify ONLY slugify.mjs using edit. Run exactly node --test slugify.test.mjs. Do not edit tests. Do not use subagents.',
    ),
    201,
  );
  proof.taskID = created.id;
  await outsider.call(`/tasks/${created.id}`, undefined, 403);
  assert.equal((await outsider.call<Bootstrap>('/bootstrap')).tasks.length, 0);
  await owner.call(`/tasks/${created.id}/claim`, {}, 403);
  await member.call(`/tasks/${created.id}/claim`, {});
  await member.call(`/tasks/${created.id}/claim`, {}, 409);
  await owner.call(`/tasks/${created.id}/run`, { confirmed: true }, 403);
  pass('Task membership and assignee authorization enforced on server');
  const stream = await fetch(`${base}/api/events`, {
    headers: { Cookie: member.cookie },
    signal: feedAbort.signal,
  });
  let streamText = '';
  const readStream = (async () => {
    for await (const chunk of stream.body!)
      streamText = (streamText + Buffer.from(chunk).toString()).slice(-100000);
  })().catch(() => {});
  await member.call(`/tasks/${created.id}/run`, { confirmed: true });
  const concurrent = await owner.call<Task>(
    '/tasks',
    taskBody(project.id, '阻止同项目并发', 'Do nothing.'),
    201,
  );
  await member.call(`/tasks/${concurrent.id}/claim`, {});
  await member.call(`/tasks/${concurrent.id}/run`, { confirmed: true }, 409);
  pass('Same-project concurrent execution blocked');
  const handled = new Set<string>();
  const verifiedActions = new Set<string>();
  let finished: Task | undefined;
  for (let i = 0; i < 240; i++) {
    await sleep(1000);
    const t = await get(created.id);
    if (t.state === 'failed' || t.state === 'interrupted')
      throw new Error(`Real engine task failed: ${t.error}`);
    for (const p of t.approvals) {
      if (handled.has(p.id)) continue;
      const safe =
        (p.permission === 'edit' && p.patterns.every((f) => /(^|[\\/])slugify\.mjs$/.test(f))) ||
        (p.permission === 'bash' &&
          p.patterns.every((c) =>
            ['node --test slugify.test.mjs', 'ls -la', 'Get-ChildItem'].includes(c),
          ));
      assert(safe, `Unexpected approval: ${JSON.stringify(p)}`);
      await member.call(`/tasks/${t.id}/permissions/${p.id}`, { reply: 'once' }, 403);
      await owner.call(`/tasks/${t.id}/permissions/${p.id}`, { reply: 'once' });
      await owner.call(`/tasks/${t.id}/permissions/${p.id}`, { reply: 'once' }, 409);
      handled.add(p.id);
      if (p.permission === 'edit') verifiedActions.add('edit');
      if (p.patterns.includes('node --test slugify.test.mjs')) verifiedActions.add('test-command');
      console.log('APPROVAL', p.permission, p.patterns.join(', '));
    }
    if (t.state === 'review') {
      finished = t;
      break;
    }
  }
  assert(finished, 'Task never reached review');
  assert(handled.size >= 2);
  assert(verifiedActions.has('edit') && verifiedActions.has('test-command'));
  assert(streamText.includes('event: delta'));
  assert(finished.artifacts.some((f) => f.file === 'slugify.mjs' && f.patch.includes('+')));
  execFileSync(process.execPath, ['--test', 'slugify.test.mjs'], { cwd: repo });
  pass(
    'Real model execution, streaming, edit + command approval, test success and Git artifact capture',
  );
  await member.call(
    `/tasks/${created.id}/accept`,
    { confirmed: true, version: finished.version, note: 'unauthorized' },
    403,
  );
  const original = readFileSync(join(repo, 'slugify.mjs'), 'utf8');
  writeFileSync(join(repo, 'slugify.mjs'), original + '\n// external edit\n');
  await owner.call(
    `/tasks/${created.id}/accept`,
    { confirmed: true, version: finished.version, note: 'external change' },
    409,
  );
  writeFileSync(join(repo, 'slugify.mjs'), original);
  await owner.call(`/tasks/${created.id}/accept`, {
    confirmed: true,
    version: finished.version,
    note: '已核对真实测试输出、Git diff 和验收标准。',
  });
  pass('Only reviewer can accept; changed artifacts rejected before acceptance');
  feedAbort.abort();
  await readStream;
  await stop();
  await start();
  const restored = await get(created.id);
  assert.equal(restored.state, 'accepted');
  assert(restored.artifacts.length);
  assert(restored.messages.length);
  pass('Restart preserves authenticated accounts, task state, outputs, artifacts and audit');
  // The accepted work is committed by the test operator, never by the model.
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Rivloom Test',
      '-c',
      'user.email=test@localhost',
      'commit',
      '-qm',
      'Reviewed fixture result',
    ],
    { cwd: repo },
  );
  const stopped = await owner.call<Task>(
    '/tasks',
    taskBody(
      project.id,
      '验证停止与补充要求',
      'Use edit to add one comment to slugify.mjs. Do not run shell commands.',
    ),
    201,
  );
  await member.call(`/tasks/${stopped.id}/claim`, {});
  await member.call(`/tasks/${stopped.id}/run`, { confirmed: true });
  let pending = false;
  for (let i = 0; i < 100; i++) {
    await sleep(1000);
    const t = await get(stopped.id);
    if (t.approvals.length) {
      pending = true;
      break;
    }
    if (t.state === 'failed') throw new Error(t.error || 'failed');
  }
  assert(pending, 'Stop test did not reach approval');
  const before = readFileSync(join(repo, 'slugify.mjs'), 'utf8');
  await owner.call(`/tasks/${stopped.id}/requirements`, { text: '暂时不要修改，等待下一轮确认。' });
  const after = await get(stopped.id);
  assert.equal(after.state, 'stopped');
  assert.equal(after.approvals.length, 0);
  assert(after.description.includes('暂时不要修改'));
  assert.equal(readFileSync(join(repo, 'slugify.mjs'), 'utf8'), before);
  pass(
    'Human supplementary requirement stops real engine, rejects stale permission and leaves file unchanged',
  );
  await member.call(`/tasks/${stopped.id}/run`, {
    confirmed: true,
    addition:
      'New explicit instruction: use the edit tool to add one comment to slugify.mjs. Do not run commands. Wait for approval.',
  });
  let crashPending = false;
  for (let i = 0; i < 100; i++) {
    await sleep(1000);
    if ((await get(stopped.id)).approvals.length) {
      crashPending = true;
      break;
    }
  }
  assert(crashPending, 'Crash recovery test did not reach an active permission request');
  await stop();
  await start();
  const interrupted = await get(stopped.id);
  assert.equal(interrupted.state, 'interrupted');
  assert.equal(interrupted.approvals.length, 0);
  assert.equal(readFileSync(join(repo, 'slugify.mjs'), 'utf8'), before);
  await owner.call(`/tasks/${stopped.id}/stop`, {});
  assert.equal((await get(stopped.id)).state, 'stopped');
  pass(
    'Abrupt app exit during approval recovers as interrupted, never resumes or writes automatically',
  );
  proof.streaming = true;
  proof.approvals = handled.size;
  proof.artifactCount = finished.artifacts.length;
  proof.engineSession = finished.sessionID;
  proof.status = 'passed';
} catch (e) {
  proof.status = 'failed';
  proof.error = (e as Error).message;
  process.exitCode = 1;
  console.error(e);
} finally {
  feedAbort.abort();
  if (processHandle!) await stop();
  mkdirSync(resolve('.data', 'verification'), { recursive: true });
  writeFileSync(
    resolve(
      '.data',
      'verification',
      desktopExecutable ? 'desktop-integration.json' : 'integration.json',
    ),
    JSON.stringify(proof, null, 2),
  );
  console.log(
    'REPORT',
    resolve(
      '.data',
      'verification',
      desktopExecutable ? 'desktop-integration.json' : 'integration.json',
    ),
  );
}
