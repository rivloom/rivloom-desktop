import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validExecutionOutcome, validWorkflowTarget, workflowPlanError, validWorkflowExecutionContext,
  type WorkflowStepPlan } from '../shared/workflows.ts';
import { randomUUID } from 'node:crypto';

export const stepFixture = (id: string, dependsOn: string[] = []): WorkflowStepPlan => ({
  id, title: id, instructions: 'Complete this business step', dependsOn, nodeID: null, resources: [], software: [], requirements: {},
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
