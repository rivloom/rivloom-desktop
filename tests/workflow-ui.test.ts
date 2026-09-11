import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Workflow, WorkflowStep, WorkflowAttempt } from '../shared/workflows.ts';
import type { Bootstrap, Task } from '../shared/types.ts';
import { workflowGraph, layoutWorkflowGraph } from '../src/workflow-graph-data.ts';
import { workflowResults } from '../src/workflow-results.ts';
import { conversations } from '../src/conversations.ts';
import { collectAttention } from '../shared/task-attention.ts';
import { createWorkflowDraft, updateConversationDraft, prepareConversationRequest, clearSubmittedDraft, createdConversationKey } from '../src/conversation-drafts.ts';

const at = '2026-09-09T00:00:00.000Z';
const step = (id: string, dependsOn: string[] = []): WorkflowStep => ({ id, title: id, instructions: id, dependsOn, nodeID: null,
  resources: [], software: [], requirements: {}, state: 'waiting', attempts: [], checkpoint: '', queryRounds: 0, materials: [], evidence: '', continuation: null });
const attempt = (number: number): WorkflowAttempt => ({ number, executionID: `execution-${number}`, nodeID: `node-${number}`, kind: 'local',
  phase: 'completed', createdAt: at, updatedAt: at, summary: '', outcome: null, inputFiles: [], outputFiles: [], error: null, handled: true,
  context: { workflowID: 'root', stepID: 'script', attempt: number, role: 'executor', target: { mode: 'automatic' }, instructions: '', evidence: '', priorContext: '' } });
const fixture = (): Workflow => ({ id: 'root', requestID: 'request', contentDigest: '', creatorID: 'owner', title: 'Make a film', description: 'Script, materials and edit',
  criteria: '', projectID: null, model: null, approvalMode: 'ask', target: { mode: 'automatic' }, state: 'running', version: 1, planVersion: 1, summary: '',
  planner: step('planner'), steps: [step('script'), step('video', ['script']), step('audio', ['script']), step('edit', ['video', 'audio'])],
  events: [], handoffs: [], inputFiles: [], confirmations: [], pendingConfirmation: null, createdAt: at, updatedAt: at, error: null });

test('final response uses the latest terminal step outcome, never the plan or earlier checkpoints', () => {
  const value = fixture(); value.state = 'completed'; value.summary = 'This is the plan';
  for (const s of value.steps) { s.state = 'completed'; s.checkpoint = 'Old checkpoint'; s.attempts = [attempt(1)]; }
  const last = value.steps.at(-1)!;
  last.attempts = [attempt(1), { ...attempt(2), outcome: { kind: 'completed', summary: 'Video ready', files: ['final.mp4'] } }];
  // A plan need not be stored in topological order.
  value.steps = [last, ...value.steps.slice(0, -1)];
  const results = workflowResults(value);
  assert.equal(results.length, 1); assert.equal(results[0].step.id, 'edit');
  assert.equal(results[0].attempt.number, 2); assert.equal(results[0].summary, 'Video ready');
});

test('independent terminal deliverables retain separate source steps', () => {
  const value = fixture(); value.state = 'completed'; value.steps = value.steps.slice(0, 3);
  for (const s of value.steps) { s.state = 'completed'; s.attempts = [{ ...attempt(1), outcome: { kind: 'completed', summary: s.title, files: [] } }]; }
  assert.deepEqual(workflowResults(value).map((result) => result.step.id), ['video', 'audio']);
});

test('incomplete workflows and non-completion attempts cannot appear as final answers', () => {
  const value = fixture(); value.steps = [step('result')]; value.steps[0].state = 'completed';
  value.steps[0].attempts = [{ ...attempt(1), outcome: { kind: 'completed', summary: 'Old result', files: [] } }];
  for (const state of ['running', 'paused', 'stopping', 'planning'] as const) {
    value.state = state; assert.deepEqual(workflowResults(value), []);
  }
  for (const state of ['failed', 'stopped'] as const) {
    value.state = state; assert.equal(workflowResults(value)[0].summary, 'Old result', 'Retain completed work in partial results');
  }
  value.state = 'completed';
  value.steps[0].attempts.push({ ...attempt(2), phase: 'failed' });
  assert.deepEqual(workflowResults(value), []);
  value.steps[0].attempts[1] = { ...attempt(2), outcome: { kind: 'handoff', nodeID: null, reason: 'Need another node', checkpoint: 'Only a checkpoint', files: [], processesStopped: true } };
  assert.deepEqual(workflowResults(value), []);
});

test('task graph anchors dependencies to the latest source attempt and preserves real handoff edges', () => {
  const value = fixture(); value.steps[0].attempts = [attempt(1), attempt(2), attempt(3)];
  value.handoffs.push({ id: 'transfer', stepID: 'script', fromAttempt: 1, toAttempt: 2, fromNodeID: 'node-1', toNodeID: 'node-2', reason: 'Need material', phase: 'completed', at });
  const graph = workflowGraph(value);
  assert.deepEqual(graph.nodes.filter((n) => n.step.id === 'script').map((n) => n.id), ['script:1', 'script:3']);
  assert.equal(graph.edges.find((e) => e.id === 'transfer')?.kind, 'handoff');
  assert.equal(graph.edges.find((e) => e.id === 'transfer')?.to, 'script:3');
  assert.equal(graph.edges.find((e) => e.to === 'video:0')?.from, 'script:3');
  assert.deepEqual(graph.edges.filter((e) => e.to === 'edit:0').map((e) => e.from).sort(), ['audio:0', 'video:0']);
});
test('task graph cards fit narrow and wide canvases without overlap, with all joins to the right of their parents', () => {
  const value = fixture(); value.steps.splice(3, 0, ...['a', 'b', 'c', 'd'].map((id) => step(id, ['script'])));
  const graph = workflowGraph(value);
  for (const width of [244, 320, 470, 640, 980]) {
    const layout = layoutWorkflowGraph(graph, width); const cards = [...layout.positions.values()];
    for (const card of cards) { assert(card.x >= 0 && card.x + card.width <= layout.width); assert(card.y + card.height <= layout.height); }
    for (const [i, card] of cards.entries()) for (const other of cards.slice(i + 1))
      assert(card.x + card.width <= other.x || other.x + other.width <= card.x || card.y + card.height <= other.y || other.y + other.height <= card.y);
    for (const edge of graph.edges) {
      const from = layout.positions.get(edge.from)!, to = layout.positions.get(edge.to)!;
      assert(from.x + from.width < to.x);
    }
  }
  const chain = fixture(); chain.steps = Array.from({ length: 10 }, (_, i) => step(`step-${i}`, i ? [`step-${i - 1}`] : []));
  const layout = layoutWorkflowGraph(workflowGraph(chain), 640);
  assert(layout.width > 640, 'A long chain scrolls horizontally');
  assert.equal(new Set([...layout.positions.values()].map((card) => card.y)).size, 1);
  assert(layout.height < 180, 'Adding sequential steps does not increase the graph height');
});
test('workflow drafts default to automatic planning and lock changes renew identity while display names do not', () => {
  const draft = createWorkflowDraft('initial'); assert.equal(draft.routing.kind, 'workflow');
  const preferred = updateConversationDraft(draft, { text: 'Make a film', routing: { kind: 'workflow', target: { mode: 'preferred', nodeID: 'A' }, name: 'Studio' } }, () => 'preferred');
  const renamed = updateConversationDraft(preferred, { routing: { kind: 'workflow', target: { mode: 'preferred', nodeID: 'A' }, name: 'Renamed' } }, () => 'bad');
  assert.equal(renamed.requestID, 'preferred');
  const locked = updateConversationDraft(renamed, { routing: { kind: 'workflow', target: { mode: 'locked', nodeID: 'A' } } }, () => 'locked');
  assert.equal(locked.requestID, 'locked'); assert.equal(prepareConversationRequest(locked, {}).requestID, 'locked');
  assert.equal(createdConversationKey(locked.routing, 'root'), 'workflow:root');
  assert.equal(clearSubmittedDraft({ new: locked }, 'new', 'locked', () => createWorkflowDraft('next')).new.requestID, 'next');
});
test('origin history and attention aggregate workflow executions and retain receiving records', () => {
  const value = fixture(); const a = attempt(1); a.phase = 'running'; value.steps[0].attempts = [a]; value.steps[0].state = 'running';
  const local = { id: a.executionID, title: 'Child', description: '', state: 'waiting_approval', approvals: [{ id: 'approval' }], questions: [],
    createdAt: at, updatedAt: at, creatorID: 'owner', assigneeID: 'owner', approverID: 'owner' } as unknown as Task;
  const data = { workflows: [value], tasks: [local], user: { id: 'owner', owner: true },
    network: { local: { id: 'own' }, remoteTasks: [], brainTasks: [], paired: [], nearby: [] } } as unknown as Bootstrap;
  assert.deepEqual(conversations(data).map((c) => c.key), ['workflow:root']);
  const attention = collectAttention(data); assert.equal(attention.events.length, 1); assert.equal(attention.events[0].conversationKey, 'workflow:root');
  assert.equal(attention.events[0].kind, 'approval');
  data.tasks = [{ ...local, id: 'incoming', remoteOrigin: { ownerNodeID: 'peer' } } as Task];
  assert(conversations(data).some((c) => c.key === 'local:incoming' && c.incoming));
});
