import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  environmentRecord,
  isolatedWorkspace,
  saveReport,
  testEnvironment,
} from './ci-workspace.ts';

export const serviceChecks = {
  knowledge: 'scripts/knowledge-service-check.ts',
  'conversation-history': 'scripts/conversation-history-check.ts',
  'desktop-update': 'scripts/desktop-update-service-check.ts',
  'origin-concurrency': 'scripts/origin-concurrency-check.ts',
  workflow: 'scripts/workflow-service-check.ts',
  'workflow-diagnostics': 'scripts/workflow-diagnostics-check.ts',
  'model-settings': 'scripts/model-settings-check.ts',
  'provider-accounts': 'scripts/provider-accounts-check.ts',
  permissions: 'scripts/permission-policy-check.ts',
  'node-p0': 'scripts/node-p0-check.ts',
  'collaboration-files': 'scripts/collaboration-files-check.ts',
  'session-crash': 'scripts/node-queue-crash-check.ts',
} as const;

export function auditServiceMatrix(workflow: string) {
  // Keep this small literal matrix auditable without adding a YAML runtime dependency.
  // A different declaration style must be reviewed explicitly, never silently skipped.
  const declarations = [...workflow.matchAll(/^\s*check:\s*\[([^\]\r\n]*)\]\s*$/gm)];
  assert.equal(declarations.length, 1, 'Service workflow needs one explicit check matrix');
  const checks = declarations[0]![1]!.split(',').map((name) => name.trim());
  assert.equal(new Set(checks).size, checks.length, 'Duplicate service workflow check');
  assert.deepEqual(
    [...checks].sort(),
    Object.keys(serviceChecks).sort(),
    'Service workflow matrix must cover every registered check',
  );
  return checks;
}

export async function runServiceScript(script: string, directory: string, timeoutMs = 12 * 60_000) {
  const startedAt = Date.now();
  const child = spawn(process.execPath, [script], {
    cwd: directory,
    env: testEnvironment(directory),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let timedOut = false;
  let termination: 'not-needed' | 'owned-tree' | 'child-only' = 'not-needed';
  let passLines = 0;
  let tail = '';
  const timer = setTimeout(() => {
    timedOut = true;
    if (!child.pid || child.exitCode !== null) return;
    try {
      // Only this exact child tree is owned by the CI wrapper. Never kill by image name.
      if (process.platform === 'win32')
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
          timeout: 5000,
        });
      else child.kill('SIGKILL');
      termination = process.platform === 'win32' ? 'owned-tree' : 'child-only';
    } catch {
      // Restricted local runners can deny taskkill. Stop our child handle, unblock
      // inherited output pipes, and keep the failed result/partial cleanup explicit.
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
      termination = 'child-only';
    }
  }, timeoutMs);
  child.stdout.on('data', (bytes) => {
    process.stdout.write(bytes);
    const lines = (tail + bytes.toString()).split(/\r?\n/);
    tail = lines.pop() || '';
    passLines += lines.filter((line) => line.startsWith('PASS ')).length;
  });
  child.stderr.on('data', (bytes) => process.stderr.write(bytes));
  try {
    const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (ok, fail) => {
        child.once('error', fail);
        child.once('close', (exitCode, signal) => ok({ exitCode, signal }));
      },
    );
    return {
      status: !timedOut && result.exitCode === 0 ? 'passed' : 'failed',
      ...result,
      timedOut,
      termination,
      reportedPassLines: passLines,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  assert.equal(process.platform, 'win32', 'Official engine checks require Windows');
  assert.equal(process.arch, 'x64', 'Official engine checks require x64');
  const check = process.argv[2] as keyof typeof serviceChecks;
  assert(
    Object.hasOwn(serviceChecks, check),
    `Choose a service check: ${Object.keys(serviceChecks).join(', ')}`,
  );
  const directory = await isolatedWorkspace(`service-${check}`);
  const result = await runServiceScript(resolve(directory, serviceChecks[check]), directory);
  await saveReport(`service-${check}`, {
    check,
    script: serviceChecks[check],
    environment: environmentRecord(),
    scope: 'official OpenCode; isolated application data; no paid model credentials supplied',
    ...result,
  });
  console.log(`${check}: ${result.status}; exit=${result.exitCode}, timeout=${result.timedOut}`);
  process.exitCode = result.status === 'passed' ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(async (error) => {
    console.error(error);
    process.exitCode = 1;
    // Startup failures are never reported as a skipped or passing service check.
    await saveReport('service-startup-error', {
      status: 'failed',
      environment: environmentRecord(),
    });
  });
}
