import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ApprovalMode } from '../shared/types.ts';
import { checkApprovalExecution } from './approval-execution-check.ts';

const root = mkdtempSync(join(tmpdir(), 'rivloom-permission-policy-'));
process.env.RIVLOOM_DATA_DIR = root;
const { ENGINE_VERSION, sessionPermissions, startEngine } = await import('../server/engine.ts');
const engine = await startEngine(root);
const results: Array<{ mode: ApprovalMode; sessionID: string; rules: number }> = [];

try {
  for (const mode of ['ask', 'auto', 'full'] as const) {
    const directory = join(root, mode);
    mkdirSync(directory, { recursive: true });
    const permission = sessionPermissions(mode);
    const created = (
      await engine.client.session.create({
        directory,
        title: `Rivloom ${mode} permission check`,
        permission,
      })
    ).data!;
    const restored = (await engine.client.session.get({ directory, sessionID: created.id })).data!;
    assert.deepEqual(restored.permission, permission);
    results.push({ mode, sessionID: created.id, rules: permission.length });
  }

  const report = {
    date: new Date().toISOString(),
    kind: 'official-opencode-session-permission-policy',
    engineVersion: ENGINE_VERSION,
    modelRequestSent: false,
    credentialsIncluded: false,
    modes: results,
  };
  const reportDirectory = resolve('.data', 'verification');
  mkdirSync(reportDirectory, { recursive: true });
  writeFileSync(join(reportDirectory, 'permission-policy.json'), JSON.stringify(report, null, 2));
  console.log(
    `OpenCode ${ENGINE_VERSION} accepted and returned ${results.length} session permission policies. No model request was sent.`,
  );
} finally {
  const exited = new Promise<void>((resolveExit) => engine.child.once('exit', () => resolveExit()));
  engine.close();
  await Promise.race([exited, new Promise<void>((resolveWait) => setTimeout(resolveWait, 5000))]);
  rmSync(root, { recursive: true, force: true });
}

await checkApprovalExecution();
