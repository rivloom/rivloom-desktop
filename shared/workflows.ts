import { digest, integer, jsonBytes, keys, nodeID, record, text, timestamp, uniqueStrings, uuid } from './collaboration.ts';
import { validResourceQuery, validResourceReference, type ResourceQuery, type ResourceReference } from './resources.ts';
import type { TaskFileDescriptor } from './task-files.ts';
import type { ApprovalMode, TaskHardwareRequirements } from './types.ts';

export type WorkflowTarget = { mode: 'automatic' } | { mode: 'preferred' | 'locked'; nodeID: string };
export type WorkflowStepPlan = {
  id: string; title: string; instructions: string; dependsOn: string[]; nodeID: string | null;
  resources: ResourceReference[]; software: string[]; requirements: TaskHardwareRequirements;
};
export type WorkflowPlan = { summary: string; steps: WorkflowStepPlan[] };
export type PlanningOutcome = { kind: 'plan'; plan: WorkflowPlan } | { kind: 'query'; query: ResourceQuery; reason: string };
export type ExecutionOutcome =
  | { kind: 'completed'; summary: string; files: string[] }
  | { kind: 'query'; query: ResourceQuery; reason: string; checkpoint: string; files: string[] }
  | { kind: 'resources'; resources: ResourceReference[]; reason: string; checkpoint: string; files: string[] }
  | { kind: 'handoff'; nodeID: string | null; reason: string; checkpoint: string; files: string[]; processesStopped: boolean }
  | { kind: 'expand'; plan: WorkflowPlan; checkpoint: string; files: string[] };
export type WorkflowExecutionContext = {
  workflowID: string; stepID: string; attempt: number; role: 'planner' | 'executor';
  target: WorkflowTarget; instructions: string; evidence: string; priorContext: string;
};
export type WorkflowAttempt = {
  number: number; executionID: string; nodeID: string; kind: 'local' | 'remote';
  phase: 'intent' | 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'stopped' | 'unknown';
  createdAt: string; updatedAt: string; summary: string; outcome: ExecutionOutcome | PlanningOutcome | null;
  inputFiles: TaskFileDescriptor[]; outputFiles: TaskFileDescriptor[]; error: string | null;
  context: WorkflowExecutionContext; handled: boolean;
  resultDelivery?: 'on-demand';
  clarifications?: { requestID: string; questions: string[]; answers: string[][] }[];
  localConfig?: { projectID: string; model: string };
};
export type WorkflowStep = WorkflowStepPlan & {
  state: 'waiting' | 'ready' | 'running' | 'completed' | 'failed' | 'cancelled' | 'blocked';
  attempts: WorkflowAttempt[]; checkpoint: string; queryRounds: number; validationRounds?: number;
  materials: TaskFileDescriptor[]; evidence: string;
  continuation: { nodeID: string | null; reason: string; handoff: boolean } | null;
  retries?: { requestID: string; attempt: number }[];
};
export type WorkflowEvent = { id: number; kind: 'plan' | 'query' | 'handoff' | 'state' | 'error'; text: string; stepID: string | null; at: string };
export type WorkflowHandoff = {
  id: string; stepID: string; fromAttempt: number; toAttempt: number; fromNodeID: string; toNodeID: string;
  reason: string; phase: 'preparing' | 'waiting_stop' | 'transferring' | 'queued' | 'completed' | 'blocked'; at: string;
};
export type WorkflowMessage = {
  requestID: string; text: string; inputFiles: TaskFileDescriptor[]; createdAt: string;
  state: 'queued' | 'cancelled';
};
export type WorkflowRound = Pick<Workflow, 'description' | 'criteria' | 'state' | 'planVersion' | 'summary' | 'planner' |
  'steps' | 'events' | 'handoffs' | 'inputFiles' | 'confirmations' | 'pendingConfirmation' | 'updatedAt' | 'error'> & {
  requestID: string; createdAt: string;
};
export type Workflow = {
  id: string; requestID: string; contentDigest: string; creatorID: string; title: string; description: string; criteria: string;
  projectID: string | null; model: string | null; approvalMode: ApprovalMode; target: WorkflowTarget;
  state: 'planning' | 'running' | 'paused' | 'stopping' | 'stopped' | 'completed' | 'failed';
  version: number; planVersion: number; summary: string; planner: WorkflowStep; steps: WorkflowStep[];
  events: WorkflowEvent[]; handoffs: WorkflowHandoff[]; inputFiles: TaskFileDescriptor[];
  confirmations: { nodeID: string; confirmedAt: string }[];
  pendingConfirmation: { nodeID: string; stepID: string; waitingCount: number } | null;
  createdAt: string; updatedAt: string; error: string | null;
  rounds?: WorkflowRound[]; messages?: WorkflowMessage[]; roundRequestID?: string; roundCreatedAt?: string;
  queuePaused?: boolean; queueError?: string; conversationContextFile?: TaskFileDescriptor;
};
export function workflowAllSteps(value: Workflow): WorkflowStep[] {
  return [...(value.rounds || []).flatMap((round) => [round.planner, ...round.steps]), value.planner, ...value.steps];
}
export function workflowPendingMessages(value: Pick<Workflow, 'messages' | 'roundRequestID' | 'rounds'>): WorkflowMessage[] {
  const started = new Set([value.roundRequestID, ...(value.rounds || []).map((r) => r.requestID)]);
  return (value.messages || []).filter((m) => m.state === 'queued' && !started.has(m.requestID));
}
export function validWorkflowTarget(value: unknown): value is WorkflowTarget {
  return record(value) && (value.mode === 'automatic' ? keys(value, ['mode']) :
    ['preferred', 'locked'].includes(String(value.mode)) && keys(value, ['mode', 'nodeID']) && nodeID(value.nodeID));
}
export function canRetryWorkflowPlanning(value: Workflow): boolean {
  const last = value.planner.attempts.at(-1);
  return value.state === 'failed' && value.planVersion === 0 && value.steps.length === 0 &&
    value.planner.state === 'failed' && !!last && last.handled && ['completed', 'failed'].includes(last.phase) &&
    value.planner.attempts.length < 16;
}
export function canRetryWorkflowStep(value: Workflow, step: WorkflowStep): boolean {
  return value.state === 'failed' && value.planVersion > 0 && value.steps.includes(step) && step.state === 'failed' &&
    step.attempts.length < 16 && (step.retries?.length || 0) < 16 && [value.planner, ...value.steps].every((s) => s.attempts.every((a) =>
      a.handled && ['completed', 'failed', 'stopped'].includes(a.phase)));
}
const stepID = (value: unknown): value is string => text(value, 48) && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value);
export function validHardwareRequirements(value: unknown): value is TaskHardwareRequirements {
  if (!record(value) || !keys(value, [], ['platform', 'architecture', 'minimumLogicalCores', 'minimumMemoryBytes', 'gpu', 'minimumGpuMemoryBytes'])) return false;
  return (!Object.hasOwn(value, 'platform') || text(value.platform, 40)) &&
    (!Object.hasOwn(value, 'architecture') || text(value.architecture, 40)) &&
    (!Object.hasOwn(value, 'gpu') || typeof value.gpu === 'boolean') &&
    (!Object.hasOwn(value, 'minimumLogicalCores') || integer(value.minimumLogicalCores, 4096, 1)) &&
    ['minimumMemoryBytes', 'minimumGpuMemoryBytes'].every((key) => !Object.hasOwn(value, key) || integer(value[key], Number.MAX_SAFE_INTEGER, 1));
}
export function validWorkflowStepPlan(value: unknown): value is WorkflowStepPlan {
  return record(value) && keys(value, ['id', 'title', 'instructions', 'dependsOn', 'nodeID', 'resources', 'software', 'requirements']) &&
    stepID(value.id) && text(value.title, 160) && text(value.instructions, 12_000) &&
    uniqueStrings(value.dependsOn, 31, 48) && value.dependsOn.every(stepID) &&
    (value.nodeID === null || nodeID(value.nodeID)) && Array.isArray(value.resources) && value.resources.length <= 10 &&
    value.resources.every(validResourceReference) && uniqueStrings(value.software, 16, 200) && validHardwareRequirements(value.requirements);
}
export function workflowPlanError(value: unknown, target: WorkflowTarget = { mode: 'automatic' }): string | null {
  if (!record(value) || jsonBytes(value) > 48_000 || !keys(value, ['summary', 'steps']) || !text(value.summary, 2000) ||
    !Array.isArray(value.steps) || !value.steps.length || value.steps.length > 32 || !value.steps.every(validWorkflowStepPlan))
    return 'invalid_plan';
  const steps = value.steps;
  const byID = new Map(steps.map((step) => [step.id, step]));
  if (byID.size !== steps.length) return 'duplicate_step';
  if (steps.some((step) => step.dependsOn.some((id) => !byID.has(id)))) return 'missing_dependency';
  if (target.mode === 'locked' && steps.some((step) => step.nodeID !== null && step.nodeID !== target.nodeID)) return 'locked_target';
  const visited = new Set<string>();
  const visiting = new Set<string>();
  function cyclic(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if (byID.get(id)!.dependsOn.some(cyclic)) return true;
    visiting.delete(id); visited.add(id); return false;
  }
  return steps.some((step) => cyclic(step.id)) ? 'dependency_cycle' : null;
}
export function validWorkflowPlan(value: unknown): value is WorkflowPlan { return workflowPlanError(value) === null; }
export function validPlanningOutcome(value: unknown): value is PlanningOutcome {
  return record(value) && (value.kind === 'plan' ? keys(value, ['kind', 'plan']) && validWorkflowPlan(value.plan) :
    value.kind === 'query' && keys(value, ['kind', 'query', 'reason']) && validResourceQuery(value.query) && text(value.reason, 1000));
}
export function validExecutionOutcome(value: unknown): value is ExecutionOutcome {
  if (!record(value) || jsonBytes(value) > 48_000 || !uniqueStrings(value.files, 5, 512) ||
    !value.files.every(validWorkflowOutputPath)) return false;
  if (value.kind === 'completed') return keys(value, ['kind', 'summary', 'files']) && text(value.summary, 12_000);
  if (!text(value.checkpoint, 12_000, 0)) return false;
  if (value.kind === 'expand') return keys(value, ['kind', 'plan', 'checkpoint', 'files']) && validWorkflowPlan(value.plan);
  if (!text(value.reason, 1000)) return false;
  if (value.kind === 'query') return keys(value, ['kind', 'query', 'reason', 'checkpoint', 'files']) && validResourceQuery(value.query);
  if (value.kind === 'resources') return keys(value, ['kind', 'resources', 'reason', 'checkpoint', 'files']) &&
    Array.isArray(value.resources) && value.resources.length > 0 && value.resources.length <= 10 && value.resources.every(validResourceReference);
  return value.kind === 'handoff' && keys(value, ['kind', 'nodeID', 'reason', 'checkpoint', 'files', 'processesStopped']) &&
    (value.nodeID === null || nodeID(value.nodeID)) && typeof value.processesStopped === 'boolean';
}
export function validWorkflowExecutionContext(value: unknown): value is WorkflowExecutionContext {
  return record(value) && jsonBytes(value) <= 56_000 && keys(value, ['workflowID', 'stepID', 'attempt', 'role', 'target', 'instructions', 'evidence', 'priorContext']) &&
    uuid(value.workflowID) && stepID(value.stepID) && integer(value.attempt, 16, 1) &&
    ['planner', 'executor'].includes(String(value.role)) && validWorkflowTarget(value.target) &&
    text(value.instructions, 16_500) && text(value.evidence, 28_000, 0) && text(value.priorContext, 16_000, 0);
}
export function validWorkflowOutputPath(value: string): boolean {
  return !/[\u0000-\u001f<>:"|?*]/.test(value) && !/^[\\/]/.test(value) &&
    value.split(/[\\/]/).every((part) => !!part && part !== '.' && part !== '..' && !/[. ]$/.test(part));
}
export function validWorkflowIdentity(value: unknown): boolean {
  return record(value) && uuid(value.id) && uuid(value.requestID) && digest(value.contentDigest) &&
    text(value.creatorID, 100) && integer(value.version, Number.MAX_SAFE_INTEGER, 1) &&
    timestamp(value.createdAt) && timestamp(value.updatedAt) && validWorkflowTarget(value.target);
}
