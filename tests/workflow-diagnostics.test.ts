import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWorkflowPlacement, type WorkflowPlacementInput } from '../server/workflow-placement.ts';
import { collaborationCapability } from '../shared/collaboration.ts';
import { workflowCandidateAllowed, matchesWorkflowDiagnostic, workflowDiagnosticSummary } from '../shared/workflow-diagnostics.ts';
import { workflowStep } from '../server/workflows.ts';
import type { RivloomNode } from '../shared/types.ts';
import type { Workflow } from '../shared/workflows.ts';
import { workflowDiagnostics, type WorkflowDiagnosticSources } from '../server/workflow-diagnostics.ts';
import { diagnosticPhaseLabel, diagnosticReasonLabel } from '../src/workflow-diagnostic-labels.ts';

const at = Date.parse('2026-09-17T01:00:00Z'), stamp = new Date(at).toISOString();
const A = 'A'.repeat(32), B = 'B'.repeat(32), project = '11111111-1111-4111-8111-111111111111';
function node(id: string): RivloomNode {
  return { id, name: id, fingerprint: '', protocolVersion: 1, addresses: [], port: 0, online: true, local: id === A,
    trusted: true, verified: true, channelReady: true, lastSeen: stamp, lastContactAt: stamp,
    capabilities: [collaborationCapability], brains: [{ id: 'brain', name: 'brain', masterNodeID: A, state: 'established' }],
    worker: { nodeID: id, accepting: true, projects: [{ id: project, name: 'Fixture' }],
      hardware: { platform: 'win32', release: 'fixture', architecture: 'x64', cpuModel: 'fixture', physicalCores: 4,
        logicalCores: 8, memoryBytes: 16 * 1024 ** 3, gpus: [], diskBytes: null, collectedAt: stamp },
      load: { cpuPercent: null, memoryAvailableBytes: 8 * 1024 ** 3, memoryUsedPercent: 50, gpuPercent: null,
        gpuMemoryAvailableBytes: null, diskAvailableBytes: null, runningTasks: 2, availableSlots: 0, sampledAt: stamp } } };
}
function fixture() {
  const step = workflowStep({ id: 'work', title: 'Work', instructions: 'Work', dependsOn: [], nodeID: null, resources: [], software: [], requirements: {} });
  const input: WorkflowPlacementInput = { network: { local: node(A), paired: [node(B)],
    brains: [{ id: 'brain', name: 'brain', masterNodeID: A, state: 'established', online: true, hosted: true, queueDepth: 0, workers: [] }] }, owner: true, catalog: [],
    local: { projectID: project, model: 'fixture/model', projectExists: true, modelAvailable: true, engineReady: true, accepting: true, waitingCount: 0 } };
  return { step, input, peer: input.network.paired![0], own: input.network.local! };
}

test('placement keeps busy workers eligible and ranks backlog before resource locality', () => {
  const { step, input, peer } = fixture();
  step.resources = [{ nodeID: B, workspaceID: project, id: 'file', revision: 'revision' }];
  assert.deepEqual(evaluateWorkflowPlacement(step, input, at).candidates.map((c) => c.nodeID), [A, B]);
  peer.worker!.load.runningTasks = 0;
  assert.deepEqual(evaluateWorkflowPlacement(step, input, at).candidates.map((c) => c.nodeID), [B, A]);
});
test('disconnected peers do not expose stale software or model guesses', () => {
  const { step, input, peer } = fixture(); peer.online = false; peer.worker!.accepting = false; step.software = ['FFmpeg'];
  const result = evaluateWorkflowPlacement(step, input, at);
  assert.deepEqual(result.nodes.find((n) => n.nodeID === B)?.reasons.map((r) => r.code), ['node_offline']);
  assert.equal(result.candidates.length, 0);
});
test('unavailable remote execution does not imply a specific model failure', () => {
  const { step, input, peer } = fixture(); peer.worker!.accepting = false;
  assert.deepEqual(evaluateWorkflowPlacement(step, input, at).nodes[1].reasons.map((r) => r.code), ['execution_unavailable']);
  peer.worker!.load.sampledAt = '2020-01-01T00:00:00Z';
  assert.deepEqual(evaluateWorkflowPlacement(step, input, at).nodes[1].reasons.map((r) => r.code), ['report_stale']);
});
test('software absence is unknown unless fresh evidence explicitly says unavailable', () => {
  const { step, input } = fixture(); step.software = ['FFmpeg'];
  assert.equal(evaluateWorkflowPlacement(step, input, at).nodes[0].reasons[0].code, 'software_unknown');
  input.catalog = [{ nodeID: A, name: 'A', online: true, status: 'current', head: { nodeID: A, epoch: project, version: 1,
    workspaceID: project, workspaceName: 'Fixture', state: 'ready', count: 0, checkedAt: stamp, error: null,
    capabilities: [{ id: 'ffmpeg', name: 'FFmpeg', kind: 'software', status: 'unavailable', version: null, checkedAt: stamp }] } }];
  assert.equal(evaluateWorkflowPlacement(step, input, at).nodes[0].reasons[0].code, 'software_unavailable');
  input.catalog[0].head!.capabilities[0].checkedAt = '2020-01-01T00:00:00Z';
  assert.equal(evaluateWorkflowPlacement(step, input, at).nodes[0].reasons[0].code, 'software_unknown');
  input.catalog[0].head!.capabilities[0] = { ...input.catalog[0].head!.capabilities[0], status: 'available', checkedAt: stamp };
  assert.deepEqual(evaluateWorkflowPlacement(step, input, at).candidates.map((c) => c.nodeID), [A]);
});
test('non-owner placement never enumerates remote nodes', () => {
  const { step, input } = fixture(); input.owner = false;
  assert.deepEqual(evaluateWorkflowPlacement(step, input, at).nodes.map((n) => n.nodeID), [A]);
});
test('local model, project and hardware failures have concrete causes', () => {
  const { step, input } = fixture(); input.local.modelAvailable = false; input.local.projectExists = false;
  step.requirements = { gpu: true };
  assert.deepEqual(evaluateWorkflowPlacement(step, input, at).nodes[0].reasons.map((r) => r.code), ['project_unavailable', 'model_unavailable', 'hardware_unavailable']);
});
test('unknown GPU memory is not reported as a measured hardware shortfall', () => {
  const { step, input, peer } = fixture(); step.requirements = { minimumGpuMemoryBytes: 8 * 1024 ** 3 };
  peer.worker!.hardware.gpus = [{ name: 'Unmeasured GPU', memoryBytes: null }];
  const result = evaluateWorkflowPlacement(step, input, at).nodes[1].reasons[0];
  assert.equal(result.code, 'hardware_unknown'); assert.equal(result.certainty, 'unknown');
  assert.equal(result.hardware?.reported, null);
  assert.equal(evaluateWorkflowPlacement(step, input, at).candidates.length, 0);
});
test('placement restrictions and diagnostics retain locked target and handoff exclusions', () => {
  const { step } = fixture();
  const value = { target: { mode: 'locked', nodeID: B } } as Workflow;
  assert.equal(workflowCandidateAllowed(value, step, A), false);
  assert.equal(workflowCandidateAllowed(value, step, B), true);
  step.continuation = { nodeID: A, reason: 'handoff', handoff: true };
  assert.equal(workflowCandidateAllowed(value, step, B), false);
});
test('diagnostic snapshots cannot cross a task, round or workflow version', () => {
  const value = { id: 'task', requestID: 'round', version: 2 } as Workflow;
  const snapshot = { workflowID: 'task', roundRequestID: 'round', workflowVersion: 2, sampledAt: stamp, steps: [] };
  assert.equal(matchesWorkflowDiagnostic(value, snapshot), true);
  for (const patch of [{ workflowID: 'other' }, { roundRequestID: 'other' }, { workflowVersion: 1 }])
    assert.equal(matchesWorkflowDiagnostic(value, { ...snapshot, ...patch }), false);
});

function diagnosticFixture() {
  const f = fixture();
  const wait = structuredClone(f.step); wait.id = 'waiting'; wait.software = ['MissingTool'];
  const dependency = structuredClone(f.step); dependency.id = 'join'; dependency.dependsOn = ['work', 'waiting']; dependency.state = 'waiting';
  f.step.state = 'running';
  f.step.attempts.push({ number: 1, executionID: 'execution', nodeID: B, kind: 'remote', phase: 'running', createdAt: stamp,
    updatedAt: stamp, summary: '', outcome: null, inputFiles: [], outputFiles: [], error: null, handled: false,
    context: { workflowID: 'task', stepID: 'work', attempt: 1, role: 'executor', target: { mode: 'automatic' }, instructions: '', evidence: '', priorContext: '' } });
  const value: Workflow = { id: 'task', requestID: 'round', creatorID: 'owner', contentDigest: '', title: 'Fixture', description: 'Fixture',
    criteria: '', projectID: project, model: 'fixture/model', approvalMode: 'ask', target: { mode: 'automatic' }, state: 'running', version: 1,
    planVersion: 1, summary: '', planner: workflowStep({ ...f.step, id: 'planner' }), steps: [f.step, wait, dependency], events: [],
    handoffs: [], inputFiles: [], confirmations: [], pendingConfirmation: null, createdAt: stamp, updatedAt: stamp, error: null };
  const execution = { connected: true, attention: false, observedAt: stamp, queue: null };
  const sources: WorkflowDiagnosticSources = { placement: (s) => evaluateWorkflowPlacement(s, f.input, at), preparation: () => null, execution: () => execution };
  return { ...f, value, sources, execution, wait };
}
test('parallel running work does not hide a waiting branch or its dependencies', () => {
  const { value, sources } = diagnosticFixture();
  const before = JSON.stringify(value);
  const result = workflowDiagnostics(value, sources, at);
  assert.deepEqual(result.steps.map((s) => s.phase), ['running', 'placement', 'dependency']);
  assert.equal(result.steps[1].nodes[0].reasons[0].code, 'software_unknown');
  assert.deepEqual(result.steps[2].dependencies, ['work', 'waiting']);
  assert.equal(JSON.stringify(value), before);
  assert.deepEqual(workflowDiagnostics(value, sources, at), result);
});
test('disconnection and uncertain delivery hide queue position and keep original execution identity', () => {
  const { value, sources, execution } = diagnosticFixture();
  execution.connected = false;
  sources.execution = () => ({ ...execution, queue: { state: 'queued', position: 2, reason: null, code: null, local: false, observedAt: stamp } });
  const result = workflowDiagnostics(value, sources, at).steps[0];
  assert.equal(result.phase, 'unknown'); assert.equal(result.queue, null); assert.equal(result.executionID, 'execution');
  assert.equal(result.recovery, 'wait_original_execution');
  execution.connected = true; value.steps[0].attempts[0].phase = 'intent';
  assert.equal(workflowDiagnostics(value, sources, at).steps[0].phase, 'dispatching');
});
test('pause fences unstarted work while stop remains pending for original executions', () => {
  const { value, sources } = diagnosticFixture(); value.state = 'paused';
  assert.deepEqual(workflowDiagnostics(value, sources, at).steps.map((s) => s.phase), ['running', 'paused', 'paused']);
  value.state = 'stopping';
  assert(workflowDiagnostics(value, sources, at).steps.every((s) => s.phase === 'stopping'));
  value.steps[1].state = 'completed';
  assert.equal(workflowDiagnostics(value, sources, at).steps[1].phase, 'completed');
});
test('material preparation and queue confirmation precede placement explanations', () => {
  const { value, sources } = diagnosticFixture();
  sources.preparation = () => ({ nodeID: A, observedAt: stamp });
  assert.equal(workflowDiagnostics(value, sources, at).steps[1].phase, 'materials');
  value.pendingConfirmation = { stepID: 'waiting', nodeID: B, waitingCount: 10 };
  assert.equal(workflowDiagnostics(value, sources, at).steps[1].phase, 'confirmation');
});
test('locked-device explanation excludes irrelevant alternatives and preserves evidence age', () => {
  const { value, sources, peer } = diagnosticFixture(); value.target = { mode: 'locked', nodeID: B }; peer.online = false;
  peer.lastContactAt = '2026-09-16T01:00:00Z';
  const step = workflowDiagnostics(value, sources, at).steps[1];
  assert.equal(step.nodeID, B); assert.deepEqual(step.nodes.map((n) => n.nodeID), [B]);
  assert.equal(step.nodes[0].reasons[0].observedAt, peer.lastContactAt);
});
test('labels distinguish unknown evidence, executing, and waiting for confirmation', () => {
  assert.equal(diagnosticPhaseLabel('unknown'), '执行状态待确认');
  assert.equal(diagnosticPhaseLabel('dispatching'), '正在确认任务投递');
  assert.match(diagnosticReasonLabel({ code: 'software_unknown', software: 'FFmpeg', certainty: 'unknown', observedAt: null }), /待确认/);
});

test('authenticated queue receipts distinguish held, admitted and rejected without starting another execution', () => {
  const { value, sources, execution } = diagnosticFixture();
  value.steps[0].attempts[0].phase = 'queued';
  const before = JSON.stringify(value);
  for (const state of ['queued', 'held', 'admitted', 'rejected'] as const) {
    sources.execution = () => ({ ...execution, queue: { state, position: state === 'queued' ? 2 : null,
      reason: null, code: null, local: false, observedAt: stamp } });
    const diagnostic = workflowDiagnostics(value, sources, at).steps[0];
    assert.equal(diagnostic.phase, state);
    assert.equal(diagnostic.executionID, 'execution');
    assert.equal(diagnostic.recovery, state === 'held' ? 'user_action' : 'wait_original_execution');
  }
  assert.equal(JSON.stringify(value), before);
});

test('old queue receipts cannot override running, stopping, or disconnected executions', () => {
  const { value, sources, execution } = diagnosticFixture();
  sources.execution = () => ({ ...execution, queue: { state: 'held', position: null,
    reason: null, code: null, local: false, observedAt: stamp } });
  assert.equal(workflowDiagnostics(value, sources, at).steps[0].phase, 'running');
  value.state = 'stopping';
  assert.equal(workflowDiagnostics(value, sources, at).steps[0].phase, 'stopping');
  value.state = 'running'; value.steps[0].attempts[0].phase = 'queued'; execution.connected = false;
  const diagnostic = workflowDiagnostics(value, sources, at).steps[0];
  assert.equal(diagnostic.phase, 'unknown'); assert.equal(diagnostic.queue, null);
});

test('local queue with an uncertain physical execution never presents a usable queue position', () => {
  const { value, sources, execution } = diagnosticFixture(); value.steps[0].attempts[0].phase = 'queued';
  sources.execution = () => ({ ...execution, queue: { state: 'admitted', position: 2,
    reason: null, code: 'state_unknown', local: true, observedAt: stamp } });
  const diagnostic = workflowDiagnostics(value, sources, at).steps[0];
  assert.equal(diagnostic.phase, 'unknown'); assert.equal(diagnostic.queue, null);
  assert.equal(diagnostic.executionID, 'execution');
});

test('copyable summary preserves chronology and relationships but excludes all free-form content and identities', () => {
  const { value, sources, execution } = diagnosticFixture(); value.steps[0].attempts[0].phase = 'queued';
  sources.execution = () => ({ ...execution, queue: { state: 'held', position: null,
    reason: 'SECRET peer detail C:\\private\\file.txt', code: null, local: false, observedAt: stamp } });
  const snapshot = workflowDiagnostics(value, sources, at);
  snapshot.workflowID = 'SECRET workflow'; snapshot.roundRequestID = 'SECRET round';
  snapshot.steps[0].executionID = 'SECRET execution';
  snapshot.steps[1].nodes[0].reasons[0].software = 'SECRET software';
  const text = workflowDiagnosticSummary(snapshot), summary = JSON.parse(text);
  assert(!text.includes('SECRET')); assert(!text.includes(A)); assert(!text.includes(B));
  assert.equal(summary.freshness, 'current'); assert.equal(summary.sampledAt, stamp);
  assert.equal(summary.steps[0].device, summary.steps[1].devices[1].device);
  assert.equal(summary.steps[0].executionRecorded, true);
  assert.deepEqual(summary.steps[2].dependencies, [1, 2]);
  assert.deepEqual(summary.steps[0].queue, { state: 'held', position: null, code: null, observedAt: stamp, local: false });
  assert.equal(JSON.parse(workflowDiagnosticSummary(snapshot, true)).freshness, 'last_known');
  snapshot.sampledAt = 'SECRET invalid date';
  assert.equal(JSON.parse(workflowDiagnosticSummary(snapshot)).sampledAt, null);
});
