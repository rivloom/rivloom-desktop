import { workflowCandidateAllowed, type WorkflowDiagnosticSnapshot, type WorkflowStepDiagnostic } from '../shared/workflow-diagnostics.ts';
import type { Workflow, WorkflowAttempt, WorkflowStep } from '../shared/workflows.ts';
import type { WorkflowPlacement } from './workflow-placement.ts';

export type WorkflowExecutionDiagnostic = {
  connected: boolean; observedAt: string | null; attention: boolean;
  queue: WorkflowStepDiagnostic['queue'];
};
export type WorkflowDiagnosticSources = {
  placement: (step: WorkflowStep) => WorkflowPlacement;
  preparation: (step: WorkflowStep) => { nodeID: string; observedAt: string } | null;
  execution: (attempt: WorkflowAttempt) => WorkflowExecutionDiagnostic;
};

/** Pure observation. In particular, do not call lookup(), which may export files or contact peers. */
export function workflowDiagnostics(value: Workflow, sources: WorkflowDiagnosticSources, at = Date.now()): WorkflowDiagnosticSnapshot {
  const steps = value.planVersion ? value.steps : [value.planner];
  return { workflowID: value.id, roundRequestID: value.roundRequestID || value.requestID, workflowVersion: value.version,
    sampledAt: new Date(at).toISOString(), steps: steps.map((step): WorkflowStepDiagnostic => {
      const attempt = step.attempts.at(-1);
      const active = step.state === 'running' && attempt;
      const target = value.target.mode === 'locked' ? value.target.nodeID : step.continuation?.nodeID || null;
      const result: WorkflowStepDiagnostic = { stepID: step.id, attempt: attempt?.number || 0,
        executionID: active ? attempt.executionID : null, nodeID: active ? attempt.nodeID : target,
        phase: 'placement', recovery: 'automatic_check', observedAt: null, dependencies: [], nodes: [], queue: null };
      const state = (phase: WorkflowStepDiagnostic['phase'], recovery: WorkflowStepDiagnostic['recovery'] = 'none') => ({ ...result, phase, recovery });
      if (step.state === 'completed') return { ...state('completed'), nodeID: attempt?.nodeID || null, observedAt: attempt?.updatedAt || null };
      if (step.state === 'failed') return { ...state('failed', 'user_action'), nodeID: attempt?.nodeID || result.nodeID, observedAt: attempt?.updatedAt || null };
      if (step.state === 'cancelled' || value.state === 'stopped') return state('stopped');
      if (value.state === 'stopping') return state('stopping', 'wait_original_execution');
      // Pausing only fences new dispatch; already admitted work keeps its actual status.
      if (!active && value.state === 'paused') return state('paused', 'user_action');
      if (value.pendingConfirmation?.stepID === step.id) return { ...state('confirmation', 'user_action'), nodeID: value.pendingConfirmation.nodeID };
      if (!active) {
        result.dependencies = step.dependsOn.filter((id) => value.steps.find((s) => s.id === id)?.state !== 'completed');
        if (result.dependencies.length) return state('dependency', step.state === 'blocked' ? 'user_action' : 'automatic_check');
        const preparation = sources.preparation(step);
        if (preparation) return { ...state('materials', 'automatic_check'), ...preparation };
        const placement = sources.placement(step);
        result.nodes = placement.nodes.map((node) => workflowCandidateAllowed(value, step, node.nodeID) ? node :
          { nodeID: node.nodeID, reasons: [{ code: 'target_restricted', certainty: 'confirmed', observedAt: null }] });
        // Prefer the locked/continuation target; other nodes cannot resolve that wait.
        if (target) result.nodes = result.nodes.filter((node) => node.nodeID === target);
        return result;
      }
      const execution = sources.execution(attempt);
      result.observedAt = execution.observedAt;
      if (!execution.connected || attempt.phase === 'unknown') return state('unknown', 'wait_original_execution');
      result.queue = execution.queue;
      if (execution.attention || attempt.phase === 'waiting') return state('attention', execution.attention ? 'user_action' : 'wait_original_execution');
      if (attempt.phase === 'intent') return state('dispatching', 'wait_original_execution');
      if (attempt.phase === 'queued') {
        if (execution.queue?.code === 'state_unknown') return { ...state('unknown', 'wait_original_execution'), queue: null };
        if (execution.queue?.state === 'held') return state('held', 'user_action');
        if (execution.queue?.state === 'rejected') return state('rejected', 'wait_original_execution');
        if (execution.queue?.state === 'admitted') return state('admitted', 'wait_original_execution');
        return state('queued', 'wait_original_execution');
      }
      if (attempt.phase === 'failed') return state('failed', 'user_action');
      if (attempt.phase === 'stopped') return state('stopped');
      // A completed attempt may still be validating its outcome or preparing a handoff.
      if (attempt.phase === 'completed') return state('attention', 'wait_original_execution');
      return state('running', 'wait_original_execution');
    }) };
}
