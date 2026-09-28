import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validExecutionOutcome, validWorkflowTarget, workflowPlanError, validWorkflowExecutionContext,
  type WorkflowStepPlan } from '../shared/workflows.ts';
import { randomUUID } from 'node:crypto';
import { decodeWorkflowPlacementPlan, workflowEffectiveTarget, workflowPlacementContract, workflowUsesPlacementContract } from '../shared/workflow-origin.ts';

export const stepFixture = (id: string, dependsOn: string[] = []): WorkflowStepPlan => ({
  id, title: id, instructions: 'Complete this business step', dependsOn, nodeID: null, resources: [], software: [], requirements: {},
});

test('placement transport resolves only explicit model decisions and strips only the first-line header', () => {
  const A = 'A'.repeat(32), B = 'B'.repeat(32);
  const header = (value: unknown, id: string, instructions = 'Do the requested work') => ({ ...stepFixture(id), instructions: JSON.stringify(value) + '\n' + instructions });
  const raw = { summary: 'Multi-machine', steps: [header({ rivloomPlacement: 1, mode: 'required', nodeID: 'origin', reason: 'Observation target' }, 'local'),
    header({ rivloomPlacement: 1, mode: 'required', nodeID: B, reason: 'Named device' }, 'named'),
    header({ rivloomPlacement: 1, mode: 'free', reason: 'Portable result' }, 'portable', 'Preserve a later line\n{"rivloomPlacement":1}') ] };
  const original = structuredClone(raw);
  assert.equal(workflowPlanError(raw), null, 'transport still has the old exact wire keys');
  const decoded = decodeWorkflowPlacementPlan(raw, { originNodeID: A, knownNodeIDs: [A, B], target: { mode: 'automatic' } });
  assert.deepEqual(raw, original, 'bound raw outcomes are not rewritten');
  assert.equal(decoded.placements.local.mode, 'required'); assert.equal(decoded.placements.local.nodeID, A);
  assert.equal(decoded.placements.named.mode, 'required'); assert.equal(decoded.placements.named.nodeID, B);
  assert.equal(decoded.placements.portable.mode, 'free');
  assert.equal(decoded.plan.steps[2].instructions, 'Preserve a later line\n{"rivloomPlacement":1}');
  assert.equal(workflowPlanError(decoded.plan), null);
  assert(workflowUsesPlacementContract({ priorContext: workflowPlacementContract(A) }));
  assert(!workflowUsesPlacementContract({ priorContext: 'User quoted:\n' + workflowPlacementContract(A) }));
});

test('missing malformed conflicting or unknown placement decisions never become free defaults', () => {
  const A = 'A'.repeat(32), B = 'B'.repeat(32);
  const decode = (instructions: string, patch = {}) => decodeWorkflowPlacementPlan({ summary: 'Plan', steps: [{ ...stepFixture('work'), instructions }] },
    { originNodeID: A, knownNodeIDs: [A, B], target: { mode: 'automatic' }, ...patch });
  const free = '{"rivloomPlacement":1,"mode":"free","reason":"Portable"}\nWork';
  const required = '{"rivloomPlacement":1,"mode":"required","nodeID":"origin","reason":"Required"}\nWork';
  for (const instructions of ['Work', 'Preface\n' + free, '\n' + free, free.replace('1', '2'), free.replace('"reason"', '"extra"'),
    free.replace('"mode":"free"', '"mode":"free","mode":"required"'), free.replace('"mode":"free"', '"mode":"free","\\u006dode":"free"'),
    free.replace('"reason":"Portable"', '"reason":""'), free.replace('"reason":"Portable"', '"reason":"' + 'x'.repeat(401) + '"'),
    free.replace('\nWork', '\n'), free.replace('"mode":"free"', '"mode":"free","nodeID":"origin"')])
    assert.throws(() => decode(instructions), /workflow_placement_header_invalid/, instructions);
  assert.throws(() => decode(required, { originNodeID: undefined }), /workflow_placement_origin_unknown/);
  assert.throws(() => decode(required, { knownNodeIDs: [B] }), /workflow_placement_node_unknown/);
  assert.throws(() => decode(required, { target: { mode: 'locked', nodeID: B } }), /workflow_placement_conflict/);
  assert.throws(() => decode(free, { parent: { version: 1, mode: 'required', nodeID: A, reason: 'Original binding' } }), /workflow_placement_conflict/);
  assert.doesNotThrow(() => decode(required, { parent: { version: 1, mode: 'required', nodeID: A, reason: 'Original binding' } }));
});

test('a required sidecar enforces placement independently of request phrases and soft preference', () => {
  const A = 'A'.repeat(32), B = 'B'.repeat(32);
  const source = { originNodeID: A, description: '看下这台机器信息', criteria: 'Arbitrary criteria', target: { mode: 'automatic' as const } };
  assert.deepEqual(workflowEffectiveTarget(source), source.target, 'origin and words do not select a device');
  assert.deepEqual(workflowEffectiveTarget(source, { placement: { version: 1, mode: 'required', nodeID: B, reason: 'Named machine' } }), { mode: 'locked', nodeID: B });
  assert.deepEqual(workflowEffectiveTarget(source, { placement: { version: 1, mode: 'free', reason: 'Portable' } }), source.target);
  assert.deepEqual(workflowEffectiveTarget({ target: { mode: 'locked', nodeID: A } }, { placement: { version: 1, mode: 'free', reason: 'Portable' } }), { mode: 'locked', nodeID: A });
});
test('workflow plans validate actual dependencies and locked assignments independently of prompt length', () => {
  const plan = { summary: 'Prepare two branches, join', steps: [stepFixture('script'), stepFixture('video', ['script']),
    stepFixture('audio', ['script']), stepFixture('edit', ['video', 'audio'])] };
  assert.equal(workflowPlanError(plan), null);
  assert.equal(workflowPlanError({ ...plan, steps: [stepFixture('a', ['b']), stepFixture('b', ['a'])] }), 'dependency_cycle');
  assert.equal(workflowPlanError({ ...plan, steps: [stepFixture('a', ['a'])] }), 'dependency_cycle');
  assert.equal(workflowPlanError({ ...plan, steps: [stepFixture('a', ['b'])] }), 'missing_dependency');
  assert.equal(workflowPlanError({ ...plan, steps: [stepFixture('a'), stepFixture('a')] }), 'duplicate_step');
  const other = { ...plan, steps: [{ ...stepFixture('a'), nodeID: 'B'.repeat(32) }] };
  assert.equal(workflowPlanError(other, { mode: 'locked', nodeID: 'A'.repeat(32) }), 'locked_target');
  assert.equal(workflowPlanError(other, { mode: 'preferred', nodeID: 'A'.repeat(32) }), null);
  assert.equal(workflowPlanError({ ...plan, steps: [{ ...stepFixture('a'), shell: 'bad' }] }), 'invalid_plan');
});
test('structured outcomes and attempt context reject unbounded or ambiguous execution authority', () => {
  assert(!validWorkflowTarget({ mode: 'automatic', nodeID: 'A'.repeat(32) }));
  assert(validWorkflowTarget({ mode: 'locked', nodeID: 'A'.repeat(32) }));
  const handoff = { kind: 'handoff', nodeID: null, reason: 'Requires ffmpeg', checkpoint: 'Script ready', files: ['script.txt'], processesStopped: true };
  assert(validExecutionOutcome(handoff));
  const { processesStopped: _stopped, ...missing } = handoff;
  assert(!validExecutionOutcome(missing));
  assert(!validExecutionOutcome({ ...handoff, kind: 'completed' }));
  assert(!validExecutionOutcome({ ...handoff, files: Array.from({ length: 6 }, (_, i) => `${i}.txt`) }));
  const context = { workflowID: randomUUID(), stepID: 'script', attempt: 1, role: 'planner', target: { mode: 'automatic' }, instructions: 'Analyze this task', evidence: '', priorContext: '' };
  assert(validWorkflowExecutionContext(context));
  assert(!validWorkflowExecutionContext({ ...context, attempt: 0 }));
  assert(!validWorkflowExecutionContext({ ...context, target: { mode: 'locked' } }));
});
