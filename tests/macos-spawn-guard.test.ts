import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { guardSpawnPlan, signalRivloomGuard, spawnWithRivloomGuard } from '../scripts/runtime-macos/spawn-guard.ts';

const hostEnv = { PATH: '/usr/bin:/bin', RIVLOOM_MACOS_PROCESS_HELPER: '/opt/rivloom/process-helper', RIVLOOM_MACOS_PROCESS_SOCKET: '/tmp/rivloom-owner.sock' };
const options: SpawnOptions = { detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], cwd: '/work', env: { ONLY_COMMAND: 'preserved' } };

test('Mac adapter activates from host configuration and preserves every command descriptor index', () => {
  const command: SpawnOptions = { ...options, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'ignore', 'pipe'] };
  const plan = guardSpawnPlan('git', ['rev-parse', '--show-toplevel'], command, 'darwin', hostEnv)!;
  assert.equal(plan.controlFd, 6);
  assert.deepEqual(plan.args, ['guard', '--control-fd', '6', '--', 'git', 'rev-parse', '--show-toplevel']);
  assert.deepEqual(plan.options.stdio, [...command.stdio as string[], 'pipe']);
  assert.equal(plan.options.detached, false); assert.equal(plan.options.shell, false);
  assert.equal(plan.options.cwd, command.cwd);
  assert.deepEqual(plan.options.env, { ONLY_COMMAND: 'preserved', RIVLOOM_MACOS_PROCESS_HELPER: hostEnv.RIVLOOM_MACOS_PROCESS_HELPER, RIVLOOM_MACOS_PROCESS_SOCKET: hostEnv.RIVLOOM_MACOS_PROCESS_SOCKET });
  assert.deepEqual(command.env, { ONLY_COMMAND: 'preserved' });
});

test('Mac adapter preserves POSIX shell construction and rejects unsupported IPC', () => {
  for (const shell of [true, '/bin/zsh']) {
    const plan = guardSpawnPlan('printf', ["'%s'", '"a b"'], { ...options, shell }, 'darwin', hostEnv)!;
    assert.deepEqual(plan.args.slice(4), [shell === true ? '/bin/sh' : shell, '-c', 'printf \'%s\' "a b"']);
    assert.equal(plan.options.shell, false);
  }
  assert.throws(() => guardSpawnPlan('node', [], { ...options, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] }, 'darwin', hostEnv), /IPC/);
  assert.throws(() => guardSpawnPlan('node', [], { ...options, stdio: 'pipe' }, 'darwin', hostEnv), /explicit/);
});

test('Only the absence of both Mac host variables permits standalone fallback', () => {
  assert.equal(guardSpawnPlan('git', [], options, 'darwin', {}), undefined);
  for (const env of [
    { RIVLOOM_MACOS_PROCESS_HELPER: hostEnv.RIVLOOM_MACOS_PROCESS_HELPER },
    { RIVLOOM_MACOS_PROCESS_SOCKET: hostEnv.RIVLOOM_MACOS_PROCESS_SOCKET },
    { ...hostEnv, RIVLOOM_MACOS_PROCESS_SOCKET: '' },
    { ...hostEnv, RIVLOOM_MACOS_PROCESS_HELPER: 'relative-helper' },
  ]) assert.throws(() => guardSpawnPlan('git', [], options, 'darwin', env), /configuration/);
  for (const platform of ['linux', 'win32']) assert.equal(guardSpawnPlan('git', [], options, platform, hostEnv), undefined);
});

test('Guard cancellation uses its private pipe and never cached PID or group after closure', async () => {
  const control = new PassThrough(); let output = '', kills = 0;
  control.on('data', bytes => { output += bytes.toString(); });
  const child = { stdio: [null, null, null, control], exitCode: null, signalCode: null, kill: () => { kills++; throw Error('numeric PID fallback'); } } as unknown as ChildProcess;
  const launch = (file: string, args: readonly string[], opts: SpawnOptions) => {
    assert.equal(file, hostEnv.RIVLOOM_MACOS_PROCESS_HELPER);
    assert.equal(args[2], '3'); assert.equal(opts.detached, false);
    return child;
  };
  assert.equal(spawnWithRivloomGuard('git', [], options, launch, { platform: 'darwin', env: hostEnv }), child);
  assert.equal(signalRivloomGuard(child, 'SIGTERM'), true);
  assert.equal(signalRivloomGuard(child, 'SIGKILL'), true);
  assert.equal(output, 'TK');
  assert.throws(() => signalRivloomGuard(child, 'SIGHUP'), /Unsupported/);
  control.destroy(new Error('broken private control pipe'));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(signalRivloomGuard(child, 'SIGTERM'), true);
  assert.equal(signalRivloomGuard(child, 'SIGKILL'), true);
  Object.assign(child, { exitCode: 37 });
  assert.equal(signalRivloomGuard(child, 'SIGTERM'), true);
  assert.equal(output, 'TK'); assert.equal(kills, 0);
  assert.equal(signalRivloomGuard({} as ChildProcess, 'SIGTERM'), false);
});

test('Standalone launch retains the original executable arguments and options by identity', () => {
  const args = ['--version'], child = {} as ChildProcess;
  for (const context of [{ platform: 'darwin', env: {} }, { platform: 'win32', env: hostEnv }, { platform: 'linux', env: hostEnv }]) {
    const result = spawnWithRivloomGuard('git', args, options, (file, actualArgs, actualOptions) => {
      assert.equal(file, 'git'); assert.equal(actualArgs, args); assert.equal(actualOptions, options); return child;
    }, context);
    assert.equal(result, child);
  }
});
