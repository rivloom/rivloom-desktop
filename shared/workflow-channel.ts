import { digest, integer, jsonBytes, keys, record, text, uuid } from './collaboration.ts';
import { validTaskFileManifest, type TaskFileDescriptor } from './task-files.ts';
import { validExecutionOutcome, validPlanningOutcome, type ExecutionOutcome, type PlanningOutcome, type WorkflowAttempt } from './workflows.ts';
export const workflowControlsCapability = 'workflow-controls-v1';
export type WorkflowOutcomeReply = {
  executionID: string; digest: string; sessionID: string | null; attempt: number; runAfter: number;
  phase: Exclude<WorkflowAttempt['phase'], 'intent'>; summary: string; error: string | null;
  outcome: ExecutionOutcome | PlanningOutcome | null; outputFiles: TaskFileDescriptor[]; safeToTransfer: boolean;
};
export function validWorkflowOutcomeReply(value: unknown): value is WorkflowOutcomeReply {
  return record(value) && jsonBytes(value) <= 60_000 && keys(value, ['executionID', 'digest', 'sessionID', 'attempt', 'runAfter',
    'phase', 'summary', 'error', 'outcome', 'outputFiles', 'safeToTransfer']) && uuid(value.executionID) && digest(value.digest) &&
    (value.sessionID === null || text(value.sessionID, 100)) && integer(value.attempt, 16, 1) && integer(value.runAfter, Number.MAX_SAFE_INTEGER) &&
    ['queued', 'running', 'waiting', 'completed', 'failed', 'stopped', 'unknown'].includes(String(value.phase)) &&
    text(value.summary, 2000, 0) && (value.error === null || text(value.error, 300)) && typeof value.safeToTransfer === 'boolean' &&
    validTaskFileManifest(value.outputFiles) && (value.outcome === null || validPlanningOutcome(value.outcome) || validExecutionOutcome(value.outcome)) &&
    (value.phase !== 'completed' || value.sessionID !== null && Number(value.runAfter) > 0 && value.outcome !== null);
}
