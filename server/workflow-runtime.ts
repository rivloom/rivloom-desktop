import { reasoningSupported } from '../shared/model-reasoning.ts';
import { collaborationCapability, keys, record, uuid } from '../shared/collaboration.ts';
import { join, resolve } from 'node:path';
import { nodeQueueBacklog } from '../shared/queue-backlog.ts';
import { sameTaskFile, type TaskFileDescriptor, type TaskFileView } from '../shared/task-files.ts';
import { workflowControlsCapability, validWorkflowOutcomeReply, type WorkflowOutcomeReply } from '../shared/workflow-channel.ts';
import { workflowAllSteps, type Workflow, type WorkflowAttempt, type WorkflowExecutionContext, type WorkflowStep } from '../shared/workflows.ts';
import { type ResourceReference } from '../shared/resources.ts';
import { activeStates, type Task } from '../shared/types.ts';
import { db, user, projects, project, saveTask, patchTask, task, taskQueries, activity, now, exclusive } from './store.ts';
import { changed, engineStatus, stopTask, workflowRetryReady } from './task-service.ts';
import { evaluateWorkflowPlacement, type WorkflowPlacementInput } from './workflow-placement.ts';
import { workflowDiagnostics, type WorkflowExecutionDiagnostic } from './workflow-diagnostics.ts';
import { WorkflowStore } from './workflows.ts';
import { WorkflowContexts, workflowContextDigest } from './workflow-contexts.ts';
import { workflowHistoryCapability } from '../shared/workflow-history.ts';
import { WorkflowHistoryAccess, historyAttempt, historyOperation } from './workflow-history-access.ts';
import { WorkflowOutputs, relayWorkflowInputs, importLegacyConversationContext } from './workflow-files.ts';
import { WorkflowService, type WorkflowCandidate, type WorkflowDispatchResult, type WorkflowExecutionAdapter, type WorkflowExecutionSnapshot } from './workflow-service.ts';
import { QueueConfirmationRequired } from './queue-confirmation.ts';
import type { NodeNetwork } from './node-network.ts';
import type { NodeQueueStore } from './node-queue.ts';
import type { ExecutionPolicyStore } from './execution-policy.ts';
import type { ResourceNetwork } from './resource-network.ts';
import type { ResourceCatalog } from './resource-catalog.ts';
import type { ResourceFiles } from './resource-files.ts';

type RuntimeOptions = {
  network: NodeNetwork; queue: NodeQueueStore; policies: ExecutionPolicyStore;
  resources: () => { directory: ResourceNetwork; catalog: ResourceCatalog; files: ResourceFiles } | null;
  queueHealth: () => { waitingCount: number; accepting: boolean }; occupiedSlots: () => number; kickQueue: () => void;
};
const phaseFor = (value: Task): WorkflowExecutionSnapshot['phase'] => value.state === 'accepted' ? 'completed' :
  value.state === 'failed' ? 'failed' : value.state === 'stopped' ? 'stopped' : value.state === 'interrupted' ? 'unknown' :
  value.state === 'ready' || value.state === 'open' ? 'queued' : value.state === 'running' ? 'running' : 'waiting';
export class WorkflowRuntime implements WorkflowExecutionAdapter {
  readonly store: WorkflowStore;
  readonly service: WorkflowService;
  readonly contexts: WorkflowContexts;
  private outputs: WorkflowOutputs;
  private historyAccess: WorkflowHistoryAccess;
  private options: RuntimeOptions;
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private fileRequests = new Map<string, number>();
  historyBusy(taskIDs: string[]) { return this.outputs.historyBusy(taskIDs); }
  constructor(options: RuntimeOptions) {
    this.options = options; this.store = new WorkflowStore(db); this.service = new WorkflowService(this.store, this, changed);
    this.contexts = new WorkflowContexts(db, () => options.network.snapshot().local?.id || null, (id) => options.network.remoteTask(id));
    this.historyAccess = new WorkflowHistoryAccess(this.store, id => options.network.remoteTask(id), peer => options.network.isTrustedNode(peer),
      id => !db.prepare("SELECT 1 FROM conversation_retired WHERE kind='workflow' AND id=?").get(id));
    options.network.setDeferredWorkflowResults((id) => this.contexts.get(id)?.resultDelivery === 'on-demand');
    this.outputs = new WorkflowOutputs(db, options.network.files, () => { options.network.refreshTaskFiles(); changed(); });
  }
  start() {
    if (this.interval) return;
    this.interval = setInterval(() => this.kick(), 1500); this.interval.unref(); this.kick();
  }
  async legacyHistory(value: Workflow, candidate: WorkflowCandidate) {
    // Preserve the full-file path only when the selected peer cannot query history.
    if (candidate.history !== false || !value.rounds?.length) return undefined;
    return importLegacyConversationContext(this.options.network.files, value);
  }
  fileLocations(local: Task, fileID: string) {
    const directory = projects().find((value) => value.id === local.projectID)?.directory;
    if (!directory) return [];
    const root = resolve(directory);
    const file = this.options.network.files.descriptorFor(fileID);
    return [...this.outputs.locations(local.id, fileID, root),
      { root, path: join(root, '.rivloom-inputs', local.id, fileID, file.name) }];
  }
  kick() {
    if (this.running || !this.interval) return;
    this.running = true;
    void this.service.tick().finally(() => { this.running = false; });
  }
  candidates(value: Workflow, step: WorkflowStep, _role: WorkflowExecutionContext['role']): WorkflowCandidate[] {
    const snapshot = this.options.network.snapshot();
    return evaluateWorkflowPlacement(step, this.placementInput(value, snapshot)).candidates.map(candidate => ({ ...candidate,
      history: candidate.kind === 'local' || !!snapshot.paired?.find(n => n.id === candidate.nodeID)?.capabilities.includes(workflowHistoryCapability) }));
  }
  private placementInput(value: Workflow, network = this.options.network.snapshot()): WorkflowPlacementInput {
    const ownProject = value.projectID || this.options.policies.snapshot().projectID;
    const ownModel = value.model || this.options.policies.snapshot().model;
    const queue = this.options.queueHealth();
    return { network, owner: !!user(value.creatorID)?.owner,
      catalog: this.options.resources()?.directory.nodes() || [], local: { projectID: ownProject, model: ownModel,
        reasoningEffort: value.reasoningEffort !== undefined ? value.reasoningEffort : !value.model ? this.options.policies.snapshot().reasoningEffort : undefined,
        projectExists: projects().some((p) => p.id === ownProject), engineReady: engineStatus.ready,
        modelAvailable: engineStatus.models.some((m) => m.id === ownModel), accepting: queue.accepting,
        waitingCount: queue.waitingCount + this.options.occupiedSlots() } };
  }
  diagnostics(value: Workflow) {
    const network = this.options.network.snapshot();
    const input = this.placementInput(value, network), at = Date.now();
    const queue = this.options.queue.snapshot();
    return workflowDiagnostics(value, {
      placement: (step) => evaluateWorkflowPlacement(step, input, at),
      preparation: (step) => this.service.preparation(value, step),
      execution: (attempt): WorkflowExecutionDiagnostic => {
        const empty: WorkflowExecutionDiagnostic = { connected: false, observedAt: null, attention: false, queue: null };
        if (attempt.kind === 'local') {
          const local = this.localTask(attempt);
          if (!local) return { ...empty, connected: attempt.phase === 'intent' };
          try { this.assertBinding(value, attempt, local); } catch { return empty; }
          const entry = queue.entries.find((e) => e.source.kind === 'local' && e.source.taskID === local.id && e.state !== 'ended');
          return { connected: true, observedAt: local.updatedAt, attention: !!(local.approvals.length || local.questions.length),
            queue: entry ? { state: entry.state === 'waiting' ? 'queued' : entry.state === 'held' ? 'held' : 'admitted',
              position: entry.position, reason: null, code: entry.state === 'waiting' && queue.paused ? 'queue_paused' : entry.blockReason?.code || null,
              observedAt: entry.state === 'waiting' && queue.paused ? queue.updatedAt : entry.updatedAt, local: true } : null };
        }
        if (!input.owner) return empty;
        const peer = input.network.paired?.find((n) => n.id === attempt.nodeID);
        // The network snapshot joins authenticated queue receipts from their separate store.
        const remote = network.remoteTasks.find((task) => task.id === attempt.executionID);
        if (!remote || remote.direction !== 'outgoing' || remote.targetNodeID !== attempt.nodeID) return empty;
        const receipt = remote.queueReceipt;
        return { connected: !!(peer?.online && peer.trusted && peer.channelReady), observedAt: attempt.updatedAt,
          attention: !!(remote.remoteApprovals.length || remote.remoteQuestions.length),
          queue: receipt && receipt.remoteTaskID === attempt.executionID && receipt.targetNodeID === attempt.nodeID
            ? { state: receipt.state, position: receipt.position, reason: receipt.reason, code: null, observedAt: receipt.updatedAt, local: false } : null };
      },
    }, at);
  }
  evidence(value: Workflow): string {
    const resources = this.options.resources(); const network = this.options.network.snapshot();
    if (!user(value.creatorID)?.owner) return JSON.stringify({ nodes: network.local ? [{ nodeID: network.local.id, name: network.local.name,
      hardware: network.local.worker?.hardware, models: engineStatus.models, permittedExecution: 'local' }] : [] });
    return JSON.stringify({ nodes: (resources?.directory.nodes() || []).map((node) => ({ ...node,
      hardware: (node.nodeID === network.local?.id ? network.local : network.paired?.find((n) => n.id === node.nodeID))?.worker?.hardware,
      waitingCount: node.nodeID === network.local?.id ? this.options.queueHealth().waitingCount :
        nodeQueueBacklog(network.paired!.find((n) => n.id === node.nodeID) || { online: false, channelReady: false, worker: null }),
    })) });
  }
  async materialize(value: Workflow, references: ResourceReference[]): Promise<TaskFileDescriptor[]> {
    const resources = this.options.resources(); if (!resources) throw new Error('workflow_resource_directory_unavailable');
    const owner = user(value.creatorID)?.owner;
    if (!owner && references.some((r) => r.nodeID !== resources.catalog.head().nodeID || r.workspaceID !== value.projectID))
      throw new Error('workflow_resource_not_authorized');
    const result = [];
    for (const reference of references) result.push(await resources.files.fetch(value.id, reference));
    return result;
  }
  async query(value: Workflow, query: Parameters<WorkflowExecutionAdapter['query']>[1]) {
    const resources = this.options.resources(); if (!resources) throw new Error('workflow_resource_directory_unavailable');
    if (!user(value.creatorID)?.owner) return resources.catalog.head().workspaceID === value.projectID ? resources.catalog.query(query) : { entries: [], capabilities: [], note: 'No permitted catalog for this project' };
    return resources.directory.query(query);
  }
  stageInputs(value: Workflow, key: string, files: TaskFileDescriptor[], mayRead: () => boolean) {
    return relayWorkflowInputs(this.options.network.files, `${value.id}:${key}`, files, mayRead);
  }
  private localTask(attempt: WorkflowAttempt): Task | null {
    return taskQueries.stateForID(attempt.executionID) ? task(attempt.executionID) : null;
  }
  private assertBinding(value: Workflow, attempt: WorkflowAttempt, local: Task) {
    if (!local.collaboration || local.creatorID !== value.creatorID ||
      workflowContextDigest(local.collaboration, local.inputFiles || []) !== workflowContextDigest(attempt.context, attempt.inputFiles))
      throw new Error('workflow_local_binding_conflict');
  }
  async dispatch(value: Workflow, step: WorkflowStep, attempt: WorkflowAttempt, mayStart: () => boolean): Promise<WorkflowDispatchResult> {
    const actor = user(value.creatorID); if (!actor) return { state: 'blocked', reason: 'workflow_creator_unavailable' };
    if (attempt.kind === 'local') {
      const existing = this.localTask(attempt);
      if (existing) { this.assertBinding(value, attempt, existing); return { state: 'accepted' }; }
      const projectID = attempt.localConfig?.projectID;
      const model = attempt.localConfig?.model;
      if (!projectID || !model || !engineStatus.models.some((m) => m.id === model)) return { state: 'blocked', reason: 'workflow_model_unavailable' };
      if (!reasoningSupported(engineStatus.models.find(m => m.id === model), attempt.localConfig?.reasoningEffort))
        return { state: 'blocked', reason: '所选思考等级当前不可用，请重新选择思考等级或使用自动。' };
      project(projectID);
      const count = this.options.queueHealth().waitingCount + this.options.occupiedSlots();
      if (count >= 10 && !value.confirmations.some((c) => c.nodeID === attempt.nodeID)) return { state: 'confirmation', waitingCount: count };
      if (!this.options.queueHealth().accepting || !mayStart()) return { state: 'blocked', reason: 'workflow_queue_unavailable' };
      const at = now();
      const local: Task = { id: attempt.executionID, number: taskQueries.nextNumber(), projectID, model, reasoningEffort: attempt.localConfig?.reasoningEffort,
        title: step.title.slice(0, 120), description: attempt.context.instructions, criteria: 'Complete the requested business step and return verified outputs.',
        creatorID: actor.id, assigneeID: actor.id, approverID: actor.id, reviewerID: actor.id, acceptedBy: null,
        state: 'ready', approvalMode: value.approvalMode, version: 1, createdAt: at, updatedAt: at, sessionID: null, runAfter: 0,
        messages: [], approvals: [], questions: [], artifacts: [], diffSource: '', error: null,
        collaboration: attempt.context, ...(attempt.inputFiles.length ? { inputFiles: attempt.inputFiles } : {}) };
      this.options.network.files.bindExisting({ scope: 'local', taskID: local.id, purpose: 'input' }, attempt.inputFiles);
      if (!mayStart()) return { state: 'blocked', reason: 'workflow_dispatch_cancelled' };
      this.options.queue.enqueue({ kind: 'local', taskID: local.id }, () => saveTask(local));
      activity(local.id, actor.id, 'workflow_execution', `${attempt.context.role}: ${step.title}`); changed(local.id); this.options.kickQueue();
      return { state: 'accepted' };
    }
    if (!actor.owner) return { state: 'blocked', reason: 'workflow_remote_not_authorized' };
    const network = this.options.network;
    const existing = network.remoteTask(attempt.executionID);
    const input = { title: step.title.slice(0, 120), description: `Workflow ${value.id}, step ${step.id}, attempt ${attempt.number}.\n${attempt.context.instructions.slice(0, 3500)}`,
      criteria: 'Follow the authenticated workflow execution context and return the required structured outcome.',
      requirements: step.requirements, inputFiles: attempt.inputFiles };
    if (!existing) {
      const peer = network.snapshot().paired?.find((node) => node.id === attempt.nodeID);
      if (!peer?.capabilities.includes(collaborationCapability) || !peer.online || !peer.channelReady || !peer.trusted)
        return { state: 'blocked', reason: 'workflow_target_unavailable' };
      const response = await network.collaborationRequest(attempt.nodeID, 'execution-context',
        { executionID: attempt.executionID, context: attempt.context, inputFiles: attempt.inputFiles,
          ...(attempt.resultDelivery ? { resultDelivery: attempt.resultDelivery } : {}) });
      const digest = workflowContextDigest(attempt.context, attempt.inputFiles);
      if (!record(response) || !keys(response, ['executionID', 'digest']) || response.executionID !== attempt.executionID || response.digest !== digest)
        throw new Error('workflow_metadata_ack_invalid');
    }
    if (!mayStart()) return { state: 'blocked', reason: 'workflow_dispatch_cancelled' };
    try {
      await network.createTaskForNode(attempt.nodeID, input, attempt.executionID,
        value.confirmations.some((c) => c.nodeID === attempt.nodeID) ? attempt.nodeID : undefined);
      return { state: 'accepted' };
    } catch (error) {
      if (error instanceof QueueConfirmationRequired) return { state: 'confirmation', waitingCount: error.queueConfirmation.count };
      throw error;
    }
  }
  private snapshot(local: Task): WorkflowExecutionSnapshot {
    const phase = phaseFor(local);
    const summary = local.messages.filter((m) => m.role === 'assistant').at(-1)?.text.slice(0, 300) || '';
    if (phase !== 'completed') return { phase, summary, error: local.error?.slice(0, 300) || null, outcome: null, outputFiles: [], safeToTransfer: false };
    const output = local.collaborationOutcome;
    if (!local.collaboration || !output || output.sessionID !== local.sessionID || output.attempt !== local.collaboration.attempt || output.runAfter !== local.runAfter)
      return { phase: 'failed', summary, error: 'workflow_outcome_not_bound', outcome: null, outputFiles: [], safeToTransfer: false };
    const exported = this.outputs.ensure(local, project(local.projectID).directory);
    return { phase: exported.phase === 'complete' ? 'completed' : exported.phase === 'failed' ? 'failed' : 'waiting', summary,
      error: exported.error, outcome: exported.phase === 'complete' ? output.value : null, outputFiles: exported.files,
      safeToTransfer: output.quiescence.confirmed && exported.phase === 'complete' };
  }
  async handle(peer: string, operation: string, payload: unknown): Promise<unknown> {
    if (!this.options.network.isTrustedNode(peer)) throw new Error('workflow_untrusted_peer');
    if (operation === 'execution-history') return this.historyAccess.handle(peer, payload);
    if (operation === 'execution-context') return this.contexts.receive(peer, payload);
    if (!['execution-outcome', 'execution-files', 'execution-retry-check'].includes(operation)) throw new Error('workflow_unsupported_operation');
    if (operation === 'execution-files' && (!record(payload) || !keys(payload, ['executionID', 'digest', 'fileID']) || !uuid(payload.fileID)))
      throw new Error('workflow_invalid_file_request');
    const context = this.contexts.owned(peer, operation === 'execution-files' && record(payload) ? { executionID: payload.executionID, digest: payload.digest } : payload);
    const remote = this.options.network.remoteTask(context.executionID);
    if (operation !== 'execution-outcome' && (!remote || remote.direction !== 'incoming' || remote.ownerNodeID !== peer || !remote.localTaskID))
      throw new Error('workflow_execution_unconfirmed');
    if (!remote || remote.direction !== 'incoming' || remote.ownerNodeID !== peer) return {
      executionID: context.executionID, digest: context.digest, sessionID: null, attempt: context.context.attempt, runAfter: 0,
      phase: 'queued', summary: '', error: null, outcome: null, outputFiles: [], safeToTransfer: false,
    } satisfies WorkflowOutcomeReply;
    const local = remote.localTaskID ? task(remote.localTaskID) : null;
    if (!local) return { executionID: context.executionID, digest: context.digest, sessionID: null, attempt: context.context.attempt, runAfter: 0,
      phase: ['cancelled', 'expired', 'declined'].includes(remote.status) ? 'stopped' : 'queued', summary: '', error: null,
      outcome: null, outputFiles: [], safeToTransfer: false } satisfies WorkflowOutcomeReply;
    if (context.localTaskID !== local.id || !local.collaboration ||
      workflowContextDigest(local.collaboration, local.inputFiles || []) !== context.digest) throw new Error('workflow_remote_binding_conflict');
    if (operation === 'execution-retry-check') return { executionID: context.executionID, digest: context.digest, ready: await workflowRetryReady(local.id) };
    if (operation === 'execution-files') {
      if (context.resultDelivery !== 'on-demand' || remote.status !== 'accepted') throw new Error('workflow_file_not_available');
      const snapshot = this.snapshot(local);
      const file = snapshot.outputFiles.find((f) => f.id === (payload as { fileID: string }).fileID);
      if (snapshot.phase !== 'completed' || !file) throw new Error('workflow_file_not_available');
      const route = { scope: 'remote' as const, taskID: remote.id, purpose: 'result' as const };
      this.options.network.files.bindExisting(route, [file]);
      this.options.network.files.queueDelivery(route, file.id, peer);
      this.options.network.files.retry(route, file.id);
      this.options.network.refreshTaskFiles();
      return { executionID: context.executionID, digest: context.digest, fileID: file.id };
    }
    const result: WorkflowOutcomeReply = { ...this.snapshot(local), executionID: context.executionID, digest: context.digest,
      sessionID: local.sessionID, attempt: context.context.attempt, runAfter: local.runAfter };
    if (!validWorkflowOutcomeReply(result)) throw new Error('workflow_outcome_limit');
    return result;
  }
  async lookup(value: Workflow, attempt: WorkflowAttempt): Promise<WorkflowExecutionSnapshot | null> {
    if (attempt.kind === 'local') {
      const local = this.localTask(attempt); if (!local) return null;
      this.assertBinding(value, attempt, local); return this.snapshot(local);
    }
    const network = this.options.network; const remote = network.remoteTask(attempt.executionID);
    if (!remote) return null;
    if (remote.direction !== 'outgoing' || remote.targetNodeID !== attempt.nodeID) throw new Error('workflow_remote_binding_conflict');
    const digest = workflowContextDigest(attempt.context, attempt.inputFiles);
    const response = await network.collaborationRequest(attempt.nodeID, 'execution-outcome', { executionID: attempt.executionID, digest });
    if (!validWorkflowOutcomeReply(response) || response.executionID !== attempt.executionID || response.digest !== digest || response.attempt !== attempt.number)
      throw new Error('workflow_outcome_binding_conflict');
    if (response.phase === 'completed' && attempt.resultDelivery !== 'on-demand') {
      // The authenticated manifest does not imply its bytes have arrived. The existing file protocol verifies them.
      const route = { scope: 'remote' as const, taskID: attempt.executionID, purpose: 'result' as const };
      if (!network.files.complete(route, response.outputFiles)) { network.refreshTaskFiles(); return { ...response, phase: 'waiting', outcome: null, outputFiles: [] }; }
      const manifest = network.files.manifest(route);
      if (!response.outputFiles.every((f) => manifest.some((m) => sameTaskFile(f, m)))) throw new Error('workflow_result_manifest_conflict');
    }
    return response;
  }
  async retryReady(value: Workflow, attempt: WorkflowAttempt): Promise<boolean> {
    if (attempt.kind === 'local') {
      const local = this.localTask(attempt); if (!local) return false;
      this.assertBinding(value, attempt, local); return workflowRetryReady(local.id);
    }
    const network = this.options.network;
    if (!network.snapshot().paired?.find((n) => n.id === attempt.nodeID)?.capabilities.includes(workflowControlsCapability)) return false;
    const digest = workflowContextDigest(attempt.context, attempt.inputFiles);
    try {
      const response = await network.collaborationRequest(attempt.nodeID, 'execution-retry-check', { executionID: attempt.executionID, digest });
      return record(response) && keys(response, ['executionID', 'digest', 'ready']) && response.executionID === attempt.executionID &&
        response.digest === digest && response.ready === true;
    } catch { return false; }
  }
  private resultAttempt(executionID: string) {
    return this.store.list().flatMap((w) => workflowAllSteps(w).flatMap((s) => s.attempts))
      .find((a) => a.executionID === executionID && a.kind === 'remote' && a.resultDelivery === 'on-demand');
  }
  remoteFileViews(executionID: string): TaskFileView[] {
    const attempt = this.resultAttempt(executionID); if (!attempt) return [];
    const route = { scope: 'remote' as const, taskID: executionID, purpose: 'result' as const };
    const received = this.options.network.files.views(route);
    return attempt.outputFiles.map((file, index) => ({ ...file, state: 'remote' as const, receivedBytes: 0, error: null,
      updatedAt: attempt.updatedAt, deliveries: [], ...received.find((f) => f.id === file.id && sameTaskFile(f, file)),
      sourceNodeID: attempt.nodeID, sourcePath: attempt.outcome && 'files' in attempt.outcome ? attempt.outcome.files[index] : undefined }));
  }
  async fetchResultFile(executionID: string, fileID: string) {
    const attempt = this.resultAttempt(executionID);
    const file = attempt?.outputFiles.find((f) => f.id === fileID);
    if (!attempt || !file) throw new Error('workflow_file_not_available');
    const network = this.options.network;
    const remote = network.remoteTask(executionID);
    if (remote?.direction !== 'outgoing' || remote.targetNodeID !== attempt.nodeID || !network.isTrustedNode(attempt.nodeID))
      throw new Error('workflow_remote_binding_conflict');
    const route = { scope: 'remote' as const, taskID: executionID, purpose: 'result' as const };
    if (network.files.complete(route, [file])) return;
    network.files.expectIncoming(route, [file], attempt.nodeID);
    network.files.retryIncoming(route, file, attempt.nodeID);
    const digest = workflowContextDigest(attempt.context, attempt.inputFiles);
    const response = await network.collaborationRequest(attempt.nodeID, 'execution-files', { executionID, digest, fileID });
    if (!record(response) || !keys(response, ['executionID', 'digest', 'fileID']) || response.executionID !== executionID ||
      response.digest !== digest || response.fileID !== fileID) throw new Error('workflow_file_request_unconfirmed');
    network.refreshTaskFiles(); changed();
  }
  async prepareInputs(value: Workflow, files: TaskFileDescriptor[], role: WorkflowExecutionContext['role'], required: TaskFileDescriptor[]): Promise<TaskFileDescriptor[] | null> {
    const attempts = workflowAllSteps(value).flatMap((s) => s.attempts);
    const result: TaskFileDescriptor[] = []; let waiting = false;
    for (const file of files) {
      const source = attempts.find((a) => a.kind === 'remote' && a.resultDelivery === 'on-demand' && a.outputFiles.some((f) => sameTaskFile(f, file)));
      if (!source || this.options.network.files.complete({ scope: 'remote', taskID: source.executionID, purpose: 'result' }, [file])) { result.push(file); continue; }
      // Planning reads verified history/result metadata; only business execution needs the bytes.
      if (role === 'planner' || !required.some((f) => sameTaskFile(f, file))) continue;
      waiting = true;
      if (Date.now() - (this.fileRequests.get(file.id) || 0) < 10_000) continue;
      this.fileRequests.set(file.id, Date.now());
      try { await this.fetchResultFile(source.executionID, file.id); } catch { /* Retry after reconnect without dispatching incomplete inputs. */ }
    }
    return waiting ? null : result;
  }
  async stop(value: Workflow, attempt: WorkflowAttempt): Promise<'stopped' | 'unknown'> {
    if (attempt.kind === 'local') return exclusive(`workflow-stop:${attempt.executionID}`, async () => {
      let local = this.localTask(attempt);
      if (!local) return 'stopped'; // No admission can occur after the workflow's persisted stop fence.
      this.assertBinding(value, attempt, local);
      const actor = user(value.creatorID); if (!actor) return 'unknown';
      if (local.state === 'ready' && !local.sessionID && !db.prepare('SELECT task_id FROM task_engine_intents WHERE task_id=?').get(local.id)) {
        const entry = this.options.queue.findBySource({ kind: 'local', taskID: local.id });
        if (entry) this.options.queue.end(entry.id, { code: 'cancelled' }, () => patchTask(local!.id, { state: 'stopped', error: null }));
        else patchTask(local.id, { state: 'stopped', error: null });
        changed(local.id); return 'stopped';
      }
      if (activeStates.includes(local.state) || local.state === 'interrupted') {
        try { await stopTask(local.id, actor); } catch { return 'unknown'; }
        local = task(local.id);
      }
      return ['stopped', 'accepted', 'failed'].includes(local.state) ? 'stopped' : 'unknown';
    });
    const network = this.options.network; const remote = network.remoteTask(attempt.executionID);
    if (!remote) return 'stopped';
    if (remote.direction !== 'outgoing' || remote.targetNodeID !== attempt.nodeID) return 'unknown';
    try {
      if (remote.executionSequence === 0 && remote.status === 'pending') await network.cancelRemoteTask(remote.id);
      else if (!['stopped', 'accepted', 'failed'].includes(remote.executionState) && !remote.controlPending)
        await network.requestRemoteTaskControl(remote.id, remote.executionSequence, { kind: 'stop' });
      const current = network.remoteTask(remote.id)!;
      if (['accepted', 'failed', 'stopped'].includes(current.executionState)) return 'stopped';
      if (['declined', 'expired', 'cancelled'].includes(current.status) && !current.deliveryPending && !current.deliveryError) return 'stopped';
    } catch { /* Stop remains pending until an authenticated state confirms it. */ }
    return 'unknown';
  }
  async close() {
    if (this.interval) clearInterval(this.interval); this.interval = null;
    await this.service.close(); await this.outputs.close();
  }
  async historyTool(taskID: string, name: unknown, args: unknown) {
    const local = task(taskID), context = local.collaboration;
    if (!context) throw new Error('context_history_not_available');
    if (db.prepare("SELECT 1 FROM conversation_retired WHERE kind='local' AND id=? OR kind='remote' AND id=?")
      .get(local.id, local.remoteOrigin?.remoteTaskID || '')) throw new Error('context_history_not_available');
    const digest = workflowContextDigest(context, local.inputFiles || []);
    if (local.remoteOrigin) {
      const bound = this.contexts.get(local.remoteOrigin.remoteTaskID);
      const remote = this.options.network.remoteTask(local.remoteOrigin.remoteTaskID);
      if (!bound || bound.localTaskID !== local.id || bound.digest !== digest || bound.ownerNodeID !== local.remoteOrigin.ownerNodeID ||
        !remote || remote.direction !== 'incoming' || remote.ownerNodeID !== bound.ownerNodeID || remote.status !== 'accepted' || remote.localTaskID !== local.id)
        throw new Error('context_execution_changed');
      const available = () => this.options.network.snapshot().paired?.some(n => n.id === bound.ownerNodeID && n.online && n.trusted && n.channelReady && n.capabilities.includes(workflowHistoryCapability));
      if (!available()) throw new Error('context_history_unavailable');
      const result = await this.options.network.collaborationRequest(bound.ownerNodeID, 'execution-history', {
        workflowID: context.workflowID, executionID: bound.executionID, digest, name, args });
      if (!available()) throw new Error('context_history_unavailable');
      if (!record(result) || !keys(result, ['workflowID', 'executionID', 'digest', 'name', 'result']) || result.workflowID !== context.workflowID ||
        result.executionID !== bound.executionID || result.digest !== digest || result.name !== name || Buffer.byteLength(JSON.stringify(result)) > 60_000)
        throw new Error('context_invalid_reply');
      return result.result;
    }
    if (db.prepare("SELECT 1 FROM conversation_retired WHERE kind='workflow' AND id=?").get(context.workflowID)) throw new Error('context_history_not_available');
    const value = this.store.get(context.workflowID);
    if (!value || value.creatorID !== local.creatorID) throw new Error('context_history_not_authorized');
    const attempt = historyAttempt(value, local.id, digest);
    if (attempt.kind !== 'local') throw new Error('context_history_not_authorized');
    this.assertBinding(value, attempt, local);
    return historyOperation(this.store, value, attempt, name, args);
  }
}
