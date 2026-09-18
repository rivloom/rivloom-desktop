import assert from 'node:assert/strict';
import { networkCases, networkFile } from './ci-test-suites.ts';
import { runBatch } from './ci-tests.ts';
import { isolatedWorkspace, testEnvironment, saveReport, environmentRecord } from './ci-workspace.ts';

assert.equal(process.platform, 'linux', 'This is the native Linux protocol lane');
const selected = networkCases.protocol.filter(name => !name.includes('DPAPI'));
assert.equal(selected.length, networkCases.protocol.length - 1, 'Review the platform-specific exclusion when adding protocols');
const workspace = await isolatedWorkspace('linux-protocol');
const platform = environmentRecord();
const environment = testEnvironment(workspace);
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, environment);
const result = await runBatch([networkFile], workspace, selected);
await saveReport('linux-protocol', { environment: platform, ...result });
assert.equal(result.passed, true, 'Linux protocol checks must pass with the exact selected names and no skipped cases');
