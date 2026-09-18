import type { NodeQueueReasonCode } from './node-queue.ts';
import type { Workflow, WorkflowStep } from './workflows.ts';
import type { TaskHardwareRequirements } from './types.ts';
import type { TaskQueueReceipt } from './task-queue-receipts.ts';

export type WorkflowDiagnosticCode =
  | 'node_offline' | 'channel_unavailable' | 'trust_required' | 'topology_unavailable'
  | 'capability_unsupported' | 'report_missing' | 'report_stale' | 'execution_unavailable'
  | 'software_unavailable' | 'software_unknown' | 'hardware_unavailable' | 'hardware_unknown'
  | 'project_unavailable' | 'model_unavailable' | 'engine_unavailable'
  | 'queue_unavailable' | 'target_restricted' | 'no_eligible_node';
export type WorkflowDiagnosticReason = {
  code: WorkflowDiagnosticCode;
  certainty: 'confirmed' | 'unknown';
  observedAt: string | null;
  software?: string;
  hardware?: { requirement: keyof TaskHardwareRequirements; required: string | number | boolean; reported: string | number | boolean | null };
};
export type WorkflowNodeDiagnostic = { nodeID: string; reasons: WorkflowDiagnosticReason[] };
export type WorkflowStepDiagnostic = {
  stepID: string; attempt: number; executionID: string | null; nodeID: string | null;
  phase: 'dependency' | 'placement' | 'materials' | 'queued' | 'dispatching' | 'running'
    | 'held' | 'admitted' | 'rejected'
    | 'attention' | 'unknown' | 'failed' | 'completed' | 'paused' | 'stopping' | 'stopped' | 'confirmation';
  recovery: 'automatic_check' | 'wait_original_execution' | 'user_action' | 'none';
  observedAt: string | null;
  dependencies: string[];
  nodes: WorkflowNodeDiagnostic[];
  queue: { state: TaskQueueReceipt['state']; position: number | null; reason: string | null; code: NodeQueueReasonCode | null; observedAt: string; local: boolean } | null;
};
export type WorkflowDiagnosticSnapshot = {
  workflowID: string; roundRequestID: string; workflowVersion: number; sampledAt: string;
  steps: WorkflowStepDiagnostic[];
};

/** Shared by placement and its explanation. These restrictions also fence handoffs. */
export function workflowCandidateAllowed(value: Workflow, step: WorkflowStep, nodeID: string) {
  return (value.target.mode !== 'locked' || value.target.nodeID === nodeID) &&
    (!step.continuation?.nodeID || step.continuation.nodeID === nodeID) &&
    (!step.continuation?.handoff || !step.attempts.some((a) => a.nodeID === nodeID));
}

export function matchesWorkflowDiagnostic(value: Workflow, snapshot: WorkflowDiagnosticSnapshot) {
  return snapshot.workflowID === value.id && snapshot.roundRequestID === (value.roundRequestID || value.requestID) &&
    snapshot.workflowVersion === value.version;
}

/** Explicit fields only: omit titles, instructions, IDs, names, paths and free-form peer reasons. */
export function workflowDiagnosticSummary(snapshot: WorkflowDiagnosticSnapshot, unavailable = false) {
  const nodes = new Map<string, number>();
  const node = (id: string | null) => {
    if (!id) return null;
    if (!nodes.has(id)) nodes.set(id, nodes.size + 1);
    return nodes.get(id)!;
  };
  const time = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  return JSON.stringify({ format: 'rivloom-workflow-diagnostics-v1', freshness: unavailable ? 'last_known' : 'current',
    workflowVersion: snapshot.workflowVersion, sampledAt: time(snapshot.sampledAt),
    steps: snapshot.steps.map((step, index) => ({ step: index + 1, phase: step.phase, recovery: step.recovery,
      attempt: step.attempt, executionRecorded: !!step.executionID, device: node(step.nodeID), observedAt: time(step.observedAt),
      dependencies: step.dependencies.map((id) => snapshot.steps.findIndex((s) => s.stepID === id) + 1).filter(Boolean),
      devices: step.nodes.map((item) => ({ device: node(item.nodeID), checks: item.reasons.map((reason) => ({
        code: reason.code, certainty: reason.certainty, observedAt: time(reason.observedAt),
      })) })),
      queue: step.queue ? { state: step.queue.state, position: step.queue.position, code: step.queue.code,
        observedAt: time(step.queue.observedAt), local: step.queue.local } : null,
    })),
  }, null, 2);
}
