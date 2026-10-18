import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidateWorkflows, type CandidateWorkflowRun } from './ci-candidate-gate.ts';
import { runCandidateReadiness } from './ci-candidate-readiness.ts';

const repository = 'rivloom/rivloom-desktop';
const commit = '1'.repeat(40);
const token = 'PRIVATE_TOKEN_MUST_NOT_APPEAR';
const title = 'Windows build and release / ' + commit;
const candidateJob = 'Build and verify Rivloom candidate';
type Workflow = (typeof candidateWorkflows)[number];
type HistoryRun = CandidateWorkflowRun & { display_title: string };

function run(workflow: string, changes: Partial<CandidateWorkflowRun> = {}): CandidateWorkflowRun {
  const id = changes.id || 100 + candidateWorkflows.indexOf(workflow as Workflow);
  return {
    id,
    run_attempt: 1,
    head_sha: commit,
    head_branch: 'main',
    event: 'push',
    path: '.github/workflows/' + workflow,
    status: 'completed',
    conclusion: 'success',
    html_url: `https://github.com/${repository}/actions/runs/${id}`,
    head_repository: { full_name: repository },
    ...changes,
  };
}

function historyRun(changes: Partial<HistoryRun> = {}): HistoryRun {
  return {
    ...run('windows-candidate.yml', { id: 800, event: 'workflow_run', ...changes }),
    display_title: title,
    ...changes,
  };
}

function job(runId: number, changes: Record<string, unknown> = {}) {
  return {
    id: 1000,
    run_id: runId,
    run_attempt: 1,
    name: candidateJob,
    status: 'completed',
    conclusion: 'success',
    ...changes,
  };
}

function event(trigger = run('ci.yml')) {
  return { action: 'completed', repository: { full_name: repository }, workflow_run: trigger };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

interface FixtureOptions {
  ci?: Partial<
    Record<Workflow, CandidateWorkflowRun[] | ((observation: number) => CandidateWorkflowRun[])>
  >;
  history?: HistoryRun[];
  jobs?: Record<number, Record<string, unknown>[]>;
  event?: unknown;
  eventText?: string;
  environment?: NodeJS.ProcessEnv;
  intercept?: (url: URL) => Response | undefined;
}

async function fixture(options: FixtureOptions = {}) {
  const calls: URL[] = [];
  const waits: number[] = [];
  const files: Record<string, string> = {};
  const observations = new Map<string, number>();
  let saved: object | undefined;
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url);
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer ' + token);
    assert(init?.signal instanceof AbortSignal);
    const intercepted = options.intercept?.(url);
    if (intercepted) return intercepted;
    let items: unknown[];
    let key: 'workflow_runs' | 'jobs';
    if (url.pathname.endsWith('/workflows/windows-candidate.yml/runs')) {
      assert.deepEqual([...url.searchParams.keys()].sort(), ['page', 'per_page']);
      items = options.history || [];
      key = 'workflow_runs';
    } else if (url.pathname.endsWith('/jobs')) {
      assert.equal(url.searchParams.get('filter'), 'all');
      const id = Number(url.pathname.split('/').at(-2));
      items = options.jobs?.[id] || [];
      key = 'jobs';
    } else {
      const workflow = url.pathname.split('/').at(-2) as Workflow;
      assert(candidateWorkflows.includes(workflow));
      assert.equal(url.searchParams.get('head_sha'), commit);
      assert.equal(url.searchParams.get('branch'), 'main');
      assert.equal(url.searchParams.get('event'), 'push');
      const observation = observations.get(workflow) || 0;
      if (url.searchParams.get('page') === '1') observations.set(workflow, observation + 1);
      const configured = options.ci?.[workflow];
      items =
        typeof configured === 'function' ? configured(observation) : configured || [run(workflow)];
      key = 'workflow_runs';
    }
    assert.equal(url.searchParams.get('per_page'), '100');
    const page = Number(url.searchParams.get('page'));
    return json({ total_count: items.length, [key]: items.slice((page - 1) * 100, page * 100) });
  };
  const result = await runCandidateReadiness(
    {
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: repository,
      RIVLOOM_CANDIDATE_SHA: commit,
      GITHUB_RUN_ID: '900',
      GITHUB_EVENT_NAME: 'workflow_run',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_EVENT_PATH: '/event.json',
      GITHUB_OUTPUT: '/output',
      GITHUB_STEP_SUMMARY: '/summary',
      GITHUB_TOKEN: token,
      ...options.environment,
    },
    {
      request,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    },
    {
      readText: async (path) => {
        assert.equal(path, '/event.json');
        return options.eventText ?? JSON.stringify(options.event ?? event());
      },
      saveReport: async (report) => {
        saved = report;
      },
      appendText: async (path, text) => {
        files[path] = (files[path] || '') + text;
      },
    },
  );
  assert.deepEqual(saved, result.report);
  assert.equal(files['/output'], 'ready=' + result.report.ready + '\n');
  assert(files['/summary'].length < 1500);
  assert(!JSON.stringify({ saved, files }).includes(token));
  return { ...result, calls, waits, files };
}

test('early completion skips successfully instead of waiting 22 minutes and sending a failure', async () => {
  const result = await fixture({
    ci: {
      'windows-services.yml': [
        run('windows-services.yml', { status: 'in_progress', conclusion: null }),
      ],
      'lan-regression.yml': [],
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.status, 'skipped');
  assert.equal(result.report.reason, 'ci-not-ready');
  assert.deepEqual(
    result.report.checks.map((check) => check.status),
    ['passed', 'waiting', 'missing'],
  );
  assert.deepEqual(result.waits, [2000, 2000]);
  assert.equal(result.calls.length, 9);
});

test('the last completing workflow makes the same source ready, with bounded API visibility retries', async () => {
  const result = await fixture({
    event: event(run('lan-regression.yml')),
    ci: {
      'lan-regression.yml': (observation) =>
        observation < 2
          ? [run('lan-regression.yml', { status: 'in_progress', conclusion: null })]
          : [run('lan-regression.yml')],
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.ready, true);
  assert.equal(result.report.reason, 'checks-passed');
  assert.deepEqual(result.waits, [2000, 2000]);
  assert(result.report.checks.every((check) => check.status === 'passed'));
});

test('terminal CI failures skip without polling and a successful retry can start the candidate', async () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped']) {
    const result = await fixture({
      ci: { 'windows-services.yml': [run('windows-services.yml', { conclusion })] },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.report.ready, false);
    assert.equal(result.report.reason, 'ci-not-ready');
    assert.deepEqual(result.waits, []);
  }
  const retried = run('windows-services.yml', { run_attempt: 2 });
  const result = await fixture({
    event: event(retried),
    ci: { 'windows-services.yml': [retried] },
  });
  assert.equal(result.report.ready, true);
});

test('a delayed event replacing the pending newer event still builds when latest same-source checks passed', async () => {
  for (const newer of [run('ci.yml', { id: 200 }), run('ci.yml', { run_attempt: 2 })]) {
    const result = await fixture({ ci: { 'ci.yml': [newer] } });
    assert.equal(result.exitCode, 0);
    assert.equal(result.report.reason, 'checks-passed');
    assert.equal(result.report.ready, true);
    assert.deepEqual(result.waits, []);
    const alreadyBuilt = await fixture({
      ci: { 'ci.yml': [newer] },
      history: [historyRun()],
      jobs: { 800: [job(800)] },
    });
    assert.equal(alreadyBuilt.report.reason, 'already-built');
    assert.equal(alreadyBuilt.report.ready, false);
  }
});

test('old success events cannot override newer failed or active checks, and unseen newer events wait briefly', async () => {
  for (const newer of [
    run('ci.yml', { id: 200, conclusion: 'failure' }),
    run('ci.yml', { run_attempt: 2, conclusion: 'failure' }),
    run('ci.yml', { run_attempt: 2, status: 'in_progress', conclusion: null }),
  ]) {
    const result = await fixture({ ci: { 'ci.yml': [newer] } });
    assert.equal(result.exitCode, 0);
    assert.equal(result.report.reason, 'ci-not-ready');
    assert.equal(result.report.ready, false);
    assert.deepEqual(result.waits, newer.status === 'in_progress' ? [2000, 2000] : []);
  }
  const invisible = await fixture({ event: event(run('ci.yml', { id: 200 })) });
  assert.equal(invisible.report.ready, false);
  assert.deepEqual(invisible.waits, [2000, 2000]);
});

test('a successful retry event waits briefly when the API still shows its failed previous attempt', async () => {
  const result = await fixture({
    event: event(run('windows-services.yml', { run_attempt: 2 })),
    ci: {
      'windows-services.yml': (observation) => [
        run(
          'windows-services.yml',
          observation === 0 ? { run_attempt: 1, conclusion: 'failure' } : { run_attempt: 2 },
        ),
      ],
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.ready, true);
  assert.deepEqual(result.waits, [2000]);
});

test('forks, other SHAs, branches, paths and non-success push events never reach the API', async () => {
  for (const changes of [
    { head_repository: { full_name: 'someone/fork' } },
    { head_sha: '2'.repeat(40) },
    { head_branch: 'feature' },
    { event: 'pull_request' },
    { conclusion: 'failure' },
    { status: 'in_progress' },
    { path: '.github/workflows/unrelated.yml' },
    { path: '.github/workflows/ci.yml@feature' },
  ]) {
    const result = await fixture({ event: event(run('ci.yml', changes)) });
    assert.equal(result.report.reason, 'untrusted-trigger');
    assert.equal(result.report.ready, false);
    assert.equal(result.calls.length, 0);
  }
  const result = await fixture({
    event: { ...event(), repository: { full_name: 'someone/fork' } },
  });
  assert.equal(result.report.ready, false);
});

test('manual main and CI tag runs continue to the existing strict gate without automatic deduplication', async () => {
  for (const environment of [
    { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main' },
    { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/ci-v0.1.31' },
  ]) {
    const result = await fixture({ environment, event: {} });
    assert.equal(result.exitCode, 0);
    assert.equal(result.report.reason, 'explicit-trigger');
    assert.equal(result.report.ready, true);
    assert.equal(result.calls.length, 0);
  }
  const result = await fixture({
    environment: { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/feature' },
  });
  assert.equal(result.report.ready, false);
});

test('deduplication binds the explicit title, not head_sha or the overall publication result', async () => {
  for (const id of [800, 1001]) {
    // A newer run may acquire the non-FIFO concurrency lock before this run.
    const previous = historyRun({ id, head_sha: '2'.repeat(40), conclusion: 'failure' });
    const result = await fixture({ history: [previous], jobs: { [id]: [job(id)] } });
    assert.equal(result.report.reason, 'already-built');
    assert.equal(result.report.ready, false);
    assert.deepEqual(result.report.previousBuild, { runId: id, attempt: 1, jobId: 1000 });
  }
});

test('a successful preflight or unsuccessful candidate does not count as an existing build', async () => {
  for (const changes of [
    { name: 'Check whether the exact source is ready to build' },
    { conclusion: 'failure' },
    { conclusion: 'cancelled' },
    { conclusion: 'skipped' },
    { status: 'in_progress', conclusion: null },
  ]) {
    const result = await fixture({ history: [historyRun()], jobs: { 800: [job(800, changes)] } });
    assert.equal(result.report.ready, true);
  }
});

test('history excludes the current run, old unnamed runs and unrelated or untrusted runs', async () => {
  const result = await fixture({
    history: [
      historyRun({ id: 900 }),
      historyRun({ id: 801, display_title: 'old commit message' }),
      historyRun({ id: 802, display_title: 'Windows build and release / ' + '2'.repeat(40) }),
      historyRun({ id: 803, event: 'workflow_dispatch' }),
      historyRun({ id: 804, head_repository: { full_name: 'someone/fork' } }),
      historyRun({ id: 805, head_branch: 'feature' }),
      historyRun({ id: 806, path: '.github/workflows/unrelated.yml' }),
      { ...historyRun({ id: 807 }), head_branch: null } as unknown as HistoryRun,
    ],
  });
  assert.equal(result.report.ready, true);
  assert.equal(result.calls.filter((url) => url.pathname.endsWith('/jobs')).length, 0);
});

test('all attempts are inspected so successful candidate evidence survives a publication retry', async () => {
  const result = await fixture({
    history: [historyRun({ run_attempt: 2, conclusion: 'failure' })],
    jobs: {
      800: [
        job(800, { run_attempt: 1 }),
        job(800, { id: 1001, run_attempt: 2, conclusion: 'skipped' }),
      ],
    },
  });
  assert.equal(result.report.reason, 'already-built');
  assert.equal(result.report.previousBuild?.attempt, 1);
});

test('CI runs, candidate history and all-attempt jobs paginate through later evidence', async () => {
  const latest = run('ci.yml', { id: 501 });
  const result = await fixture({
    event: event(latest),
    ci: {
      'ci.yml': [
        ...Array.from({ length: 100 }, (_, index) =>
          run('ci.yml', { id: index + 1, conclusion: 'failure' }),
        ),
        latest,
      ],
    },
    history: [
      ...Array.from({ length: 100 }, (_, index) =>
        historyRun({ id: index + 1, display_title: 'older source' }),
      ),
      historyRun(),
    ],
    jobs: {
      800: [
        ...Array.from({ length: 100 }, (_, index) =>
          job(800, { id: index + 1, name: 'Other job' }),
        ),
        job(800),
      ],
    },
  });
  assert.equal(result.report.reason, 'already-built');
  assert.equal(result.calls.filter((url) => url.searchParams.get('page') === '2').length, 3);
});

test('API rejection, network errors and malformed responses fail closed without disclosing response bodies', async () => {
  for (const path of ['ci.yml/runs', 'windows-candidate.yml/runs', '800/jobs']) {
    for (const intercepted of [
      () => json({ message: token }, 403),
      () => json({ total_count: 0, workflow_runs: null, jobs: null }),
      () => new Response(token, { status: 200 }),
      () => {
        throw new Error(token);
      },
    ]) {
      const result = await fixture({
        history: [historyRun()],
        intercept: (url) => (url.pathname.endsWith(path) ? intercepted() : undefined),
      });
      assert.equal(result.exitCode, 1);
      assert.equal(result.report.status, 'error');
      assert.equal(result.report.ready, false);
      assert.deepEqual(result.waits, []);
    }
  }
});

test('invalid run/job shapes and incomplete or repeated pagination cannot become ready', async () => {
  const malformedRun = { ...run('ci.yml'), run_attempt: 0 };
  const malformedJob = job(800, { run_id: 999 });
  for (const intercept of [
    (url: URL) =>
      url.pathname.endsWith('ci.yml/runs')
        ? json({ total_count: 1, workflow_runs: [malformedRun] })
        : undefined,
    (url: URL) =>
      url.pathname.endsWith('800/jobs')
        ? json({ total_count: 1, jobs: [malformedJob] })
        : undefined,
    (url: URL) =>
      url.pathname.endsWith('windows-candidate.yml/runs')
        ? json({
            total_count: 2,
            workflow_runs:
              url.searchParams.get('page') === '1' ? [historyRun({ display_title: 'other' })] : [],
          })
        : undefined,
    (url: URL) =>
      url.pathname.endsWith('windows-candidate.yml/runs')
        ? json({ total_count: 2, workflow_runs: [historyRun({ display_title: 'other' })] })
        : undefined,
    (url: URL) =>
      url.pathname.endsWith('windows-candidate.yml/runs')
        ? json({ total_count: 0, workflow_runs: [historyRun()] })
        : undefined,
  ]) {
    const result = await fixture({ history: [historyRun()], intercept });
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.ready, false);
  }
});

test('malformed event files and invalid runner contexts produce a bounded error report', async () => {
  for (const options of [
    { eventText: '{' },
    { event: {} },
    { event: event(run('ci.yml', { run_attempt: 0 })) },
    { environment: { GITHUB_API_URL: 'https://example.com' } },
    { environment: { GITHUB_RUN_ID: '0' } },
    { environment: { RIVLOOM_CANDIDATE_SHA: 'bad-sha' } },
    { environment: { GITHUB_TOKEN: '' } },
  ]) {
    const result = await fixture(options);
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.ready, false);
    assert.equal(result.calls.length, 0);
  }
});
