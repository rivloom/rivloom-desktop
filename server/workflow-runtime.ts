import { collaborationCapability, keys, record } from '../shared/collaboration.ts';
import { join, resolve } from 'node:path';
import { nodeQueueBacklog } from '../shared/queue-backlog.ts';
import { sameTaskFile, type TaskFileDescriptor } from '../shared/task-files.ts';
import { validWorkflowOutcomeReply, type WorkflowOutcomeReply } from '../shared/workflow-channel.ts';
import { type Workflow, type WorkflowAttempt, type WorkflowExecutionContext, type WorkflowStep } from '../shared/workflows.ts';
import { resourceFreshMilliseconds, type ResourceReference } from '../shared/resources.ts';
import { activeStates, type Task } from '../shared/types.ts';
import { db, user, projects, project, saveTask, patchTask, task, taskQueries, activity, now, exclusive } from './store.ts';
import { changed, engineStatus, stopTask } from './task-service.ts';
import { workerCanQueueTask, workerHardwareMatches, workerReportFresh } from './worker-resources.ts';
import { WorkflowStore } from './workflows.ts';
import { WorkflowContexts, workflowContextDigest } from './workflow-contexts.ts';
import { WorkflowOutputs, relayWorkflowInputs, importConversationContext } from './workflow-files.ts';
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
  private options: RuntimeOptions;
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  historyBusy(taskIDs: string[]) { return this.outputs.historyBusy(taskIDs); }
  constructor(options: RuntimeOptions) {
    this.options = options; this.store = new WorkflowStore(db); this.service = new WorkflowService(this.store, this, changed);
    this.contexts = new WorkflowContexts(db, () => options.network.snapshot().local?.id || null, (id) => options.network.remoteTask(id));
    this.outputs = new WorkflowOutputs(db, options.network.files, () => { options.network.refreshTaskFiles(); changed(); });
  }
  start() {
    if (this.interval) return;
    this.interval = setInterval(() => this.kick(), 1500); this.interval.unref(); this.kick();
  }
  async conversationContext(value: Workflow) { return importConversationContext(this.options.network.files, value); }
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
    const network = this.options.network.snapshot(); const own = network.local; const owner = user(value.creatorID)?.owner;
    const catalog = this.options.resources()?.directory.nodes() || [];
    const hasSoftware = (nodeID: string) => !step.software.length || step.software.every((name) => {
      const head = catalog.find((node) => node.nodeID === nodeID)?.head;
      return !!head?.capabilities.some((entry) => entry.status === 'available' && entry.kind === 'software' &&
        (entry.id.toLowerCase() === name.toLowerCase() || entry.name.toLowerCase() === name.toLowerCase()) &&
        Date.now() - Date.parse(entry.checkedAt) < resourceFreshMilliseconds);
    });
    const result: WorkflowCandidate[] = [];
    const ownProject = value.projectID || this.options.policies.snapshot().projectID;
    const ownModel = value.model || this.options.policies.snapshot().model;
    if (own && ownProject && projects().some((p) => p.id === ownProject) && engineStatus.ready &&
      engineStatus.models.some((m) => m.id === ownModel) && hasSoftware(own.id) && this.options.queueHealth().accepting &&
      (!Object.keys(step.requirements).length || own.worker && workerReportFresh(own.worker) && workerHardwareMatches(own.worker.hardware, step.requirements)))
      result.push({ nodeID: own.id, kind: 'local', waitingCount: this.options.queueHealth().waitingCount + this.options.occupiedSlots(),
        localConfig: { projectID: ownProject, model: ownModel! } });
    if (owner) for (const node of network.paired || []) {
      if (!node.online || !node.channelReady || !node.trusted || !node.capabilities.includes(collaborationCapability) || !node.worker ||
        !workerCanQueueTask(node.worker, { projectID: null, requirements: step.requirements }) || !hasSoftware(node.id) ||
        !network.brains.some((brain) => brain.state === 'established' && brain.online && node.brains.some((b) => b.id === brain.id))) continue;
      result.push({ nodeID: node.id, kind: 'remote', waitingCount: nodeQueueBacklog(node) ?? node.worker.load.runningTasks });
    }
    // Resource locality breaks equal queue scores, without turning a file reference into execution authority.
    return result.sort((a, b) => a.waitingCount - b.waitingCount ||
      Number(step.resources.some((r) => r.nodeID === b.nodeID)) - Number(step.resources.some((r) => r.nodeID === a.nodeID)) || a.nodeID.localeCompare(b.nodeID));
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
      project(projectID);
      const count = this.options.queueHealth().waitingCount + this.options.occupiedSlots();
      if (count >= 10 && !value.confirmations.some((c) => c.nodeID === attempt.nodeID)) return { state: 'confirmation', waitingCount: count };
      if (!this.options.queueHealth().accepting || !mayStart()) return { state: 'blocked', reason: 'workflow_queue_unavailable' };
      const at = now();
      const local: Task = { id: attempt.executionID, number: taskQueries.nextNumber(), projectID, model,
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
        { executionID: attempt.executionID, context: attempt.context, inputFiles: attempt.inputFiles });
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
  handle(peer: string, operation: string, payload: unknown): unknown {
    if (!this.options.network.isTrustedNode(peer)) throw new Error('workflow_untrusted_peer');
    if (operation === 'execution-context') return this.contexts.receive(peer, payload);
    if (operation !== 'execution-outcome') throw new Error('workflow_unsupported_operation');
    const context = this.contexts.owned(peer, payload); const remote = this.options.network.remoteTask(context.executionID);
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
    if (response.phase === 'completed') {
      // The authenticated manifest does not imply its bytes have arrived. The existing file protocol verifies them.
      const route = { scope: 'remote' as const, taskID: attempt.executionID, purpose: 'result' as const };
      if (!network.files.complete(route, response.outputFiles)) { network.refreshTaskFiles(); return { ...response, phase: 'waiting', outcome: null, outputFiles: [] }; }
      const manifest = network.files.manifest(route);
      if (!response.outputFiles.every((f) => manifest.some((m) => sameTaskFile(f, m)))) throw new Error('workflow_result_manifest_conflict');
    }
    return response;
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
}
