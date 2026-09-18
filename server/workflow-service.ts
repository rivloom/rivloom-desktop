import { randomUUID } from 'node:crypto';
import { jsonBytes, uuid } from '../shared/collaboration.ts';
import { taskFileBatchBytes, taskFileMaximumCount, taskFileUploadCount, validTaskFileManifest, sameTaskFile, type TaskFileDescriptor } from '../shared/task-files.ts';
import { canRetryWorkflowPlanning, canRetryWorkflowStep, validExecutionOutcome, validPlanningOutcome, validWorkflowExecutionContext, workflowPlanError, workflowPendingMessages, workflowAllSteps,
  type Workflow, type WorkflowAttempt, type WorkflowExecutionContext, type WorkflowPlan, type WorkflowStep, type WorkflowStepPlan } from '../shared/workflows.ts';
import type { ResourceQuery, ResourceReference } from '../shared/resources.ts';
import { workflowCandidateAllowed } from '../shared/workflow-diagnostics.ts';
import { WorkflowStore, workflowEvent, workflowStep, type WorkflowRequest } from './workflows.ts';

export type WorkflowCandidate = { nodeID: string; kind: 'local' | 'remote'; waitingCount: number; resultDelivery?: 'on-demand'; localConfig?: { projectID: string; model: string } };
export type WorkflowExecutionSnapshot = {
  phase: Exclude<WorkflowAttempt['phase'], 'intent'>; summary: string; error: string | null;
  outcome: WorkflowAttempt['outcome']; outputFiles: TaskFileDescriptor[]; safeToTransfer: boolean;
};
export type WorkflowDispatchResult = { state: 'accepted' } | { state: 'confirmation'; waitingCount: number } |
  { state: 'blocked' | 'uncertain'; reason: string };
export interface WorkflowExecutionAdapter {
  candidates(workflow: Workflow, step: WorkflowStep, role: WorkflowExecutionContext['role']): WorkflowCandidate[];
  evidence(workflow: Workflow): string;
  lookup(workflow: Workflow, attempt: WorkflowAttempt): Promise<WorkflowExecutionSnapshot | null>;
  /** Implementations must reuse executionID and check mayStart immediately before durable admission. */
  dispatch(workflow: Workflow, step: WorkflowStep, attempt: WorkflowAttempt, mayStart: () => boolean): Promise<WorkflowDispatchResult>;
  stop(workflow: Workflow, attempt: WorkflowAttempt): Promise<'stopped' | 'unknown'>;
  query(workflow: Workflow, query: ResourceQuery): Promise<unknown>;
  materialize(workflow: Workflow, references: ResourceReference[]): Promise<TaskFileDescriptor[]>;
  stageInputs(workflow: Workflow, key: string, files: TaskFileDescriptor[], mayRead: () => boolean): Promise<TaskFileDescriptor[]>;
  conversationContext?(workflow: Workflow): Promise<TaskFileDescriptor>;
  retryReady?(workflow: Workflow, attempt: WorkflowAttempt): Promise<boolean>;
  prepareInputs?(workflow: Workflow, files: TaskFileDescriptor[], role: WorkflowExecutionContext['role'], required: TaskFileDescriptor[]): Promise<TaskFileDescriptor[] | null>;
}
const terminalAttempt = (attempt: WorkflowAttempt) => ['completed', 'failed', 'stopped'].includes(attempt.phase);
const terminalStep = (step: WorkflowStep) => ['completed', 'failed', 'cancelled', 'blocked'].includes(step.state);
const terminalWorkflow = (workflow: Workflow) => ['stopped', 'completed', 'failed'].includes(workflow.state);
const getStep = (workflow: Workflow, id: string) => id === 'planner' ? workflow.planner : workflow.steps.find((step) => step.id === id);
function currentStep(workflow: Workflow, stepID: string, executionID: string) {
  const step = getStep(workflow, stepID);
  return step?.attempts.at(-1)?.executionID === executionID ? step : null;
}
function boundedText(value: string, characters: number, bytes: number): string {
  let result = value.slice(0, characters);
  while (jsonBytes(result) > bytes) result = result.slice(0, Math.floor(result.length * 0.85));
  return result;
}
function mergeFiles(...groups: TaskFileDescriptor[][]): TaskFileDescriptor[] {
  const files = new Map<string, TaskFileDescriptor>();
  for (const group of groups) for (const file of group) {
    const previous = files.get(file.id);
    if (previous && !sameTaskFile(previous, file)) throw new Error('workflow_file_identity_conflict');
    files.set(file.id, file);
  }
  const result = [...files.values()];
  if (result.length > taskFileMaximumCount || result.reduce((sum, file) => sum + file.bytes, 0) > taskFileBatchBytes)
    throw new Error('workflow_input_quota');
  return result;
}
/** Drives stable logical steps through existing durable queues. It never starts model sessions itself. */
export class WorkflowService {
  readonly store: WorkflowStore;
  private adapter: WorkflowExecutionAdapter;
  private onChange: () => void;
  private advancing = new Map<string, Promise<void>>();
  private preparing = new Map<symbol, string>();
  private preparationDetails = new Map<string, { stepID: string; plan: string; round: string; nodeID: string; observedAt: string; active: boolean }>();
  private assignedByWorkflow = new Map<string, string[]>();
  private assigned = new Map<string, number>();
  private closed = false;
  isAdvancing(id: string) { return this.advancing.has(id); }
  preparation(value: Workflow, step: WorkflowStep) {
    const detail = this.preparationDetails.get(`${value.id}:${step.id}`);
    return step.state === 'ready' && detail?.plan === JSON.stringify(planFields(step)) && detail.round === (value.roundRequestID || value.requestID) &&
      (detail.active || Date.now() - Date.parse(detail.observedAt) < 15_000) ? { nodeID: detail.nodeID, observedAt: detail.observedAt } : null;
  }
  constructor(store: WorkflowStore, adapter: WorkflowExecutionAdapter, onChange: () => void = () => {}) {
    this.store = store; this.adapter = adapter; this.onChange = onChange;
    for (const value of store.list()) this.trackAssignments(value);
  }
  private update(id: string, change: (workflow: Workflow) => void, version?: number) {
    const result = this.store.update(id, (value) => {
      const before = value.state; change(value);
      if (value.state !== before && ['failed', 'stopped'].includes(value.state)) value.queuePaused = true;
    }, version);
    for (const [key, detail] of this.preparationDetails) if (key.startsWith(`${id}:`)) {
      const step = getStep(result, detail.stepID);
      if (!step || step.state !== 'ready' || JSON.stringify(planFields(step)) !== detail.plan ||
        detail.round !== (result.roundRequestID || result.requestID)) this.preparationDetails.delete(key);
    }
    this.trackAssignments(result); this.onChange(); return result;
  }
  /** Durable intents remain load until their execution is known to have ended, including after restart. */
  private trackAssignments(value: Workflow) {
    for (const nodeID of this.assignedByWorkflow.get(value.id) || []) {
      const count = (this.assigned.get(nodeID) || 0) - 1;
      if (count) this.assigned.set(nodeID, count); else this.assigned.delete(nodeID);
    }
    const nodes = [value.planner, ...value.steps].flatMap((step) => step.attempts.filter((attempt) => !terminalAttempt(attempt)).map((attempt) => attempt.nodeID));
    if (nodes.length) this.assignedByWorkflow.set(value.id, nodes); else this.assignedByWorkflow.delete(value.id);
    for (const nodeID of nodes) this.assigned.set(nodeID, (this.assigned.get(nodeID) || 0) + 1);
  }
  private candidates(value: Workflow, step: WorkflowStep) {
    return this.adapter.candidates(value, step, step.id === 'planner' ? 'planner' : 'executor')
      .filter((candidate) => workflowCandidateAllowed(value, step, candidate.nodeID));
  }
  private selectCandidate(value: Workflow, step: WorkflowStep, reservation: symbol) {
    const preparing = new Map<string, number>();
    for (const [key, nodeID] of this.preparing) if (key !== reservation) preparing.set(nodeID, (preparing.get(nodeID) || 0) + 1);
    const preferred = step.nodeID || (value.target.mode === 'preferred' ? value.target.nodeID : null);
    return this.candidates(value, step).map((candidate) => ({ ...candidate,
      // Reports can lag our own admissions. Use known executions as a floor, avoiding double-counting acknowledged queue entries.
      waitingCount: Math.max(candidate.waitingCount, this.assigned.get(candidate.nodeID) || 0) + (preparing.get(candidate.nodeID) || 0),
    })).sort((a, b) => a.waitingCount - b.waitingCount || Number(b.nodeID === preferred) - Number(a.nodeID === preferred))[0];
  }
  create(request: WorkflowRequest) { const value = this.store.create(request); this.onChange(); return value; }
  recordAnswers(executionID: string, requestID: string, questions: string[], answers: string[][]) {
    const value = this.store.list().find((w) => workflowAllSteps(w).some((s) => s.attempts.some((a) => a.executionID === executionID)));
    if (!value || !questions.length || questions.length !== answers.length) return;
    this.update(value.id, (latest) => {
      const attempt = workflowAllSteps(latest).flatMap((s) => s.attempts).find((a) => a.executionID === executionID)!;
      attempt.clarifications = [...(attempt.clarifications || []).filter((v) => v.requestID !== requestID), { requestID, questions, answers }];
    });
  }
  enqueue(id: string, requestID: string, text: string, inputFiles: TaskFileDescriptor[]) {
    if (!uuid(requestID) || !text.trim() || text.length > 12_000 || !validTaskFileManifest(inputFiles) || inputFiles.length > taskFileUploadCount)
      throw new Error('invalid_workflow_request');
    return this.update(id, (value) => {
      const previous = value.messages?.find((m) => m.requestID === requestID);
      const round = value.rounds?.find((r) => r.requestID === requestID);
      if (previous) {
        if (previous.text !== text || JSON.stringify(previous.inputFiles) !== JSON.stringify(inputFiles)) throw new Error('workflow_request_conflict');
        return;
      }
      if (round || value.requestID === requestID || value.roundRequestID === requestID) throw new Error('workflow_request_conflict');
      if (workflowPendingMessages(value).length >= 50) throw new Error('workflow_message_queue_full');
      (value.messages ||= []).push({ requestID, text, inputFiles: structuredClone(inputFiles), createdAt: new Date().toISOString(), state: 'queued' });
      if (['failed', 'stopped', 'stopping'].includes(value.state)) value.queuePaused = true;
    });
  }
  messageControl(id: string, action: 'cancel' | 'resume' | 'pause', requestID?: string) {
    return this.update(id, (value) => {
      if (action === 'cancel') {
        const message = value.messages?.find((m) => m.requestID === requestID);
        if (!message || message.requestID === value.roundRequestID || value.rounds?.some((r) => r.requestID === requestID)) throw new Error('workflow_message_started');
        message.state = 'cancelled';
      } else { value.queuePaused = action === 'pause'; value.queueError = undefined; }
    });
  }
  control(id: string, action: 'pause' | 'resume' | 'stop' | 'retry_planning') {
    return this.update(id, (value) => {
      if (action === 'retry_planning') {
        if (!canRetryWorkflowPlanning(value)) throw new Error('workflow_invalid_control');
        value.state = 'planning'; value.error = null; value.pendingConfirmation = null;
        value.planner.state = 'ready'; value.planner.validationRounds = 0; value.planner.queryRounds = 0; value.planner.evidence = '';
        value.planner.continuation = { nodeID: value.planner.attempts.at(-1)!.nodeID, reason: 'Retry planning', handoff: false };
        workflowEvent(value, 'state', value.state); return;
      }
      if (terminalWorkflow(value)) throw new Error('workflow_already_finished');
      if (action === 'pause' && ['planning', 'running'].includes(value.state)) value.state = 'paused';
      else if (action === 'resume' && value.state === 'paused') value.state = value.planVersion ? 'running' : 'planning';
      else if (action === 'stop') { value.state = 'stopping'; value.pendingConfirmation = null; value.queuePaused = true; }
      else throw new Error('workflow_invalid_control');
      workflowEvent(value, 'state', value.state);
    });
  }
  confirm(id: string, nodeID: string) {
    return this.update(id, (value) => {
      if (value.pendingConfirmation?.nodeID !== nodeID || terminalWorkflow(value) || value.state === 'stopping')
        throw new Error('workflow_confirmation_changed');
      value.confirmations = value.confirmations.filter((item) => item.nodeID !== nodeID);
      value.confirmations.push({ nodeID, confirmedAt: new Date().toISOString() }); value.pendingConfirmation = null;
    });
  }
  async retryStep(id: string, request: { version: number; roundRequestID: string; stepID: string; attempt: number; requestID: string }) {
    const value = this.store.get(id);
    if (!value || (value.roundRequestID || value.requestID) !== request.roundRequestID || !uuid(request.requestID)) throw new Error('workflow_retry_changed');
    const step = value.steps.find((s) => s.id === request.stepID);
    const receipt = step?.retries?.find((r) => r.requestID === request.requestID);
    if (receipt) {
      if (receipt.attempt !== request.attempt) throw new Error('workflow_retry_changed');
      return value;
    }
    if (!step || value.version !== request.version || step.attempts.length !== request.attempt || !canRetryWorkflowStep(value, step))
      throw new Error('workflow_retry_changed');
    const descendants = new Set([step.id]);
    for (let i = 0; i < value.steps.length; i++) for (const other of value.steps)
      if (other.dependsOn.some((parent) => descendants.has(parent))) descendants.add(other.id);
    if (value.steps.some((s) => s.id !== step.id && descendants.has(s.id) && s.attempts.length)) throw new Error('workflow_retry_changed');
    const last = step.attempts.at(-1);
    if (last && !(await this.adapter.retryReady?.(value, last))) throw new Error('workflow_retry_unconfirmed');
    return this.update(id, (current) => {
      if (this.closed || (current.roundRequestID || current.requestID) !== request.roundRequestID) throw new Error('workflow_retry_changed');
      const failed = current.steps.find((s) => s.id === step.id)!;
      if (!canRetryWorkflowStep(current, failed)) throw new Error('workflow_retry_changed');
      (failed.retries ||= []).push({ requestID: request.requestID, attempt: request.attempt });
      failed.state = 'ready'; failed.continuation = null; failed.queryRounds = 0;
      for (const next of current.steps) if (next.state === 'blocked' && descendants.has(next.id)) next.state = 'waiting';
      current.state = 'running'; current.error = null; current.pendingConfirmation = null;
      workflowEvent(current, 'state', 'Step retried', failed.id);
    }, request.version);
  }
  editStep(id: string, version: number, replacement: WorkflowStepPlan) {
    return this.update(id, (value) => {
      if (!['running', 'paused'].includes(value.state)) throw new Error('workflow_not_editable');
      const step = value.steps.find((step) => step.id === replacement.id);
      if (!step || step.attempts.length || terminalStep(step)) throw new Error('workflow_step_started');
      const next = value.steps.map((s) => s.id === replacement.id ? replacement : s);
      // Only plan fields belong in validation, never internal execution state.
      const plan = { summary: value.summary, steps: next.map(planFields) };
      const error = workflowPlanError(plan, value.target);
      if (error) throw new Error(error);
      Object.assign(step, structuredClone(replacement)); value.planVersion++;
      workflowEvent(value, 'plan', 'Step updated', step.id);
    }, version);
  }
  advance(id: string): Promise<void> {
    const previous = this.advancing.get(id);
    if (previous) return previous;
    const pending = this.advanceOne(id).finally(() => this.advancing.delete(id));
    this.advancing.set(id, pending); return pending;
  }
  async tick() {
    const ids = this.store.list().filter((w) => !terminalWorkflow(w) || this.nextMessage(w)).map((w) => w.id);
    for (let start = 0; start < ids.length && !this.closed; start += 4)
      await Promise.allSettled(ids.slice(start, start + 4).map((id) => this.advance(id)));
  }
  async close() { this.closed = true; await Promise.allSettled([...this.advancing.values()]); this.preparationDetails.clear(); }
  private mayStart(id: string, stepID: string, executionID?: string) {
    if (this.closed) return false;
    const value = this.store.get(id);
    return !!value && ['planning', 'running'].includes(value.state) &&
      (executionID ? !!currentStep(value, stepID, executionID) : getStep(value, stepID)?.state === 'ready');
  }
  private async advanceOne(id: string) {
    let value = this.store.get(id);
    if (!value || this.closed) return;
    if (terminalWorkflow(value)) { await this.advanceRound(value); return; }
    this.trackAssignments(value);
    if (value.state === 'stopping') { await this.stopAll(value); return; }
    const steps = value.planVersion ? value.steps : [value.planner];
    await Promise.all(steps.filter((step) => step.state === 'running').map((step) => this.reconcile(value!, step)));
    value = this.store.get(id)!;
    if (value.state === 'stopping') { await this.stopAll(value); return; }
    if (terminalWorkflow(value)) return;
    if (value.planVersion) this.settle(id);
    value = this.store.get(id)!;
    if (!['planning', 'running'].includes(value.state)) return;
    await Promise.all((value.planVersion ? value.steps : [value.planner]).filter((step) => step.state === 'ready')
      .map((step) => this.prepare(value!, step)));
  }
  private nextMessage(value: Workflow) {
    if (value.queuePaused || value.queueError) return undefined;
    return workflowPendingMessages(value)[0];
  }
  private async advanceRound(value: Workflow) {
    const message = this.nextMessage(value);
    if (!message || [value.planner, ...value.steps].some((s) => s.attempts.some((a) => !terminalAttempt(a) || !a.handled))) return;
    try {
      // Preparation is repeatable; the atomic archive/reset below is the only admission point.
      const context = await this.adapter.conversationContext?.(value);
      const inherited = new Map<string, TaskFileDescriptor>();
      for (const file of [...value.inputFiles.filter((f) => f.id !== value.conversationContextFile?.id),
        ...value.steps.flatMap((s) => s.attempts.at(-1)?.outputFiles || []), ...message.inputFiles]) inherited.set(file.name, file);
      const inputFiles = mergeFiles([...inherited.values()], context ? [context] : []);
      this.update(value.id, (latest) => {
        if (!terminalWorkflow(latest) || this.nextMessage(latest)?.requestID !== message.requestID || this.closed) return;
        const { description, criteria, state, planVersion, summary, planner, steps, events, handoffs, confirmations, pendingConfirmation, updatedAt, error } = latest;
        (latest.rounds ||= []).push({ description, criteria, state, planVersion, summary, planner, steps, events, handoffs, confirmations, pendingConfirmation, updatedAt, error,
          inputFiles: latest.inputFiles, requestID: latest.roundRequestID || latest.requestID, createdAt: latest.roundCreatedAt || latest.createdAt });
        latest.roundRequestID = message.requestID; latest.roundCreatedAt = message.createdAt;
        latest.description = message.text; latest.inputFiles = inputFiles; latest.conversationContextFile = context;
        latest.state = 'planning'; latest.planVersion = 0; latest.summary = ''; latest.steps = []; latest.events = []; latest.handoffs = [];
        latest.confirmations = []; latest.pendingConfirmation = null; latest.error = null; latest.queueError = undefined;
        latest.planner = workflowStep({ id: 'planner', title: latest.title, instructions: message.text + (latest.criteria ? `\n\n完成要求：\n${latest.criteria}` : ''),
          dependsOn: [], nodeID: null, resources: [], software: [], requirements: {} });
      });
    } catch (error) {
      this.update(value.id, (latest) => { latest.queuePaused = true; latest.queueError = error instanceof Error ? error.message : 'workflow_context_failed'; });
    }
  }
  private async stopAll(value: Workflow) {
    await Promise.all([value.planner, ...value.steps].map(async (step) => {
      const attempt = step.attempts.at(-1);
      if (attempt && !terminalAttempt(attempt)) {
        let state: 'stopped' | 'unknown' = 'unknown';
        try { state = await this.adapter.stop(value, attempt); } catch { /* Keep the uncertain stop visible. */ }
        this.update(value.id, (latest) => {
          const current = currentStep(latest, step.id, attempt.executionID);
          if (!current) return;
          const execution = current.attempts.at(-1)!; execution.phase = state; execution.updatedAt = new Date().toISOString();
          if (state === 'stopped') { execution.handled = true; current.state = 'cancelled'; }
          else { execution.error = 'workflow_stop_unconfirmed'; latest.error = execution.error; }
        });
      } else if (!terminalStep(step)) this.update(value.id, (latest) => { getStep(latest, step.id)!.state = 'cancelled'; });
    }));
    const latest = this.store.get(value.id)!;
    if ([latest.planner, ...latest.steps].every((step) => !step.attempts.length || terminalAttempt(step.attempts.at(-1)!)))
      this.update(value.id, (current) => { current.state = 'stopped'; current.error = null; workflowEvent(current, 'state', 'stopped'); });
  }
  private settle(id: string) {
    const value = this.store.get(id)!;
    if (terminalWorkflow(value) || value.state === 'stopping') return;
    const stateBefore = JSON.stringify([value.state, value.steps.map((s) => s.state)]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const step of value.steps) if (['waiting', 'ready'].includes(step.state)) {
        const parents = step.dependsOn.map((id) => value.steps.find((s) => s.id === id)!);
        const next = parents.some((p) => ['failed', 'cancelled', 'blocked'].includes(p.state)) ? 'blocked' :
          parents.every((p) => p.state === 'completed') ? 'ready' : 'waiting';
        if (next !== step.state) { step.state = next; changed = true; }
      }
    }
    if (value.steps.every(terminalStep) && value.state !== 'paused') {
      value.state = value.steps.every((s) => s.state === 'completed') ? 'completed' : 'failed';
      value.error = value.state === 'failed' ? value.steps.flatMap((s) => s.attempts).findLast((a) => a.error)?.error || value.error || 'workflow_dependency_failed' : null;
    }
    if (stateBefore !== JSON.stringify([value.state, value.steps.map((s) => s.state)])) this.update(id, (latest) => {
      latest.steps.forEach((step, i) => { step.state = value.steps[i].state; }); latest.state = value.state; latest.error = value.error;
      if (latest.state === 'failed') latest.queuePaused = true;
      if (terminalWorkflow(latest)) workflowEvent(latest, 'state', latest.state);
    }, value.version);
  }
  private async prepare(value: Workflow, step: WorkflowStep) {
    const reservation = Symbol(step.id);
    const preparationKey = `${value.id}:${step.id}`;
    let waitingForInputs = false;
    this.preparationDetails.delete(preparationKey);
    const observe = (current: Workflow, nodeID: string) => this.preparationDetails.set(preparationKey,
      { stepID: step.id, plan: JSON.stringify(planFields(step)), round: current.roundRequestID || current.requestID,
        nodeID, observedAt: new Date().toISOString(), active: true });
    try {
      const role = step.id === 'planner' ? 'planner' : 'executor';
      const continuation = step.continuation;
      let candidate = this.selectCandidate(value, step, reservation);
      if (!candidate || !this.mayStart(value.id, step.id)) return;
      if (candidate.waitingCount >= 10 && !value.confirmations.some((c) => c.nodeID === candidate.nodeID)) {
        this.confirmation(value.id, step.id, candidate.nodeID, candidate.waitingCount); return;
      }
      // Synchronous reservation covers input I/O; a persisted intent takes over before remote admission awaits its ACK.
      this.preparing.set(reservation, candidate.nodeID);
      observe(value, candidate.nodeID);
      const resources = step.resources.length ? await this.adapter.materialize(value, step.resources) : [];
      if (!this.mayStart(value.id, step.id)) return;
      // An unstarted step can be edited while material retrieval is awaiting I/O.
      // Discard this preparation so the next tick uses the newly saved requirements.
      const prepared = this.store.get(value.id)!;
      const preparedStep = getStep(prepared, step.id);
      if (!preparedStep || JSON.stringify(planFields(preparedStep)) !== JSON.stringify(planFields(step))) return;
      candidate = this.selectCandidate(prepared, preparedStep, reservation);
      if (!candidate) return;
      if (candidate.waitingCount >= 10 && !prepared.confirmations.some((c) => c.nodeID === candidate.nodeID)) {
        this.confirmation(value.id, step.id, candidate.nodeID, candidate.waitingCount); return;
      }
      this.preparing.set(reservation, candidate.nodeID);
      observe(prepared, candidate.nodeID);
      const parents = step.dependsOn.map((id) => value.steps.find((s) => s.id === id)!);
      let originalFiles = mergeFiles(value.inputFiles, step.materials, resources, ...parents.map((p) => p.attempts.at(-1)?.outputFiles || []));
      if (this.adapter.prepareInputs) {
        const ready = await this.adapter.prepareInputs(value, originalFiles, role,
          [...step.materials, ...resources, ...parents.flatMap((p) => p.attempts.at(-1)?.outputFiles || [])]);
        if (!ready) { waitingForInputs = true; return; }
        originalFiles = ready;
      }
      const inputFiles = candidate.kind === 'remote' && originalFiles.length
        ? await this.adapter.stageInputs(value, `${value.roundRequestID || value.requestID}:${step.id}:${step.attempts.length + 1}:${candidate.nodeID}`, originalFiles, () => this.mayStart(value.id, step.id))
        : originalFiles;
      if (!this.mayStart(value.id, step.id) || JSON.stringify(planFields(getStep(this.store.get(value.id)!, step.id)!)) !== JSON.stringify(planFields(step))) return;
      if (!this.candidates(this.store.get(value.id)!, step).some((c) => c.nodeID === candidate.nodeID)) return;
      const evidence = boundedText([this.adapter.evidence(value), step.evidence].filter(Boolean).join('\n\n'), 12_000, 18_000);
      const correction = role === 'planner' && step.validationRounds
        ? `上次只读规划未通过 JSON 格式校验。这是第 ${step.validationRounds}/2 次格式纠正；尚未执行业务步骤。重新按原需求返回一个且仅一个完整 JSON 对象。检查资源引用与文件/软件区别；无输入文件用 resources:[]；缺少事实只返回 query，已有事实只返回 plan。` : '';
      const location = (value.conversationContextFile ? `这是同一会话的后续请求。先读取输入文件 ${value.conversationContextFile.name}，其中包含此前各轮完整需求、结果与文件记录；保留适用约束，从已有成果继续修改。远端成果默认保留在记录中的 Node；不要假设已下载为附件。若确实需要跨 Node 读取，先查询资源目录并用 resources 请求对应文件；不需要文件内容时只使用结果记录。\n` : '') +
        `本次实际执行 Node：${candidate.nodeID}。这是当前步骤的第 ${step.attempts.length + 1} 次尝试。` +
        (continuation?.handoff ? '本次接收上一个 Node 的转交；从下方已保存检查点继续，不重复源端已完成的操作，不再次转交给自己。' : '');
      const originalRequest = role === 'executor' ? `用户完整需求（本步骤及后续转交都必须遵守其中适用的约束；只执行当前步骤）：\n${value.planner.instructions}` : '';
      if (location.length + originalRequest.length + 4 > 16_000) throw new Error('workflow_context_limit');
      let progress = boundedText([correction, step.checkpoint, ...parents.map((p) => `${p.title}\n${p.checkpoint}`)].filter(Boolean).join('\n\n'),
        Math.min(8000, Math.max(0, 16_000 - location.length - originalRequest.length - 4)), 12_000);
      const priorContext = [location, originalRequest, progress].filter(Boolean).join('\n\n');
      const context: WorkflowExecutionContext = { workflowID: value.id, stepID: step.id, attempt: step.attempts.length + 1,
        role, target: value.target, instructions: continuation?.handoff && step.checkpoint ? step.checkpoint : step.instructions, evidence, priorContext };
      // Preserve the actual request; reduce supporting evidence to fit the authenticated channel in UTF-8.
      while (jsonBytes({ executionID: '0'.repeat(36), context, inputFiles }) > 58_000 || jsonBytes(context) > 55_000) {
        if (context.evidence.length > 100) context.evidence = context.evidence.slice(0, Math.floor(context.evidence.length * 0.8));
        else if (progress.length > 100) {
          progress = progress.slice(0, Math.floor(progress.length * 0.8));
          context.priorContext = [location, originalRequest, progress].filter(Boolean).join('\n\n');
        }
        else throw new Error('workflow_context_limit');
      }
      if (!validWorkflowExecutionContext(context)) throw new Error('workflow_context_limit');
      const at = new Date().toISOString();
      const attempt: WorkflowAttempt = { number: context.attempt, executionID: randomUUID(), nodeID: candidate.nodeID, kind: candidate.kind,
        ...(candidate.resultDelivery ? { resultDelivery: candidate.resultDelivery } : {}),
        ...(candidate.localConfig ? { localConfig: candidate.localConfig } : {}), phase: 'intent',
        context, createdAt: at, updatedAt: at, summary: '', outcome: null, inputFiles, outputFiles: [], error: null, handled: false };
      const saved = this.update(value.id, (latest) => {
        const current = getStep(latest, step.id)!;
        if (!['planning', 'running'].includes(latest.state) || current.state !== 'ready') throw new Error('workflow_dispatch_cancelled');
        if (current.continuation?.handoff) {
          const previous = current.attempts.at(-1)!;
          latest.handoffs.push({ id: randomUUID(), stepID: step.id, fromAttempt: previous.number, toAttempt: attempt.number,
            fromNodeID: previous.nodeID, toNodeID: attempt.nodeID, reason: current.continuation.reason, phase: 'transferring', at });
          workflowEvent(latest, 'handoff', current.continuation.reason, step.id);
        }
        current.state = 'running'; current.attempts.push(attempt); current.continuation = null;
      });
      this.preparing.delete(reservation);
      await this.dispatch(saved, getStep(saved, step.id)!, attempt);
    } catch (error) {
      const latest = this.store.get(value.id);
      if (latest && this.mayStart(value.id, step.id)) this.update(value.id, (current) => {
        current.error = errorCode(error); workflowEvent(current, 'error', current.error, step.id);
        getStep(current, step.id)!.state = 'failed'; if (step.id === 'planner') current.state = 'failed';
      });
    } finally {
      this.preparing.delete(reservation);
      if (!waitingForInputs) this.preparationDetails.delete(preparationKey);
      else {
        const detail = this.preparationDetails.get(preparationKey);
        if (detail) { detail.active = false; detail.observedAt = new Date().toISOString(); }
      }
    }
  }
  private confirmation(id: string, stepID: string, nodeID: string, waitingCount: number) {
    this.update(id, (value) => {
      if (!value.pendingConfirmation && !terminalWorkflow(value) && value.state !== 'stopping')
        value.pendingConfirmation = { nodeID, stepID, waitingCount };
    });
  }
  private async dispatch(value: Workflow, step: WorkflowStep, attempt: WorkflowAttempt) {
    if (!this.mayStart(value.id, step.id, attempt.executionID)) return;
    if (value.pendingConfirmation?.nodeID === attempt.nodeID && value.pendingConfirmation.stepID === step.id &&
      !value.confirmations.some((c) => c.nodeID === attempt.nodeID)) return;
    let result: WorkflowDispatchResult;
    try { result = await this.adapter.dispatch(value, step, attempt, () => this.mayStart(value.id, step.id, attempt.executionID)); }
    catch (error) { result = { state: 'uncertain', reason: errorCode(error) }; }
    if (result.state === 'confirmation') this.confirmation(value.id, step.id, attempt.nodeID, result.waitingCount);
    this.update(value.id, (latest) => {
      const current = currentStep(latest, step.id, attempt.executionID);
      if (!current) return;
      const active = current.attempts.at(-1)!;
      if (active.phase !== 'intent') return;
      // Keep uncertain delivery as a durable intent: lookup and idempotent admission use the same ID.
      if (result.state === 'accepted') active.phase = 'queued';
      active.error = 'reason' in result ? result.reason : null; active.updatedAt = new Date().toISOString();
      const handoff = latest.handoffs.find((h) => h.stepID === step.id && h.toAttempt === active.number);
      if (handoff && result.state === 'accepted') handoff.phase = 'queued';
    });
  }
  private async reconcile(value: Workflow, step: WorkflowStep) {
    const attempt = step.attempts.at(-1);
    if (!attempt) return;
    let snapshot: WorkflowExecutionSnapshot | null;
    try { snapshot = await this.adapter.lookup(value, attempt); } catch { return; }
    if (!snapshot) {
      if (attempt.phase === 'intent') await this.dispatch(this.store.get(value.id)!, step, attempt);
      // Missing an acknowledged execution is uncertainty, never permission to create another one.
      else if (!terminalAttempt(attempt) && attempt.phase !== 'unknown') this.update(value.id, (latest) => {
        const current = currentStep(latest, step.id, attempt.executionID);
        if (current) { current.attempts.at(-1)!.phase = 'unknown'; current.attempts.at(-1)!.error = 'workflow_execution_unconfirmed'; }
      });
      return;
    }
    const latest = this.store.get(value.id)!;
    if (!currentStep(latest, step.id, attempt.executionID) || latest.state === 'stopping') return;
    if (JSON.stringify([attempt.phase, attempt.summary, attempt.error, attempt.outcome, attempt.outputFiles]) !==
      JSON.stringify([snapshot.phase, snapshot.summary, snapshot.error, snapshot.outcome, snapshot.outputFiles])) this.update(value.id, (current) => {
      const execution = currentStep(current, step.id, attempt.executionID)?.attempts.at(-1);
      if (execution && !execution.handled) Object.assign(execution, { phase: snapshot.phase, summary: snapshot.summary,
        error: snapshot.error, outcome: snapshot.outcome, outputFiles: snapshot.outputFiles, updatedAt: new Date().toISOString() });
    });
    if (snapshot.phase === 'completed' && !attempt.handled) await this.outcome(value.id, step.id, attempt.executionID, snapshot);
    else if (['failed', 'stopped'].includes(snapshot.phase)) this.update(value.id, (current) => {
      const active = currentStep(current, step.id, attempt.executionID);
      if (!active) return;
      if (snapshot.phase === 'failed' && this.correctPlanningFormat(current, active, snapshot.error)) return;
      active.state = snapshot.phase === 'stopped' ? 'cancelled' : 'failed'; active.attempts.at(-1)!.handled = true;
      if (step.id === 'planner') { current.state = 'failed'; current.error = snapshot.error || 'workflow_planning_failed'; }
    });
  }
  private correctPlanningFormat(value: Workflow, step: WorkflowStep, error: string | null): boolean {
    if (step.id !== 'planner' || value.planVersion || value.steps.length || value.state === 'stopping' ||
      error !== 'workflow_invalid_outcome' || (step.validationRounds || 0) >= 2 || step.attempts.length >= 16) return false;
    const attempt = step.attempts.at(-1)!;
    if (!['failed', 'completed'].includes(attempt.phase)) return false;
    attempt.handled = true; attempt.error = error;
    step.validationRounds = (step.validationRounds || 0) + 1; step.state = 'ready';
    step.continuation = { nodeID: attempt.nodeID, reason: 'Correct planning JSON', handoff: false };
    value.error = null;
    workflowEvent(value, 'error', error, step.id); return true;
  }
  private async outcome(id: string, stepID: string, executionID: string, snapshot: WorkflowExecutionSnapshot) {
    const value = this.store.get(id)!; const step = currentStep(value, stepID, executionID);
    if (!step || step.attempts.at(-1)!.handled || value.state === 'stopping') return;
    const outcome = snapshot.outcome;
    const planner = stepID === 'planner';
    try {
      if (planner ? !validPlanningOutcome(outcome) : !validExecutionOutcome(outcome)) throw new Error('workflow_invalid_outcome');
      let queryEvidence: string | null = null;
      let materials = mergeFiles(step.materials, snapshot.outputFiles);
      if (outcome!.kind === 'query' || outcome!.kind === 'resources') {
        if (step.queryRounds >= 4) throw new Error('workflow_query_limit');
        if (outcome!.kind === 'query') queryEvidence = boundedText(JSON.stringify(await this.adapter.query(value, outcome!.query)), 12_000, 18_000);
        else materials = mergeFiles(materials, await this.adapter.materialize(value, outcome!.resources));
      }
      if (outcome!.kind === 'plan' || outcome!.kind === 'expand') {
        const error = workflowPlanError(outcome!.plan, value.target);
        if (error) throw new Error(error);
        if (outcome!.plan.steps.some((s) => s.id === 'planner')) throw new Error('workflow_reserved_step_id');
        if (outcome!.kind === 'expand' && !snapshot.safeToTransfer) throw new Error('workflow_source_not_quiescent');
      }
      if (outcome!.kind === 'handoff') {
        if (value.target.mode === 'locked') throw new Error('workflow_locked_handoff');
        if (!snapshot.safeToTransfer || !outcome!.processesStopped) throw new Error('workflow_source_not_quiescent');
        if (value.handoffs.filter((h) => h.stepID === stepID).length >= 4) throw new Error('workflow_handoff_limit');
        if (outcome!.nodeID && step.attempts.some((a) => a.nodeID === outcome!.nodeID)) throw new Error('workflow_handoff_cycle');
      }
      const latest = this.store.get(id)!;
      if (!currentStep(latest, stepID, executionID) || latest.state === 'stopping' || this.closed) return;
      this.update(id, (current) => {
        const active = currentStep(current, stepID, executionID)!; const attempt = active.attempts.at(-1)!;
        attempt.handled = true; active.materials = materials;
        if (outcome!.kind === 'plan') {
          current.summary = outcome!.plan.summary; current.steps = outcome!.plan.steps.map(workflowStep); current.planVersion++;
          active.state = 'completed'; if (current.state !== 'paused') current.state = 'running';
          workflowEvent(current, 'plan', current.summary);
        } else if (outcome!.kind === 'completed') {
          active.checkpoint = outcome!.summary; active.state = 'completed';
          const handoff = current.handoffs.findLast((h) => h.stepID === stepID && h.toAttempt <= attempt.number && h.toNodeID === attempt.nodeID);
          if (handoff) handoff.phase = 'completed';
        } else {
          if ('checkpoint' in outcome!) active.checkpoint = outcome!.checkpoint;
          if (outcome!.kind === 'expand') this.expand(current, active, outcome!.plan);
          else {
            active.state = 'ready';
            active.continuation = { nodeID: outcome!.kind === 'handoff' ? outcome!.nodeID : attempt.nodeID,
              reason: outcome!.reason, handoff: outcome!.kind === 'handoff' };
            if (outcome!.kind !== 'handoff') {
              active.queryRounds++; if (queryEvidence !== null) active.evidence = queryEvidence;
              workflowEvent(current, 'query', outcome!.reason, stepID);
            }
          }
        }
      });
    } catch (error) {
      const latest = this.store.get(id)!;
      if (latest.state === 'stopping') return;
      this.update(id, (current) => {
        const active = currentStep(current, stepID, executionID);
        if (!active) return;
        if (this.correctPlanningFormat(current, active, errorCode(error))) return;
        active.state = 'failed'; active.attempts.at(-1)!.handled = true; active.attempts.at(-1)!.error = errorCode(error);
        current.error = errorCode(error); if (planner) current.state = 'failed'; workflowEvent(current, 'error', current.error, stepID);
      });
    }
  }
  private expand(value: Workflow, step: WorkflowStep, plan: WorkflowPlan) {
    if (value.steps.length + plan.steps.length > 32) throw new Error('workflow_expansion_limit');
    const prefix = `s${value.planVersion + 1}_`;
    const idMap = new Map(plan.steps.map((s, i) => [s.id, `${prefix}${i + 1}`]));
    const newSteps = plan.steps.map((s) => workflowStep({ ...s, id: idMap.get(s.id)!,
      dependsOn: s.dependsOn.length ? s.dependsOn.map((id) => idMap.get(id)!) : [step.id] }));
    const leaves = newSteps.filter((s) => !newSteps.some((other) => other.dependsOn.includes(s.id))).map((s) => s.id);
    for (const next of value.steps) if (next.dependsOn.includes(step.id)) {
      if (next.attempts.length) throw new Error('workflow_expansion_started_dependency');
      next.dependsOn = [...new Set([...next.dependsOn.filter((id) => id !== step.id), ...leaves])];
    }
    step.state = 'completed'; value.steps.push(...newSteps); value.planVersion++;
    workflowEvent(value, 'plan', plan.summary, step.id);
  }
}
function planFields(step: WorkflowStepPlan): WorkflowStepPlan {
  return { id: step.id, title: step.title, instructions: step.instructions, dependsOn: step.dependsOn,
    nodeID: step.nodeID, resources: step.resources, software: step.software, requirements: step.requirements };
}
function errorCode(error: unknown) { return error instanceof Error ? error.message.slice(0, 300) : 'workflow_operation_failed'; }
