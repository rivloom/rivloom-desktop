import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateWorkflows,
  evaluateCandidateChecks,
  type CandidateWorkflowRun,
} from './ci-candidate-gate.ts';

const repository = 'rivloom/rivloom-desktop';
const commit = '1'.repeat(40);
const run = (
  workflow: string,
  changes: Partial<CandidateWorkflowRun> = {},
): CandidateWorkflowRun => ({
  id: 100,
  run_attempt: 1,
  head_sha: commit,
  head_branch: 'main',
  event: 'push',
  path: '.github/workflows/' + workflow,
  status: 'completed',
  conclusion: 'success',
  html_url: 'https://github.com/' + repository + '/actions/runs/100',
  head_repository: { full_name: repository },
  ...changes,
});
const snapshots = () => candidateWorkflows.map((workflow) => ({ workflow, runs: [run(workflow)] }));

test('candidate gate requires all three CI workflows for its exact source', () => {
  assert.equal(evaluateCandidateChecks(repository, commit, snapshots()).status, 'passed');
  const qualified = snapshots();
  for (const item of qualified) item.runs[0].path += '@main';
  assert.equal(evaluateCandidateChecks(repository, commit, qualified).status, 'passed');
  assert.throws(() => evaluateCandidateChecks(repository, commit, snapshots().slice(1)));
  for (const changes of [
    { head_sha: '2'.repeat(40) },
    { head_branch: 'feature' },
    { event: 'pull_request' },
    { head_repository: { full_name: 'someone/fork' } },
    { path: '.github/workflows/unrelated.yml' },
    { path: '.github/workflows/ci.yml@untrusted-branch' },
  ]) {
    const data = snapshots();
    data[0].runs = [run(data[0].workflow, changes)];
    assert.equal(evaluateCandidateChecks(repository, commit, data).status, 'waiting');
  }
});

test('candidate gate never replaces a newer failure or active retry with an older success', () => {
  const data = snapshots();
  data[0].runs.push(
    run(data[0].workflow, {
      id: 101,
      conclusion: 'failure',
      html_url: 'https://github.com/' + repository + '/actions/runs/101',
    }),
  );
  assert.equal(evaluateCandidateChecks(repository, commit, data).status, 'failed');
  data[0].runs[1] = run(data[0].workflow, {
    run_attempt: 2,
    status: 'in_progress',
    conclusion: null,
  });
  assert.equal(evaluateCandidateChecks(repository, commit, data).status, 'waiting');
});

test('candidate gate preserves cancelled, skipped and timed-out CI as failures', () => {
  for (const conclusion of ['cancelled', 'skipped', 'timed_out', 'neutral', null]) {
    const data = snapshots();
    data[2].runs = [run(data[2].workflow, { conclusion })];
    assert.equal(evaluateCandidateChecks(repository, commit, data).status, 'failed');
  }
  const data = snapshots();
  data[0].runs[0].html_url = 'https://example.com/fake-run';
  assert.throws(() => evaluateCandidateChecks(repository, commit, data), /Unexpected CI run URL/);
});
