import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { conversations, type Conversation } from '../shared/conversations.ts';
import type { Bootstrap, Task } from '../shared/types.ts';
import type { Workflow, WorkflowAttempt, WorkflowRound } from '../shared/workflows.ts';
import { WorkflowStore, workflowStep } from '../server/workflows.ts';
import { ConversationHistory } from '../server/conversation-history.ts';
import { contentSearchMatch, indexConversations, searchConversations, searchExcerpt, searchTargetID,
  searchTextParts, workflowAttemptResponse } from '../src/conversation-search.ts';
import { rehypeSearch } from '../src/markdown-search.ts';
import { randomUUID } from 'node:crypto';

const at = '2026-09-13T00:00:00Z';
function fixture(): Workflow {
  const db = new DatabaseSync(':memory:');
  try {
    return new WorkflowStore(db).create({ requestID: randomUUID(), creatorID: 'owner', title: 'Video project', description: 'Current request',
      criteria: '', projectID: null, model: null, approvalMode: 'ask', target: { mode: 'automatic' }, inputFiles: [] });
  } finally { db.close(); }
}
function attempt(value: Workflow, number: number, summary: string): WorkflowAttempt {
  return { number, executionID: randomUUID(), nodeID: 'local', kind: 'local', phase: 'completed', createdAt: at, updatedAt: at,
    summary: 'engine-envelope-only', outcome: { kind: 'completed', summary, files: [] }, inputFiles: [], outputFiles: [], error: null, handled: true,
    context: { workflowID: value.id, stepID: 'result', attempt: number, role: 'executor', target: value.target,
      instructions: 'internal-context-only', evidence: 'private-evidence-only', priorContext: 'internal-history-only' } };
}
function completed(value: Workflow, response: string) {
  value.state = 'completed'; value.planVersion = 1; value.planner.state = 'completed';
  const step = workflowStep({ id: 'result', title: 'Result', instructions: 'plan-instruction-only', dependsOn: [], nodeID: null, resources: [], software: [], requirements: {} });
  step.state = 'completed'; step.checkpoint = response; step.attempts = [attempt(value, 1, response)]; value.steps = [step];
}
function item(extra: Partial<Conversation> = {}): Conversation {
  return { key: 'local:example', title: 'Project', description: 'Saved requirement', createdAt: at, updatedAt: at,
    sourceNodeID: 'local', incoming: false, attempts: [], ...extra };
}
const metadata = () => ({ device: 'Design laptop', directory: 'C:\\project\\demo\nDemo alias' });
const find = (values: Conversation[], query: string) => searchConversations(indexConversations(values, metadata), query);

test('content search locates requests and final responses in exact archived workflow rounds', () => {
  const workflow = fixture(); completed(workflow, '第一轮回答：青色海报已完成'); workflow.description = '第一轮要求制作青色海报';
  workflow.rounds = [{ ...structuredClone(workflow), requestID: workflow.requestID } as WorkflowRound];
  workflow.roundRequestID = randomUUID(); workflow.description = 'Now use orange'; completed(workflow, 'Orange revision ready');
  const value = item({ key: `workflow:${workflow.id}`, workflow });
  const before = structuredClone(value), matches = find([value], '青色海报').get(value.key)!;
  assert.equal(matches.length, 2); assert.equal(matches[0].round, 1);
  assert.equal(matches[0].target.roundID, workflow.requestID); assert.equal(matches[1].target.kind, 'response');
  assert.equal(matches[1].target.stepID, 'result'); assert.equal(matches[1].target.attempt, 1);
  const current = find([value], 'orange').get(value.key)!;
  assert.equal(current[0].round, 2); assert.equal(current[0].target.roundID, workflow.roundRequestID);
  assert.notEqual(current[1].id, matches[1].id); assert.deepEqual(value, before);
});

test('prior attempts retain their own checkpoints and the current final result is not duplicated', () => {
  const workflow = fixture(); completed(workflow, 'Latest reviewed answer');
  const step = workflow.steps[0]; step.attempts[0].outcome = { kind: 'handoff', nodeID: null, reason: 'Need equipment', checkpoint: 'Earlier relay checkpoint', files: [], processesStopped: true };
  step.attempts.push(attempt(workflow, 2, 'Latest reviewed answer'));
  const value = item({ workflow });
  const earlier = find([value], 'relay checkpoint').get(value.key)!;
  assert.equal(earlier.length, 1); assert.equal(earlier[0].target.kind, 'step'); assert.equal(earlier[0].target.attempt, 1);
  assert.equal(find([value], 'Latest reviewed answer').get(value.key)!.length, 1);
  assert.equal(workflowAttemptResponse(step, step.attempts[0]), 'Earlier relay checkpoint');
  assert.equal(workflowAttemptResponse(step, step.attempts[1]), 'Latest reviewed answer');
});

test('intermediate results and plan summaries navigate separately from final responses', () => {
  const workflow = fixture(); completed(workflow, 'Final composition'); workflow.summary = 'Plan summary: split work';
  const source = structuredClone(workflow.steps[0]); source.id = 'source'; source.attempts[0].outcome = { kind: 'completed', summary: 'Intermediate audio', files: [] };
  workflow.steps[0].dependsOn = ['source']; workflow.steps.unshift(source);
  const value = item({ workflow });
  assert.equal(find([value], 'Intermediate audio').get(value.key)![0].target.kind, 'step');
  assert.equal(find([value], 'split work').get(value.key)![0].target.kind, 'plan');
  assert.equal(find([value], 'Final composition').get(value.key)![0].target.kind, 'response');
});

test('pending message search omits cancelled and already started requests', () => {
  const workflow = fixture(); completed(workflow, 'Finished');
  workflow.roundRequestID = workflow.requestID;
  workflow.messages = [
    { requestID: workflow.requestID, state: 'queued', text: 'started-only', inputFiles: [], createdAt: at },
    { requestID: randomUUID(), state: 'queued', text: 'pending-only', inputFiles: [], createdAt: at },
    { requestID: randomUUID(), state: 'cancelled', text: 'cancelled-only', inputFiles: [], createdAt: at },
  ];
  const value = item({ workflow });
  const pending = find([value], 'pending-only').get(value.key)![0];
  assert.equal(pending.target.kind, 'queued'); assert.equal(pending.target.messageID, workflow.messages[1].requestID);
  assert.equal(find([value], 'started-only').size, 0); assert.equal(find([value], 'cancelled-only').size, 0);
});

test('legacy conversation search includes saved supplements and replies but excludes engine/tool payloads', () => {
  const value = item({ description: 'First request\n\n补充要求：保留 Safari 兼容性', localTask: {
    model: 'model-only-secret', criteria: 'criteria-only-secret',
    messages: [
      { id: 'prompt', role: 'user', text: 'engine-envelope-only', tools: [] },
      { id: 'reply', role: 'assistant', text: 'Assistant reply with **Markdown**', tools: [{ name: 'tool-only-secret', title: 'tool-title-only', status: 'done', output: 'tool-output-only' }] },
    ],
  } as Task });
  assert.equal(find([value], 'safari').get(value.key)![0].target.kind, 'requirement');
  assert.equal(find([value], 'MARKDOWN').get(value.key)![0].target.messageID, 'reply');
  for (const query of ['engine-envelope-only', 'model-only-secret', 'criteria-only-secret', 'tool-only-secret', 'tool-title-only', 'tool-output-only'])
    assert.equal(find([value], query).size, 0, query);
  const workflow = fixture(); completed(workflow, 'Final answer');
  for (const query of ['engine-envelope-only', 'internal-context-only', 'private-evidence-only', 'internal-history-only', 'plan-instruction-only'])
    assert.equal(find([item({ workflow })], query).size, 0, query);
});

test('remote summaries remain searchable without fetching remote files or old execution payloads', () => {
  const value = item({ remote: { executionSummary: 'Remote result containing nebula', executionState: 'accepted' } as Conversation['remote'],
    attempts: [{ executionSummary: 'superseded-only' } as NonNullable<Conversation['remote']>] });
  assert.equal(find([value], 'nebula').get(value.key)![0].target.kind, 'summary');
  assert.equal(find([value], 'superseded-only').size, 0);
});

test('literal Unicode search handles punctuation, case, whitespace and message boundaries', () => {
  const value = item({ description: 'A [.*] literal, C++ and 中文。Kelvin K. Emoji 🪷', title: 'separate' });
  for (const query of ['[.*]', ' C++ ', '中文', 'kelvin k', '🪷']) assert.equal(find([value], query).size, 1, query);
  for (const query of ['', '   ', 'separate A', 'C+X']) assert.equal(find([value], query).size, 0, query);
  assert.equal(searchTextParts('C++ c++', 'c++').filter((part) => part.match).length, 2);
  assert.equal(searchTextParts('K K k', 'k').filter((part) => part.match).length, 3);
});

test('matches beyond preview length are found and excerpts preserve original Unicode', () => {
  const value = item({ description: 'Very long text '.repeat(20_000) + '🪷Target phrase🪷' + ' tail'.repeat(100) });
  const match = find([value], 'target phrase').get(value.key)![0];
  assert(match.start > 200_000); const excerpt = searchExcerpt(match, 1);
  assert.equal(excerpt, '…🪷Target phrase🪷…');
  assert.equal(searchTextParts(match.text, 'target phrase').map((part) => part.text).join(''), value.description);
});

test('title, device and directory matches retain order and favor a content preview when available', () => {
  const values = [item({ key: 'second', title: 'Demo response', description: 'Demo content' }), item({ key: 'first' })];
  const matches = find(values, 'demo'); assert.deepEqual([...matches.keys()], ['second', 'first']);
  assert.equal(contentSearchMatch(matches.get('second')!)!.target.kind, 'requirement');
  assert.equal(contentSearchMatch(matches.get('first')!)!.target.kind, 'directory');
  assert.equal(find(values, 'design laptop').size, 2); assert.equal(contentSearchMatch([]), undefined);
  assert.notEqual(searchTargetID({ kind: 'step', roundID: 'x:y', stepID: 'z', attempt: 1 }), searchTargetID({ kind: 'step', roundID: 'x', stepID: 'y:z', attempt: 1 }));
});

test('history filtering, restore and permanent deletion cannot leave searchable retained copies', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const workflow = fixture(); completed(workflow, 'Only visible while retained');
    const data = { tasks: [], projects: [], workflows: [workflow], network: { local: { id: 'local' }, remoteTasks: [], brainTasks: [], paired: [], nearby: [] } } as unknown as Bootstrap;
    const history = new ConversationHistory(db, { data: () => data, queue: () => [], busy: () => false,
      purge: () => { data.workflows = []; } });
    const query = () => find(conversations(history.filter(data)), 'retained');
    const key = `workflow:${workflow.id}`; assert.equal(query().size, 1);
    history.trash(key, data); assert.equal(query().size, 0);
    history.restore(key); assert.equal(query().size, 1);
    history.trash(key, data); await history.purge(key); assert.equal(query().size, 0);
    // The index never adds records from another source or a formerly authorized snapshot.
    assert.equal(find([], 'retained').size, 0);
  } finally { db.close(); }
});

test('fresh snapshots replace edited answers and removed queued messages immediately', () => {
  const workflow = fixture(); completed(workflow, 'Before edit'); const value = item({ workflow });
  assert.equal(find([value], 'Before edit').size, 1);
  completed(workflow, 'After edit'); assert.equal(find([value], 'Before edit').size, 0); assert.equal(find([value], 'After edit').size, 1);
  workflow.messages = [{ requestID: randomUUID(), state: 'queued', text: 'Queued phrase', inputFiles: [], createdAt: at }];
  assert.equal(find([value], 'Queued phrase').size, 1);
  workflow.messages[0].state = 'cancelled'; assert.equal(find([value], 'Queued phrase').size, 0);
});

test('Markdown highlighting creates only text/mark nodes and preserves copied code bytes', () => {
  const original = '<img src=x onerror=alert(1)>\nconst value = "C++";\n';
  const tree = { type: 'root', children: [{ type: 'element', tagName: 'pre', children: [{ type: 'text', value: original }] }] };
  rehypeSearch({ query: '<img src=x onerror=alert(1)>' })(tree);
  const flatten = (node: { value?: string; children?: unknown[] }): string => node.value || (node.children || []).map((child) => flatten(child as typeof node)).join('');
  assert.equal(flatten(tree), original); assert.equal(tree.children[0].children[0].type, 'element');
  assert.equal((tree.children[0].children[0] as unknown as { tagName: string }).tagName, 'mark');
  assert(!JSON.stringify(tree).includes('"tagName":"img"'));
});
