import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectChangeFile } from '../shared/project-changes.ts';
import type { Workflow, WorkflowStep } from '../shared/workflows.ts';
import {
  buildDiffQuoteText,
  canInspectChangedFile,
  changeFileStatusBadge,
  collectWorkflowDeliverableRounds,
  defaultDiffAreaForFile,
  parseDiffHunks,
  partitionProjectChanges,
} from '../src/inspector-review.ts';

function stepWithFiles(id: string, title: string, executionID: string, fileNames: string[]): WorkflowStep {
  return {
    id,
    title,
    instructions: '',
    dependsOn: [],
    nodeID: null,
    resources: [],
    software: [],
    requirements: {},
    state: 'completed',
    checkpoint: '',
    queryRounds: 0,
    materials: [],
    evidence: '',
    continuation: null,
    attempts: [
      {
        number: 1,
        executionID,
        nodeID: 'A'.repeat(32),
        kind: 'local',
        phase: 'completed',
        createdAt: '2026-11-20T08:00:00.000Z',
        updatedAt: '2026-11-20T08:01:00.000Z',
        summary: 'done',
        outcome: null,
        inputFiles: [],
        outputFiles: fileNames.map((name, idx) => ({
          id: `${executionID}-${idx}`,
          name,
          bytes: 120,
          sha256: 'b'.repeat(64),
          mime: 'text/plain',
        })),
        error: null,
        context: {
          workflowID: 'wf-1',
          stepID: id,
          attempt: 1,
          role: 'executor',
          target: { mode: 'automatic' },
          instructions: '',
          evidence: '',
          priorContext: '',
        },
        handled: true,
      },
    ],
  };
}

test('collectWorkflowDeliverableRounds groups deliverables by round and marks the latest round', () => {
  const round1Step = stepWithFiles('s1', '整理初稿', 'exec-1', ['draft.md']);
  const round2Step = stepWithFiles('s2', '生成终稿', 'exec-2', ['final.md', 'summary.csv']);
  const emptyPlanner = stepWithFiles('planner', '规划', 'exec-p', []);
  emptyPlanner.attempts[0].outputFiles = [];

  const workflow = {
    id: 'wf-1',
    description: '第二轮微调交付物',
    planVersion: 1,
    planner: emptyPlanner,
    steps: [round2Step],
    rounds: [
      {
        requestID: 'r1',
        createdAt: '2026-11-20T07:00:00.000Z',
        description: '第一轮初始交付',
        criteria: '',
        state: 'completed',
        planVersion: 1,
        summary: '',
        planner: emptyPlanner,
        steps: [round1Step],
        events: [],
        handoffs: [],
        inputFiles: [],
        confirmations: [],
        pendingConfirmation: null,
        updatedAt: '2026-11-20T07:05:00.000Z',
        error: null,
      },
    ],
  } as unknown as Workflow;

  const rounds = collectWorkflowDeliverableRounds(workflow);
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].roundNumber, 1);
  assert.equal(rounds[0].isLatest, false);
  assert.equal(rounds[0].fileCount, 1);
  assert.equal(rounds[1].roundNumber, 2);
  assert.equal(rounds[1].isLatest, true);
  assert.equal(rounds[1].fileCount, 2);
  assert.match(rounds[1].label, /最新/);
});

test('partitionProjectChanges clearly distinguishes staged, unstaged, both, untracked and conflict states', () => {
  const files: ProjectChangeFile[] = [
    { path: 'src/staged.ts', index: 'M', worktree: ' ', untracked: false, conflict: false },
    { path: 'src/working.ts', index: ' ', worktree: 'M', untracked: false, conflict: false },
    { path: 'src/both.ts', index: 'M', worktree: 'M', untracked: false, conflict: false },
    { path: 'src/new.ts', index: '?', worktree: '?', untracked: true, conflict: false },
    { path: 'src/conflict.ts', index: 'U', worktree: 'U', untracked: false, conflict: true },
  ];
  const partitioned = partitionProjectChanges(files);
  assert.deepEqual(partitioned.counts, { all: 5, working: 4, staged: 3 });
  assert.equal(changeFileStatusBadge(files[0]).tone, 'staged');
  assert.equal(changeFileStatusBadge(files[1]).tone, 'working');
  assert.equal(changeFileStatusBadge(files[2]).tone, 'both');
  assert.equal(changeFileStatusBadge(files[3]).tone, 'untracked');
  assert.equal(changeFileStatusBadge(files[4]).tone, 'conflict');

  assert.equal(defaultDiffAreaForFile(files[2], 'working', 'staged'), 'staged');
  assert.equal(defaultDiffAreaForFile(files[2], 'staged', 'working'), 'working');
  assert.equal(defaultDiffAreaForFile(files[0], 'working', 'all'), 'staged');
});

test('parseDiffHunks splits unified patches cleanly and buildDiffQuoteText caps long snippets', () => {
  const patch = [
    'diff --git a/src/app.ts b/src/app.ts',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -10,3 +10,4 @@ function init() {',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '+const c = 4;',
    '@@ -40,2 +41,2 @@ function done() {',
    '-return false;',
    '+return true;',
  ].join('\n');

  const hunks = parseDiffHunks(patch, 'patch');
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0].additions, 2);
  assert.equal(hunks[0].deletions, 1);
  assert.equal(hunks[1].additions, 1);
  assert.equal(hunks[1].deletions, 1);

  const quoted = buildDiffQuoteText({
    path: 'src/app.ts',
    area: 'staged',
    header: hunks[0].header,
    snippet: hunks[0].raw,
  });
  assert.match(quoted, /src\/app\.ts · 已暂存/);
  assert.match(quoted, /```diff/);

  const truncated = buildDiffQuoteText({
    path: 'src/huge.ts',
    area: 'working',
    snippet: '+line\n'.repeat(2000),
    maxLength: 400,
  });
  assert.ok(truncated.length <= 420);
  assert.match(truncated, /…/);
});

test('canInspectChangedFile blocks preview and folder reveal on deleted, sensitive or restricted files', () => {
  const normal: ProjectChangeFile = { path: 'src/a.ts', index: ' ', worktree: 'M', untracked: false, conflict: false };
  const deleted: ProjectChangeFile = { path: 'src/old.ts', index: ' ', worktree: 'D', untracked: false, conflict: false };
  assert.deepEqual(canInspectChangedFile(normal, { path: 'src/a.ts', area: 'working', state: 'ready', kind: 'patch', text: '+x' }), {
    canPreview: true,
    canReveal: true,
  });
  assert.deepEqual(canInspectChangedFile(deleted, null), { canPreview: false, canReveal: false });
  assert.deepEqual(
    canInspectChangedFile(normal, { path: '.env', area: 'working', state: 'sensitive', kind: 'patch', text: '' }),
    { canPreview: false, canReveal: false },
  );
  assert.deepEqual(
    canInspectChangedFile(normal, { path: 'link', area: 'working', state: 'restricted', kind: 'patch', text: '' }),
    { canPreview: false, canReveal: false },
  );
});
