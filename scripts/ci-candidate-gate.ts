import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ciRoot } from './ci-workspace.ts';

export const candidateWorkflows = ['ci.yml', 'windows-services.yml', 'lan-regression.yml'] as const;

export interface CandidateWorkflowRun {
  id: number;
  run_attempt: number;
  head_sha: string;
  head_branch: string;
  event: string;
  path: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  head_repository: { full_name: string } | null;
}

export interface CandidateWorkflowSnapshot {
  workflow: (typeof candidateWorkflows)[number];
  runs: CandidateWorkflowRun[];
}

export function evaluateCandidateChecks(
  repository: string,
  commit: string,
  snapshots: CandidateWorkflowSnapshot[],
) {
  assert.match(repository, /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/, 'Invalid source repository');
  assert.match(commit, /^(?!0{40}$)[0-9a-f]{40}$/, 'Full candidate source SHA required');
  assert.equal(snapshots.length, candidateWorkflows.length, 'All CI workflows must be checked');
  assert.equal(new Set(snapshots.map((item) => item.workflow)).size, candidateWorkflows.length);
  const checks = candidateWorkflows.map((workflow) => {
    const snapshot = snapshots.find((item) => item.workflow === workflow);
    assert(snapshot, 'Missing required CI workflow: ' + workflow);
    const matching = snapshot.runs
      .filter(
        (run) =>
          run.head_sha === commit &&
          run.head_branch === 'main' &&
          run.event === 'push' &&
          (run.path === '.github/workflows/' + workflow ||
            run.path === '.github/workflows/' + workflow + '@main') &&
          run.head_repository?.full_name === repository &&
          Number.isSafeInteger(run.id) &&
          run.id > 0 &&
          Number.isSafeInteger(run.run_attempt) &&
          run.run_attempt > 0,
      )
      .sort((left, right) => right.id - left.id || right.run_attempt - left.run_attempt);
    const run = matching[0];
    if (!run) return { workflow, status: 'missing' as const, run: null };
    assert.equal(
      run.html_url,
      'https://github.com/' + repository + '/actions/runs/' + run.id,
      'Unexpected CI run URL',
    );
    return {
      workflow,
      status:
        run.status === 'completed'
          ? run.conclusion === 'success'
            ? ('passed' as const)
            : ('failed' as const)
          : ('waiting' as const),
      run: {
        id: run.id,
        attempt: run.run_attempt,
        sourceCommit: run.head_sha,
        status: run.status,
        conclusion: run.conclusion,
        url: run.html_url,
      },
    };
  });
  return {
    repository,
    sourceCommit: commit,
    status: checks.every((check) => check.status === 'passed')
      ? ('passed' as const)
      : checks.some((check) => check.status === 'failed')
        ? ('failed' as const)
        : ('waiting' as const),
    checks,
  };
}

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'CI gate requires the GitHub runner context');
  const repository = process.env.GITHUB_REPOSITORY || '';
  const commit = process.env.RIVLOOM_CANDIDATE_SHA || '';
  assert.match(repository, /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(commit, /^(?!0{40}$)[0-9a-f]{40}$/);
  const token = process.env.GITHUB_TOKEN;
  assert(token, 'Read-only Actions token is required for exact-source CI verification');
  assert.equal(process.env.GITHUB_API_URL || 'https://api.github.com', 'https://api.github.com');
  const startedAt = Date.now();
  const deadline = startedAt + 22 * 60_000;
  let result: ReturnType<typeof evaluateCandidateChecks> | undefined;
  let requestFailed = false;
  while (Date.now() < deadline) {
    try {
      const snapshots = await Promise.all(
        candidateWorkflows.map(async (workflow) => {
          const url = new URL(
            'https://api.github.com/repos/' +
              repository +
              '/actions/workflows/' +
              workflow +
              '/runs',
          );
          url.search = new URLSearchParams({
            branch: 'main',
            event: 'push',
            head_sha: commit,
            per_page: '20',
          }).toString();
          const response = await fetch(url, {
            headers: {
              Accept: 'application/vnd.github+json',
              Authorization: 'Bearer ' + token,
              'X-GitHub-Api-Version': '2022-11-28',
            },
            signal: AbortSignal.timeout(15_000),
          });
          assert(response.ok, 'GitHub CI status lookup failed: HTTP ' + response.status);
          const body = (await response.json()) as { workflow_runs?: CandidateWorkflowRun[] };
          assert(Array.isArray(body.workflow_runs), 'GitHub did not return workflow runs');
          return { workflow, runs: body.workflow_runs };
        }),
      );
      result = evaluateCandidateChecks(repository, commit, snapshots);
      console.log(
        'Candidate CI gate: ' +
          result.checks.map((item) => item.workflow + '=' + item.status).join(', '),
      );
      if (result.status !== 'waiting') break;
      await delay(Math.min(20_000, Math.max(0, deadline - Date.now())));
    } catch {
      // Do not dump API response bodies, request objects or authorization headers.
      requestFailed = true;
      break;
    }
  }
  const report = {
    schemaVersion: 1,
    checkedAtUtc: new Date().toISOString(),
    repository,
    sourceCommit: commit,
    status: !requestFailed && result?.status === 'passed' ? 'passed' : 'failed',
    requestFailed,
    timedOut: !requestFailed && result?.status === 'waiting',
    durationMs: Date.now() - startedAt,
    checks: result?.checks || [],
    scope:
      'Latest same-repository main push runs for all three CI workflows and the exact candidate SHA; not installer or physical-device acceptance.',
  };
  const directory = join(ciRoot, 'test-results', 'candidate');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'ci-gate.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
  });
  assert.equal(
    report.status,
    'passed',
    'Candidate blocked: all CI checks must pass for its exact source commit. See ci-gate.json.',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Candidate CI gate failed');
    process.exitCode = 1;
  });
}
