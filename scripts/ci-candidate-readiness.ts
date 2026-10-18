import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  candidateWorkflows,
  evaluateCandidateChecks,
  type CandidateWorkflowRun,
} from './ci-candidate-gate.ts';
import { ciRoot } from './ci-workspace.ts';

const apiRoot = 'https://api.github.com';
const candidateWorkflow = 'windows-candidate.yml';
const candidateJob = 'Build and verify Rivloom candidate';
const repositoryPattern = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/;
const commitPattern = /^(?!0{40}$)[0-9a-f]{40}$/;
type Checks = ReturnType<typeof evaluateCandidateChecks>['checks'];
type RecordValue = Record<string, unknown>;

class ReadinessError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function requireValue(condition: unknown, code: string): asserts condition {
  if (!condition) throw new ReadinessError(code);
}

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function workflowPath(path: string, workflow: string) {
  return (
    path === '.github/workflows/' + workflow || path === '.github/workflows/' + workflow + '@main'
  );
}

function parseRun(value: unknown, errorCode = 'invalid-api-response'): CandidateWorkflowRun {
  requireValue(record(value), errorCode);
  requireValue(
    positiveId(value.id) &&
      positiveId(value.run_attempt) &&
      typeof value.head_sha === 'string' &&
      commitPattern.test(value.head_sha) &&
      (value.head_branch === null || typeof value.head_branch === 'string') &&
      typeof value.event === 'string' &&
      typeof value.path === 'string' &&
      typeof value.status === 'string' &&
      value.status.length > 0 &&
      (value.conclusion === null || typeof value.conclusion === 'string') &&
      typeof value.html_url === 'string' &&
      (value.head_repository === null ||
        (record(value.head_repository) && typeof value.head_repository.full_name === 'string')),
    errorCode,
  );
  // GitHub permits null for deleted branches; they cannot qualify as main.
  return { ...value, head_branch: value.head_branch ?? '' } as unknown as CandidateWorkflowRun;
}

export interface ReadinessContext {
  repository: string;
  sourceCommit: string;
  eventName: string;
  ref: string;
  runId: number;
  event: unknown;
}

export interface ReadinessDependencies {
  request?: typeof fetch;
  wait?: (milliseconds: number) => Promise<unknown>;
  token: string;
}

export interface ReadinessDecision {
  ready: boolean;
  reason:
    'explicit-trigger' | 'untrusted-trigger' | 'ci-not-ready' | 'already-built' | 'checks-passed';
  checks: Checks;
  previousBuild?: { runId: number; attempt: number; jobId: number };
}

/** A short preflight, independent of the strict gate that still runs inside the build job. */
export async function determineCandidateReadiness(
  context: ReadinessContext,
  dependencies: ReadinessDependencies,
): Promise<ReadinessDecision> {
  const { repository, sourceCommit, eventName, ref, runId, event } = context;
  requireValue(
    repositoryPattern.test(repository) && commitPattern.test(sourceCommit) && positiveId(runId),
    'invalid-run-context',
  );
  if (eventName === 'workflow_dispatch' && ref === 'refs/heads/main') {
    return { ready: true, reason: 'explicit-trigger', checks: [] };
  }
  if (eventName === 'push' && ref.startsWith('refs/tags/ci-v')) {
    return { ready: true, reason: 'explicit-trigger', checks: [] };
  }
  if (eventName !== 'workflow_run')
    return { ready: false, reason: 'untrusted-trigger', checks: [] };

  requireValue(
    record(event) &&
      record(event.repository) &&
      typeof event.repository.full_name === 'string' &&
      typeof event.action === 'string',
    'invalid-event',
  );
  const trigger = parseRun(event.workflow_run, 'invalid-event');
  const triggerWorkflow = candidateWorkflows.find((workflow) =>
    workflowPath(trigger.path, workflow),
  );
  if (
    event.action !== 'completed' ||
    event.repository.full_name !== repository ||
    trigger.head_repository?.full_name !== repository ||
    trigger.head_sha !== sourceCommit ||
    trigger.head_branch !== 'main' ||
    trigger.event !== 'push' ||
    trigger.status !== 'completed' ||
    trigger.conclusion !== 'success' ||
    !triggerWorkflow
  ) {
    return { ready: false, reason: 'untrusted-trigger', checks: [] };
  }
  requireValue(
    trigger.html_url === `https://github.com/${repository}/actions/runs/${trigger.id}`,
    'invalid-event',
  );
  requireValue(dependencies.token.length > 0, 'missing-actions-token');
  const request = dependencies.request || fetch;
  const wait = dependencies.wait || delay;

  async function* pages(
    path: string,
    key: 'workflow_runs' | 'jobs',
    query: Record<string, string> = {},
  ) {
    let seen = 0;
    const seenIds = new Set<number>();
    for (let page = 1; ; page += 1) {
      const url = new URL(`${apiRoot}/repos/${repository}/actions/${path}`);
      url.search = new URLSearchParams({
        ...query,
        per_page: '100',
        page: String(page),
      }).toString();
      let response: Response;
      try {
        response = await request(url, {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: 'Bearer ' + dependencies.token,
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new ReadinessError('api-request-failed');
      }
      requireValue(response.ok, 'api-http-' + response.status);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ReadinessError('invalid-api-json');
      }
      requireValue(record(body), 'invalid-api-response');
      const entries = body[key];
      requireValue(
        Array.isArray(entries) &&
          entries.length <= 100 &&
          Number.isSafeInteger(body.total_count) &&
          Number(body.total_count) >= 0,
        'invalid-api-response',
      );
      seen += entries.length;
      // Never treat an incomplete response as proof that there is no previous build.
      requireValue(
        seen <= Number(body.total_count) &&
          (entries.length > 0 || seen === Number(body.total_count)),
        'incomplete-api-pagination',
      );
      for (const entry of entries) {
        requireValue(
          record(entry) && positiveId(entry.id) && !seenIds.has(entry.id),
          'invalid-api-pagination',
        );
        seenIds.add(entry.id);
      }
      yield entries as unknown[];
      if (seen >= Number(body.total_count)) return;
    }
  }

  let checks: Checks = [];
  for (let observation = 0; observation < 3; observation += 1) {
    const snapshots = await Promise.all(
      candidateWorkflows.map(async (workflow) => {
        const runs: CandidateWorkflowRun[] = [];
        for await (const entries of pages(`workflows/${workflow}/runs`, 'workflow_runs', {
          branch: 'main',
          event: 'push',
          head_sha: sourceCommit,
        }))
          runs.push(...entries.map((entry) => parseRun(entry)));
        return { workflow, runs };
      }),
    );
    const result = evaluateCandidateChecks(repository, sourceCommit, snapshots);
    checks = result.checks;
    const latestTrigger = checks.find((check) => check.workflow === triggerWorkflow)?.run;
    const triggerCaughtUp =
      latestTrigger &&
      (latestTrigger.id > trigger.id ||
        (latestTrigger.id === trigger.id && latestTrigger.attempt > trigger.run_attempt) ||
        (latestTrigger.id === trigger.id &&
          latestTrigger.attempt === trigger.run_attempt &&
          latestTrigger.status === 'completed' &&
          latestTrigger.conclusion === 'success'));
    // A successful retry event can arrive while the API still exposes its older
    // failed attempt. Wait briefly for this event before interpreting failures.
    if (triggerCaughtUp && result.status === 'failed')
      return { ready: false, reason: 'ci-not-ready', checks };
    // A delayed event can replace a newer pending run in GitHub concurrency.
    // Treat it as a wake-up: the latest same-source checks decide readiness.
    if (result.status === 'passed' && triggerCaughtUp) break;
    if (observation === 2) return { ready: false, reason: 'ci-not-ready', checks };
    // Completed events can precede API visibility. This is four seconds at most,
    // not the old 22-minute wait for unrelated CI to finish.
    await wait(2_000);
  }

  // workflow_run's head_sha can be the default branch's newer tip. The explicit
  // run-name is the source binding; do not filter this history by head_sha.
  const title = 'Windows build and release / ' + sourceCommit;
  for await (const entries of pages(`workflows/${candidateWorkflow}/runs`, 'workflow_runs')) {
    for (const entry of entries) {
      const run = parseRun(entry);
      requireValue(
        record(entry) && typeof entry.display_title === 'string',
        'invalid-api-response',
      );
      if (
        run.id === runId ||
        entry.display_title !== title ||
        run.event !== 'workflow_run' ||
        run.head_branch !== 'main' ||
        run.head_repository?.full_name !== repository ||
        !workflowPath(run.path, candidateWorkflow)
      )
        continue;
      requireValue(
        run.html_url === `https://github.com/${repository}/actions/runs/${run.id}`,
        'invalid-api-response',
      );
      for await (const jobs of pages(`runs/${run.id}/jobs`, 'jobs', { filter: 'all' })) {
        for (const job of jobs) {
          requireValue(
            record(job) &&
              positiveId(job.id) &&
              job.run_id === run.id &&
              positiveId(job.run_attempt) &&
              job.run_attempt <= run.run_attempt &&
              typeof job.name === 'string' &&
              typeof job.status === 'string' &&
              (job.conclusion === null || typeof job.conclusion === 'string'),
            'invalid-api-response',
          );
          if (
            job.name === candidateJob &&
            job.status === 'completed' &&
            job.conclusion === 'success'
          ) {
            // Concurrency has no FIFO guarantee: a higher run ID may finish first.
            return {
              ready: false,
              reason: 'already-built',
              checks,
              previousBuild: { runId: run.id, attempt: job.run_attempt, jobId: job.id },
            };
          }
        }
      }
    }
  }
  return { ready: true, reason: 'checks-passed', checks };
}

interface ReadinessIO {
  readText: (path: string) => Promise<string>;
  saveReport: (report: object) => Promise<void>;
  appendText: (path: string, text: string) => Promise<unknown>;
}

const fileIO: ReadinessIO = {
  readText: (path) => readFile(path, 'utf8'),
  saveReport: async (report) => {
    const directory = join(ciRoot, 'test-results', 'candidate-readiness');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'readiness.json'), JSON.stringify(report, null, 2) + '\n');
  },
  appendText: (path, text) => appendFile(path, text),
};

export async function runCandidateReadiness(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: Omit<ReadinessDependencies, 'token'> = {},
  io: ReadinessIO = fileIO,
) {
  const repository = environment.GITHUB_REPOSITORY || '';
  const sourceCommit = environment.RIVLOOM_CANDIDATE_SHA || '';
  let decision: Omit<ReadinessDecision, 'reason'> & { reason: string } = {
    ready: false,
    reason: 'readiness-error',
    checks: [],
  };
  let exitCode = 0;
  try {
    requireValue(
      environment.GITHUB_ACTIONS === 'true' &&
        (environment.GITHUB_API_URL || apiRoot) === apiRoot &&
        environment.GITHUB_EVENT_PATH &&
        environment.GITHUB_OUTPUT &&
        environment.GITHUB_STEP_SUMMARY,
      'invalid-run-context',
    );
    const event = JSON.parse(await io.readText(environment.GITHUB_EVENT_PATH));
    decision = await determineCandidateReadiness(
      {
        repository,
        sourceCommit,
        event,
        eventName: environment.GITHUB_EVENT_NAME || '',
        ref: environment.GITHUB_REF || '',
        runId: Number(environment.GITHUB_RUN_ID),
      },
      { ...dependencies, token: environment.GITHUB_TOKEN || '' },
    );
  } catch (error) {
    exitCode = 1;
    // Never expose API bodies, request objects, tokens or arbitrary exception text.
    decision.reason = error instanceof ReadinessError ? error.code : 'readiness-error';
  }
  const report = {
    schemaVersion: 1,
    checkedAtUtc: new Date().toISOString(),
    repository: repositoryPattern.test(repository) ? repository : null,
    sourceCommit: commitPattern.test(sourceCommit) ? sourceCommit : null,
    status: exitCode ? 'error' : decision.ready ? 'ready' : 'skipped',
    ...decision,
  };
  await io.saveReport(report);
  if (environment.GITHUB_STEP_SUMMARY) {
    await io.appendText(
      environment.GITHUB_STEP_SUMMARY,
      `### Windows candidate readiness\n\nResult: ${report.status} (${decision.reason}).\n\n` +
        `Source: ${report.sourceCommit || 'invalid'}.\n\n` +
        decision.checks.map((check) => `- ${check.workflow}: ${check.status}\n`).join('') +
        (decision.previousBuild
          ? `\nExisting successful candidate: run ${decision.previousBuild.runId}, attempt ${decision.previousBuild.attempt}.\n`
          : '') +
        '\nThe build job retains the strict exact-source CI gate.\n',
    );
  }
  if (environment.GITHUB_OUTPUT) {
    await io.appendText(environment.GITHUB_OUTPUT, `ready=${decision.ready}\n`);
  }
  return { exitCode, report };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCandidateReadiness()
    .then(({ exitCode, report }) => {
      console.log('Candidate readiness: ' + report.status + ' (' + report.reason + ')');
      process.exitCode = exitCode;
    })
    .catch(() => {
      console.error('Candidate readiness could not save its decision.');
      process.exitCode = 1;
    });
}
