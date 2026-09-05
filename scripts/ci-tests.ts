import assert from 'node:assert/strict';
import { run } from 'node:test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditCoverage,
  engineFiles,
  exactPattern,
  logicFiles,
  networkCases,
  networkFile,
  testLanes,
  type TestLane,
} from './ci-test-suites.ts';
import {
  ciRoot,
  environmentRecord,
  isolatedWorkspace,
  saveReport,
  testEnvironment,
} from './ci-workspace.ts';

export interface CaseResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped' | 'todo';
}

export async function runBatch(
  files: readonly string[],
  cwd: string,
  expectedNames?: readonly string[],
) {
  const results: CaseResult[] = [];
  const stream = run({
    files: files.map((file) => resolve(file)),
    cwd,
    concurrency: false,
    testNamePatterns: expectedNames ? [exactPattern(expectedNames)] : undefined,
  });
  let successfulSummary = false;
  for await (const event of stream) {
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      const data = event.data;
      if (data.details.type === 'suite') continue;
      const status = data.skip
        ? 'skipped'
        : data.todo
          ? 'todo'
          : event.type === 'test:pass'
            ? 'passed'
            : 'failed';
      results.push({ name: data.name, status });
      console.log(`${status.toUpperCase()} ${data.name}`);
      if (event.type === 'test:fail') console.error(data.details.error);
    } else if (event.type === 'test:summary' && !event.data.file) {
      successfulSummary = event.data.success;
    }
  }
  const actualNames = results.map((result) => result.name).sort();
  const exactSelection =
    !expectedNames || JSON.stringify(actualNames) === JSON.stringify([...expectedNames].sort());
  const passed =
    successfulSummary &&
    results.length > 0 &&
    exactSelection &&
    results.every((result) => result.status === 'passed');
  return { passed, exactSelection, results };
}

async function main() {
  const lane = process.argv[2];
  const coverage = auditCoverage(ciRoot);
  if (lane === '--list') {
    console.log(JSON.stringify(coverage, null, 2));
    await saveReport('coverage', {
      status: 'passed',
      environment: environmentRecord(),
      ...coverage,
    });
    return;
  }
  assert(testLanes.includes(lane as TestLane), `Choose a CI test lane: ${testLanes.join(', ')}`);
  assert.equal(
    process.platform,
    'win32',
    'Windows test lanes cannot be reported as passed on another OS',
  );
  assert.equal(process.arch, 'x64', 'Current desktop CI requires Windows x64');
  const environment = environmentRecord();
  const directory = await isolatedWorkspace(`tests-${lane}`);
  process.env = testEnvironment(directory);
  const batches = [];
  if (lane === 'logic')
    batches.push(
      await runBatch(
        logicFiles.map((file) => resolve(ciRoot, file)),
        directory,
      ),
    );
  if (lane === 'engine')
    batches.push(
      await runBatch(
        engineFiles.map((file) => resolve(ciRoot, file)),
        directory,
      ),
    );
  else
    batches.push(
      await runBatch(
        [resolve(ciRoot, networkFile)],
        directory,
        networkCases[lane as keyof typeof networkCases],
      ),
    );
  const results = batches.flatMap((batch) => batch.results);
  const passed = batches.every((batch) => batch.passed);
  const report = {
    lane,
    status: passed ? 'passed' : 'failed',
    environment,
    networkScope:
      lane === 'mdns' || lane === 'udp'
        ? 'same-host Windows transport; not physical-device acceptance'
        : null,
    selectedNetworkCases: lane === 'engine' ? [] : networkCases[lane as keyof typeof networkCases],
    counts: {
      total: results.length,
      passed: results.filter((result) => result.status === 'passed').length,
      failed: results.filter((result) => result.status === 'failed').length,
      skipped: results.filter((result) => result.status === 'skipped').length,
      todo: results.filter((result) => result.status === 'todo').length,
    },
    exactSelections: batches.every((batch) => batch.exactSelection),
    results,
  };
  await saveReport(`tests-${lane}`, report);
  console.log(
    `${lane}: ${report.counts.passed}/${report.counts.total}, ${report.counts.skipped} skipped; ${report.status}`,
  );
  process.exitCode = passed ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
