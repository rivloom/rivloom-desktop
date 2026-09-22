import { validReasoningEffort, reasoningSupported } from '../shared/model-reasoning.ts';
import { installTaskFileAPI } from './task-file-api.ts';
import { installProjectChangesAPI } from './project-changes-api.ts';
import { installPromptTemplateAPI } from './prompt-template-api.ts';
import { PromptTemplateStore } from './prompt-templates.ts';
import { TaskFileError } from './task-files.ts';
import { inputFileFields, taskFileUploadCount } from '../shared/task-files.ts';
import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { listenHttp } from './http-ports.ts';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import {
  db,
  users,
  user,
  projects,
  project,
  tasks,
  taskQueries,
  task,
  saveTask,
  saveProject,
  patchTask,
  participant,
  activity,
  activities,
  id,
  now,
  requireThat,
  HttpError,
  exclusive,
} from './store.ts';
import {
  authenticated,
  createUser,
  verifyPassword,
  login,
  checkSetup,
  finishSetup,
  rateLimit,
  token,
  hash,
  sessionToken,
  sameToken,
  type AuthRequest,
} from './auth.ts';
import {
  engineStatus,
  initializeEngine,
  changed,
  updates,
  runTask,
  sendTaskMessage,
  stopTask,
  addRequirement,
  replyPermission,
  replyQuestion,
  acceptResult,
  requestChanges,
  shutdownEngine,
  setTaskStartGuard,
  setTaskInputMaterializer,
  setTaskKnowledgeContext,
  taskContexts,
  engineClient,
} from './task-service.ts';
import { validateProject, redact } from './artifacts.ts';
import { dataRoot, engineRoot } from './engine.ts';
import { accountEngines } from './account-engines.ts';
import { RuntimeHistory } from './runtime-history.ts';
import { WorkflowKnowledge } from './workflow-knowledge.ts';
import { remoteExecutionSummary } from './remote-execution-summary.ts';
import { acquireDataLock } from './process-lock.ts';
import {
  activeStates,
  type Approval,
  type Artifact,
  type Question,
  type Task,
  type RemoteTaskInvite,
  type Bootstrap,
} from '../shared/types.ts';
import {
  modelSettings,
  defaultModel,
  saveDeepSeek,
  chooseDefaultModel,
  startConnectionCheck,
  cancelConnectionCheck,
  assertCanStartTask,
  providerCatalog, saveProviderKey, saveCustomProvider, removeProvider, renameProviderAccount, beginProviderOAuth, cancelProviderOAuth, providerOAuth,
} from './model-settings.ts';
import { apiKeySchema, providerIDSchema, accountTargetSchema, accountNameSchema } from '../shared/model-providers.ts';
import { ProviderAccountError } from './provider-accounts.ts';
import { NodeNetwork, NodeNetworkError } from './node-network.ts';
import { loadNodeIdentity } from './node-identity.ts';
import { ExecutionPolicyStore } from './execution-policy.ts';
import { WorkerResourceSampler, workerMatchesTask } from './worker-resources.ts';
import { WorkerAdmissionGate, occupiesWorkerSlot, executionOccupancy, isRemoteExecution } from './worker-admission.ts';
import { validNodeProfile, type NodeProfile } from '../shared/node-profile.ts';
import { CreationRequestStore, CreationConflict } from './creation-requests.ts';
import { QueueConfirmationRequired, requireQueueConfirmation } from './queue-confirmation.ts';
import {
  NodeQueueStore,
  NodeQueueError,
  canReleaseUnboundReservation,
  nodeQueueRecoveryDecision,
} from './node-queue.ts';
import { NodeHealthMonitor } from './node-health.ts';
import { TaskAttentionStore } from './task-attention.ts';
import { WorkspacePreferences, WorkspacePreferenceError } from './workspace-preferences.ts';
import { isNodeQueueCandidate, firstNodeQueueCandidate, type NodeQueueReason, type NodeQueueEntry } from '../shared/node-queue.ts';
import { minimumRemoteConcurrency, maximumRemoteConcurrency } from '../shared/execution-concurrency.ts';
import { ResourceCatalog } from './resource-catalog.ts';
import { ResourceNetwork, type ResourceTransport } from './resource-network.ts';
import { ResourceFiles } from './resource-files.ts';
import { probeResourceCapabilities, ResourceCapabilityCache } from './resource-capabilities.ts';
import { validResourceQuery } from '../shared/resources.ts';
import { WorkflowRuntime } from './workflow-runtime.ts';
import { installWorkflowAPI } from './workflow-api.ts';
import { KnowledgeStore } from './knowledge-store.ts';
import { KnowledgeNetwork } from './knowledge-network.ts';
import { KnowledgeTools, type KnowledgeTask } from './knowledge-tools.ts';
import { startKnowledgeBridge } from './knowledge-engine.ts';
import { installKnowledgeAPI } from './knowledge-api.ts';
import { UpdateMaintenance, updateBlockers, canPrepareUpdate } from './update-maintenance.ts';
import { ConversationHistory, HistoryError, historyFileIDs } from './conversation-history.ts';
import { conversations } from '../shared/conversations.ts';
import { isLocked } from './store.ts';
import { publishHeadlessControl } from './headless-control.ts';

try {
  acquireDataLock();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
const app = express();
const creationRequests = new CreationRequestStore(db);
const taskAttention = new TaskAttentionStore(db);
const workspacePreferences = new WorkspacePreferences(db);
const nodeQueue = new NodeQueueStore(db);
const nodeHealth = new NodeHealthMonitor();
const updateMaintenance = new UpdateMaintenance();
let updateLease: string | null = null;
let updateTargetVersion: string | null = null;
let lastQueueProgressAt: string | null = null;
const nodeNetwork = new NodeNetwork(dataRoot);
nodeNetwork.setUpdateMaintenance(() => updateMaintenance.active);
const executionPolicies = new ExecutionPolicyStore(dataRoot);
try {
  executionPolicies.load();
} catch (error) {
  console.error(error instanceof Error ? error.message : '本机执行能力配置无法读取。');
}
let workerSampler: WorkerResourceSampler | null = null;
let resources: { catalog: ResourceCatalog; directory: ResourceNetwork; files: ResourceFiles } | null = null;
let knowledge: { store: KnowledgeStore; network: KnowledgeNetwork; tools: KnowledgeTools } | null = null;
let knowledgeBridge: Awaited<ReturnType<typeof startKnowledgeBridge>> | null = null;
function knowledgeTask(value: Task, directory: string): KnowledgeTask {
  const snapshot = nodeNetwork.snapshot();
  const privateLocal = !!user(value.creatorID)?.owner && !value.remoteOrigin;
  const origin = value.remoteOrigin ? snapshot.paired?.find((p) => p.id === value.remoteOrigin!.ownerNodeID) : null;
  return { id: value.id, sessionID: value.sessionID || '', projectID: value.projectID, directory, privateLocal,
    canWriteMemory: value.collaboration?.role !== 'planner',
    brainIDs: snapshot.brains.filter((brain) => privateLocal || origin?.trusted && origin.brains.some((b) => b.id === brain.id && b.masterNodeID === brain.masterNodeID)).map((b) => b.id) };
}
setTaskKnowledgeContext((value, directory) => {
  if (!knowledge) return '';
  return `\nCurrent local project ID: ${value.projectID}. Node ID: ${knowledge.store.nodeID}.` + knowledge.tools.rules(knowledgeTask(value, directory));
});
const workflowRuntime = new WorkflowRuntime({ network: nodeNetwork, queue: nodeQueue, policies: executionPolicies,
  resources: () => resources, queueHealth, occupiedSlots, kickQueue: () => queueMicrotask(() => void processRemoteTasks()) });
const conversationHistory = new ConversationHistory(db, {
  runtime: new RuntimeHistory(db, { engineRoot, withClient: (binding, work) => binding.accountID
    ? accountEngines.maintenance(binding.accountID, work) : work(engineClient()) }),
  data: () => ({ tasks: tasks(), workflows: workflowRuntime.store.list(), projects: projects(), network: nodeNetwork.snapshot() }),
  queue: () => nodeQueue.list(),
  files: (m) => [...nodeNetwork.files.historyFiles(m), ...historyFileIDs(workspacePreferences.draftsForConversations(
    ['local', 'remote', 'brain', 'workflow'].flatMap((scope) => m[scope as 'local' | 'remote' | 'brain' | 'workflow'].map((id) => `${scope}:${id}`))))],
  busy: (m) => m.local.some((id) => isLocked(id)) || m.workflow.some((id) => workflowRuntime.service.isAdvancing(id)) ||
    workflowRuntime.historyBusy(m.local) || nodeNetwork.historyBusy(m) || m.remote.some((id) => processingRemoteTasks.has(id)) ||
    m.remote.length > 0 && processingRemoteControls.size > 0,
  purge: (m, files, protectedIDs) => {
    for (const id of historyFileIDs(workspacePreferences.draftsForConversations(
      ['local', 'remote', 'brain', 'workflow'].flatMap((scope) => m[scope as 'local' | 'remote' | 'brain' | 'workflow'].map((id) => `${scope}:${id}`)), true))) protectedIDs.add(id);
    for (const row of db.prepare('SELECT execution_id,body FROM workflow_contexts').all())
      if (![...m.local, ...m.remote].includes(String(row.execution_id))) for (const id of historyFileIDs(JSON.parse(String(row.body)))) protectedIDs.add(id);
    for (const row of db.prepare('SELECT task_id,body FROM workflow_outputs').all())
      if (!m.local.includes(String(row.task_id))) for (const id of historyFileIDs(JSON.parse(String(row.body)))) protectedIDs.add(id);
    nodeNetwork.files.purgeHistory(m, files, protectedIDs);
    nodeNetwork.purgeHistory(m);
    knowledge?.tools.removeTasks(m.local);
    db.exec('BEGIN IMMEDIATE');
    try {
      nodeQueue.purgeHistory(m);
      for (const id of m.local) {
        db.prepare('DELETE FROM activities WHERE task_id=?').run(id);
        db.prepare('DELETE FROM task_engine_intents WHERE task_id=?').run(id);
        db.prepare('DELETE FROM workflow_outputs WHERE task_id=?').run(id);
        db.prepare('DELETE FROM tasks WHERE id=?').run(id);
      }
      for (const id of [...m.local, ...m.remote]) db.prepare('DELETE FROM workflow_contexts WHERE execution_id=?').run(id);
      for (const id of m.workflow) db.prepare('DELETE FROM workflows WHERE id=?').run(id);
      workspacePreferences.forgetConversations(['local', 'remote', 'brain', 'workflow'].flatMap((scope) =>
        m[scope as 'local' | 'remote' | 'brain' | 'workflow'].map((id) => `${scope}:${id}`)));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  },
});
nodeNetwork.setHistoryRetired((id) => !!db.prepare('SELECT 1 FROM conversation_retired WHERE id=? LIMIT 1').get(id));
let historySweeping = false;
async function sweepConversationHistory() {
  if (historySweeping) return;
  const release = updateMaintenance.enterOperation();
  if (!release) return;
  historySweeping = true;
  try { await conversationHistory.sweep(); } finally { historySweeping = false; changed(); release(); }
}
const historyCleanup = setInterval(sweepConversationHistory, 60 * 60 * 1000);
historyCleanup.unref();
let resourceConfiguration = '';
let knowledgeIdentityAttempted = false;
const resourceCapabilities = new ResourceCapabilityCache();
function configureResources() {
  const snapshot = nodeNetwork.snapshot(); const ownNode = snapshot.local;
  let knowledgeNodeID = ownNode?.id;
  if (!knowledge && !knowledgeNodeID && snapshot.status !== 'starting' && !knowledgeIdentityAttempted) {
    knowledgeIdentityAttempted = true;
    try {
      const identityPath = join(dataRoot, 'node-identity.json');
      // Local memory needs only the public identity. Existing memory remains available
      // when discovery is disabled or Windows cannot currently decrypt the private key.
      const stored = existsSync(identityPath) ? JSON.parse(readFileSync(identityPath, 'utf8')) : loadNodeIdentity(dataRoot);
      if (typeof stored.nodeID === 'string' && /^[A-Za-z0-9_-]{32}$/.test(stored.nodeID)) knowledgeNodeID = stored.nodeID;
    } catch { /* Keep ordinary local task execution available if Node identity is unavailable. */ }
  }
  const policy = executionPolicies.snapshot();
  const selected = policy.projectID ? projects().find((candidate) => candidate.id === policy.projectID) || null : null;
  if (!knowledge && knowledgeNodeID) {
    const store = new KnowledgeStore(dataRoot, knowledgeNodeID, changed);
    const network = new KnowledgeNetwork(store, { snapshot: () => nodeNetwork.snapshot(),
      trusted: (id) => nodeNetwork.isTrustedNode(id), request: (id, op, payload) => nodeNetwork.collaborationRequest(id, op, payload) });
    const tools = new KnowledgeTools(store, network, (sessionID, directory) => {
      const row = db.prepare("SELECT body FROM tasks WHERE json_extract(body,'$.sessionID')=?").get(sessionID);
      const value: Task | null = row ? JSON.parse(String(row.body)) : null;
      if (!value || !['running', 'waiting_approval', 'waiting_input'].includes(value.state) ||
        resolve(project(value.projectID).directory).toLowerCase() !== resolve(directory).toLowerCase() ||
        updateMaintenance.active) throw new Error('knowledge_task_not_active');
      return knowledgeTask(value, directory);
    });
    knowledge = { store, network, tools }; store.scheduleOrganization();
  }
  if (!ownNode) return;
  if (!resources) {
    const transport: ResourceTransport = {
      localName: () => nodeNetwork.snapshot().local?.name || 'Local',
      peers: () => nodeNetwork.snapshot().paired || [],
      trusted: (nodeID) => nodeNetwork.isTrustedNode(nodeID),
      request: (nodeID, operation, payload) => nodeNetwork.collaborationRequest(nodeID, operation, payload),
    };
    const catalog = new ResourceCatalog(dataRoot, ownNode.id, {
      changed: () => { resources?.directory.localChanged(); },
      capabilities: async () => {
        const currentPolicy = executionPolicies.snapshot();
        const currentProject = projects().find((candidate) => candidate.id === currentPolicy.projectID);
        if (!currentProject) return [];
        const key = JSON.stringify([currentProject.directory, engineStatus.ready, engineStatus.models]);
        return resourceCapabilities.get(key, () => probeResourceCapabilities(currentProject.directory, dataRoot, engineStatus.ready ? engineStatus.models : []));
      },
    });
    const directory = new ResourceNetwork(dataRoot, catalog, transport, changed);
    resources = { catalog, directory, files: new ResourceFiles(dataRoot, catalog, nodeNetwork.files, transport) };
    nodeNetwork.setCollaborationHandler((peer, operation, payload) =>
      operation === 'knowledge' ? knowledge!.network.handle(peer, payload) :
      operation.startsWith('execution-') ? workflowRuntime.handle(peer, operation, payload) :
      operation === 'resource-prepare' || operation === 'resource-chunk'
        ? resources!.files.handle(peer, operation, payload) : directory.handle(peer, operation, payload));
    directory.start();
  }
  const configuration = JSON.stringify([selected?.id, selected?.directory, engineStatus.ready, engineStatus.models]);
  if (configuration !== resourceConfiguration) {
    resourceConfiguration = configuration;
    void resources.catalog.configure(selected ? { id: selected.id, name: selected.name, directory: selected.directory } : null)
      .then(() => resources?.catalog.scheduleRefresh()).catch(() => undefined);
  }
  resources.directory.reconcile();
}
nodeNetwork.on('update', configureResources);
nodeNetwork.setWorkerRegistrationProvider((nodeID) => {
  const policy = executionPolicies.snapshot();
  const configuredProject = policy.projectID
    ? projects().find((candidate) => candidate.id === policy.projectID) || null
    : null;
  const accepting =
    !updateMaintenance.active &&
    policy.enabled &&
    !!configuredProject &&
    !!policy.model &&
    engineStatus.ready &&
    engineStatus.models.some((candidate) => candidate.id === policy.model);
  const runningTasks = incomingOccupiedSlots();
  workerSampler ||= new WorkerResourceSampler(dataRoot);
  const report = workerSampler.sample({
    nodeID,
    accepting,
    projects: configuredProject ? [{ id: configuredProject.id, name: configuredProject.name }] : [],
    runningTasks,
    maxConcurrent: policy.maxConcurrent,
  });
  if (report) nodeHealth.observeResource(report.load);
  return report;
});
function queueForRemote(remote: RemoteTaskInvite) {
  return nodeQueue.findBySource({
    kind: 'remote',
    remoteTaskID: remote.id,
    ownerNodeID: remote.ownerNodeID,
    ownerBrainID: remote.ownerBrainID,
    ...(remote.brainTaskID ? { brainTaskID: remote.brainTaskID } : {}),
  });
}
function currentOccupancy(excludeTaskID?: string, excludeQueueID?: string) {
  return executionOccupancy({
    tasks: taskQueries.inStates([...activeStates, 'review', 'interrupted', 'ready']),
    queue: nodeQueue.list(), remotes: nodeNetwork.remoteTaskRecords(),
    taskState: (id) => taskQueries.stateForID(id), excludeTaskID, excludeQueueID,
  });
}
function occupiedSlots(excludeTaskID?: string, excludeQueueID?: string) {
  const occupied = currentOccupancy(excludeTaskID, excludeQueueID);
  return occupied.localOccupied + occupied.remoteOccupied;
}
function incomingOccupiedSlots(excludeTaskID?: string, excludeQueueID?: string) {
  return currentOccupancy(excludeTaskID, excludeQueueID).remoteOccupied;
}
function assertExecutionCapacity(value: Task, entry?: NodeQueueEntry | null) {
  if (!isRemoteExecution(value, nodeQueue.list(), nodeNetwork.remoteTaskRecords())) return;
  requireThat(executionPolicies.allows(), 409, '本机执行能力已关闭。');
  // A lower limit cannot revoke an execution or a durable admission already granted.
  if (entry?.state === 'admitted' || occupiesWorkerSlot(value)) return;
  requireThat(incomingOccupiedSlots(value.id, entry?.id) < executionPolicies.snapshot().maxConcurrent,
    409, '其他机器任务的并发名额已用满，请等待或调整并发设置。');
}
function queueHealth() {
  const snapshot = nodeQueue.snapshot();
  const localCandidate = firstNodeQueueCandidate(snapshot.entries, 'local');
  return nodeHealth.assess({
    queue: snapshot,
    availableSlots: localCandidate ? 1 : Math.max(0, executionPolicies.snapshot().maxConcurrent - incomingOccupiedSlots()),
    executionPaused: !localCandidate && !executionPolicies.allows(),
    lastDispatchProgressAt: lastQueueProgressAt,
  });
}
nodeNetwork.setNodeQueueProvider(() => {
  const health = queueHealth();
  const snapshot = nodeQueue.snapshot();
  const occupancy = currentOccupancy();
  return {
    waitingCount: health.waitingCount,
    paused: snapshot.paused || !executionPolicies.allows(),
    updatedAt: snapshot.updatedAt,
    sampledAt: health.updatedAt,
    health: health.state,
    workload: {
      occupiedSlots: occupancy.remoteOccupied,
      totalSlots: executionPolicies.snapshot().maxConcurrent,
      executingCount: occupancy.remoteExecuting,
    },
    concurrency: { ...occupancy, remoteLimit: executionPolicies.snapshot().maxConcurrent },
  };
});
function intakeRemoteQueue(remote: RemoteTaskInvite) {
  requireThat(!updateMaintenance.active, 503, '正在准备软件更新，请稍后重试。');
  if (remote.direction !== 'incoming' || !remote.automaticEligible || remote.brainTaskID) return;
  if (!['pending', 'accepted'].includes(remote.status)) return;
  if (queueForRemote(remote)) return;
  if (!queueHealth().accepting)
    throw new NodeNetworkError(409, '目标 Node 等待队列已达到接收上限，请稍后重试。');
  nodeQueue.enqueue({
    kind: 'remote',
    remoteTaskID: remote.id,
    ownerNodeID: remote.ownerNodeID,
    ownerBrainID: remote.ownerBrainID,
  });
}
nodeNetwork.setRemoteTaskQueueIntake(intakeRemoteQueue);
nodeNetwork.setRemoteQueueStartGuard((remoteTaskID) => {
  if (updateMaintenance.active) return false;
  const remote = nodeNetwork.remoteTask(remoteTaskID);
  if (!remote) return false;
  const entry = queueForRemote(remote);
  return !entry || entry.state !== 'ended' || (entry.endReason?.code === 'stopped' &&
    !!entry.localTaskID && entry.localTaskID === remote.localTaskID);
});
setTaskInputMaterializer((value, directory) => {
  if (!value.inputFiles?.length) return [];
  return nodeNetwork.files.materialize(
    { scope: 'local', taskID: value.id, purpose: 'input' },
    value.inputFiles,
    directory,
  );
});
setTaskStartGuard((value, options) => {
  conversationHistory.assertAvailable('local', value.id);
  requireThat(!updateMaintenance.active, 503, '正在准备软件更新，请稍后重试。');
  if (value.inputFiles?.length)
    requireThat(
      nodeNetwork.files.complete(
        { scope: 'local', taskID: value.id, purpose: 'input' },
        value.inputFiles,
      ),
      409,
      '任务附件尚未完整接收。',
    );
  const entry = nodeQueue.list().find((candidate) => candidate.localTaskID === value.id);
  requireThat(
    !entry || entry.state === 'admitted' || (entry.state === 'ended' && entry.endReason?.code === 'stopped') ||
      (options?.continuation && !value.collaboration && !value.remoteOrigin && entry.source.kind === 'local' &&
        entry.state === 'ended' && entry.endReason?.code === 'completed'),
    409,
    '此任务由 Node 队列管理，请等待准入或使用队列操作。',
  );
  assertExecutionCapacity(value, entry);
  if (value.remoteOrigin)
    requireThat(
      nodeNetwork.isTrustedNode(value.remoteOrigin.ownerNodeID) &&
        nodeNetwork.remoteTask(value.remoteOrigin.remoteTaskID)?.status === 'accepted',
      409,
      '任务来源设备已撤信或原投递已终止。',
    );
});
const port = Number(process.env.PORT || 4310);
const dev = process.argv.includes('--dev');
const desktop = process.env.RIVLOOM_DESKTOP === '1';
const headless = process.env.RIVLOOM_HEADLESS === '1';
if (desktop && headless) throw new Error('Desktop and headless modes cannot run together.');
if (headless && dev) throw new Error('Headless mode cannot serve the development UI.');
const headlessToken = headless ? token() : null;
let removeHeadlessControl = () => {};
const desktopToken = desktop ? token() : null;
const desktopTokenPath = join(dataRoot, 'desktop-auth-token.txt');
if (desktopToken)
  writeFileSync(desktopTokenPath, desktopToken, { encoding: 'utf8', mode: 0o600, flag: 'w' });
const removeDesktopToken = () => {
  if (desktopToken && existsSync(desktopTokenPath)) unlinkSync(desktopTokenPath);
};
process.once('exit', removeDesktopToken);
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const origins = new Set([...allowedHosts].map((h) => `http://${h}`));
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store',
  });
  if (!allowedHosts.has(req.headers.host || ''))
    return void res.status(403).json({ error: '不允许的 Host，请使用本机地址或 SSH 隧道' });
  if (!dev)
    res.set(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'${desktop ? ' ipc: http://ipc.localhost' : ''}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
    );
  if (req.path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (
      req.headers['x-rivloom-request'] !== '1' ||
      (req.headers.origin && !origins.has(req.headers.origin))
    )
      return void res.status(403).json({ error: '请求来源校验失败' });
  }
  next();
});
app.use('/api/ui/drafts', express.json({ limit: '2mb' }));
app.use('/api/knowledge', express.json({ limit: '512kb' }));
app.use(express.json({ limit: '128kb' }));
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ||
    req.path.startsWith('/api/desktop-update/')) return next();
  const finish = updateMaintenance.enterOperation();
  if (!finish) return void res.status(503).json({ error: '正在准备软件更新，请稍后重试。' });
  res.once('finish', finish);
  // An aborted response does not prove its async handler has finished writing.
  // Keep an uncertain request as a blocker until service restart.
  next();
});

function authorizeNativeUpdate(req: Request) {
  const provided = req.headers['x-rivloom-desktop-token'];
  requireThat(desktop && desktopToken, 404, '接口不存在');
  requireThat(typeof provided === 'string' && sameToken(provided, desktopToken), 403, '桌面身份校验失败');
}
function currentUpdateBlockers() {
  const network = nodeNetwork.snapshot();
  return updateBlockers({ tasks: tasks(), queues: nodeQueue.list(), workflows: workflowRuntime.store.list(),
    remoteTasks: network.remoteTasks, brainTasks: network.brainTasks,
    transfers: nodeNetwork.files.active ? nodeNetwork.files.deliveries().length : 0,
    operations: updateMaintenance.pending + processingRemoteTasks.size + processingRemoteControls.size + nodeNetwork.updateOperations,
    modelChecks: Object.values(modelSettings().checks).filter((check) => check.status === 'testing').length });
}
app.post('/api/desktop-update/prepare', async (req, res) => {
  authorizeNativeUpdate(req);
  const body = z.object({ version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/).max(80) }).strict().parse(req.body);
  requireThat(updateMaintenance.acquire(), 409, '已有更新安装正在准备。');
  try {
    // Drain requests that entered before the gate. New intake is fenced synchronously.
    const deadline = Date.now() + 3000;
    let blockers = currentUpdateBlockers();
    while (blockers.operations && Date.now() < deadline) {
      await new Promise<void>((done) => setTimeout(done, 40));
      blockers = currentUpdateBlockers();
    }
    if (!canPrepareUpdate(blockers)) {
      updateMaintenance.release();
      return void res.json({ ready: false, blockers, lease: null });
    }
    updateLease = id(); updateTargetVersion = body.version;
    res.json({ ready: true, blockers, lease: updateLease });
  } catch (error) { updateMaintenance.release(); throw error; }
});
app.post('/api/desktop-update/cancel', (req, res) => {
  authorizeNativeUpdate(req);
  const body = z.object({ lease: z.string().uuid() }).strict().parse(req.body);
  requireThat(!updateMaintenance.committed && body.lease === updateLease, 409, '更新准备状态已改变。');
  updateLease = null; updateTargetVersion = null; updateMaintenance.release();
  res.json({ released: true });
});
app.post('/api/desktop-update/commit', (req, res) => {
  authorizeNativeUpdate(req);
  const body = z.object({ lease: z.string().uuid() }).strict().parse(req.body);
  requireThat(!updateMaintenance.committed && updateMaintenance.active && body.lease === updateLease, 409, '更新准备状态已改变。');
  const blockers = currentUpdateBlockers();
  if (!canPrepareUpdate(blockers)) {
    updateLease = null; updateTargetVersion = null; updateMaintenance.release();
    return void res.status(409).json({ error: '还有工作尚未结束，请稍后安装更新。', blockers });
  }
  const update = { lease: body.lease, version: updateTargetVersion! };
  requireThat(updateMaintenance.commit(), 409, '更新准备状态已改变。');
  res.json({ ready: true });
  setImmediate(() => void shutdown(update).catch(() => process.exit(1)));
});
app.get('/api/health', (_req, res) => res.json({ ok: true, engineReady: engineStatus.ready }));
app.get('/api/auth/state', (_req, res) => res.json({ setupRequired: !users().length }));
const credentials = z.object({
  username: z.string().regex(/^[a-z0-9_-]{3,30}$/),
  password: z.string().min(12).max(128),
});
const registration = credentials.extend({ name: z.string().trim().min(1).max(40) });
app.post('/api/auth/setup', rateLimit, (req, res) => {
  const body = registration.extend({ code: z.string().min(1).max(128) }).parse(req.body);
  checkSetup(body.code);
  const created = createUser(body.username, body.name, body.password, true);
  finishSetup();
  login(res, created.id);
  res.json(created);
});
app.post('/api/auth/login', rateLimit, (req, res) => {
  const body = credentials.parse(req.body);
  const found = db.prepare('SELECT id,password FROM users WHERE username=?').get(body.username);
  requireThat(
    found && verifyPassword(body.password, found.password as string),
    401,
    '用户名或密码错误',
  );
  login(res, found.id as string);
  res.json(user(found.id as string));
});
app.post('/api/auth/desktop', rateLimit, (req, res) => {
  requireThat(desktop && desktopToken, 404, '接口不存在');
  const provided = req.headers['x-rivloom-desktop-token'];
  requireThat(
    typeof provided === 'string' && sameToken(provided, desktopToken),
    403,
    '桌面身份校验失败',
  );
  let local = users().find((candidate) => candidate.owner) || users()[0];
  if (!local) {
    local = createUser('local_owner', '本机操作者', token(), true);
    finishSetup();
  }
  login(res, local.id);
  res.json(local);
});
// The 256-bit local capability is not a password. Repeated valid CLI logins must
// not consume the shared password-attempt budget used by the browser endpoints.
app.post('/api/auth/headless', (req, res) => {
  requireThat(headless && headlessToken, 404, '接口不存在');
  const provided = req.headers['x-rivloom-headless-token'];
  requireThat(typeof provided === 'string' && sameToken(provided, headlessToken!), 403, '本机命令行身份校验失败');
  let local = users().find((candidate) => candidate.owner);
  if (!local) {
    requireThat(!users().length, 409, '找不到本机所有者，请检查数据目录。');
    local = createUser('local_owner', '本机操作者', token(), true);
    finishSetup();
  }
  login(res, local.id);
  res.json(local);
});
app.post('/api/auth/join', rateLimit, (req, res) => {
  const body = registration.extend({ code: z.string().min(1).max(128) }).parse(req.body);
  const invitation = db
    .prepare('SELECT * FROM invitations WHERE token=? AND expires>? AND used=0')
    .get(hash(body.code), Date.now());
  requireThat(invitation, 403, '邀请码无效、已使用或已过期');
  db.exec('BEGIN IMMEDIATE');
  try {
    const created = createUser(body.username, body.name, body.password);
    db.prepare('UPDATE invitations SET used=1 WHERE token=?').run(hash(body.code));
    db.exec('COMMIT');
    login(res, created.id);
    res.json(created);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});
app.use('/api', authenticated);
const who = (req: Request) => (req as AuthRequest).user;
app.use('/api', (req, _res, next) => {
  const route = req.path.match(/^\/(workflows|tasks|network\/tasks)\/([^/]+)/);
  if (route) conversationHistory.assertAvailable(route[1] === 'workflows' ? 'workflow' : route[1] === 'tasks' ? 'local' : 'remote', route[2]);
  next();
});
installWorkflowAPI(app, workflowRuntime, nodeNetwork, who);
const workflowMemory = (req: Request) => {
  requireNetworkOwner(req);
  const value = workflowRuntime.store.get(String(req.params.id));
  requireThat(value && value.creatorID === who(req).id, 404, '协作任务不存在。');
  requireThat(knowledge, 503, 'knowledge_unavailable');
  return { value, memory: new WorkflowKnowledge(knowledge!.store, workflowRuntime.store.history) };
};
app.get('/api/workflows/:id/context/memory', (req, res) => {
  const { value, memory } = workflowMemory(req); res.json(memory.list(value));
});
app.post('/api/workflows/:id/context/memory', (req, res) => {
  const { value, memory } = workflowMemory(req); res.json(memory.promote(value, req.body)); changed();
});
app.post('/api/workflows/:id/context/memory/withdraw', (req, res) => {
  const { value, memory } = workflowMemory(req); res.json(memory.withdraw(value, req.body)); changed();
});
installKnowledgeAPI(app, () => knowledge, who, projects);
installProjectChangesAPI(app, who, projects);
installPromptTemplateAPI(app, who, new PromptTemplateStore(db));
function visibleTask(req: Request) {
  const t = task(String(req.params.id));
  requireThat(participant(t, who(req)), 403, '你不是此任务的参与者');
  return t;
}
function visibleNetwork(req: Request) {
  const raw = nodeNetwork.snapshot();
  const snapshot = { ...raw, remoteTasks: raw.remoteTasks.filter((v) => !conversationHistory.retired('remote', v.id)),
    brainTasks: raw.brainTasks.filter((v) => !conversationHistory.retired('brain', v.id)) };
  if (who(req).owner) return snapshot;
  const visibleTasks = tasks().filter((value) => participant(value, who(req)));
  const remoteTasks = snapshot.remoteTasks.filter(
    (remote) =>
      remote.direction === 'incoming' &&
      remote.localTaskID !== null &&
      visibleTasks.some(
        (value) =>
          value.id === remote.localTaskID &&
          value.remoteOrigin?.remoteTaskID === remote.id &&
          value.remoteOrigin.ownerNodeID === remote.ownerNodeID &&
          value.remoteOrigin.ownerBrainID === remote.ownerBrainID,
      ),
  );
  return {
    ...snapshot,
    remoteTasks,
    brainTasks: snapshot.brainTasks.filter((brain) =>
      remoteTasks.some(
        (remote) =>
          remote.brainTaskID === brain.id &&
          remote.ownerBrainID === brain.brainID &&
          remote.id === brain.executionID,
      ),
    ),
  };
}
app.post('/api/auth/logout', (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token=?').run(hash(sessionToken(req)));
  res.clearCookie('rivloom_session', { path: '/' });
  res.json({ ok: true });
});
function bootstrap(req: Request): Bootstrap {
  return conversationHistory.filter({
    directoryAliases: workspacePreferences.directoryAliases(who(req).id),
    conversationPreferences: workspacePreferences.conversationPreferences(who(req).id),
    conversationDrafts: workspacePreferences.conversationDrafts(who(req).id),
    user: who(req),
    users: users(),
    projects: projects(),
    tasks: tasks().filter((t) => participant(t, who(req))),
    workflows: workflowRuntime.store.list(who(req).id),
    engine: engineStatus,
    defaultModel: defaultModel(),
    executionPolicy: executionPolicies.snapshot(),
    network: visibleNetwork(req),
    ...(who(req).owner ? { conversationTrash: conversationHistory.list() } : {}),
    ...(who(req).owner ? { resourceDirectory: resources?.directory.nodes() || [] } : {}),
  });
}
app.get('/api/bootstrap', (req, res) => res.json(bootstrap(req)));
app.post('/api/history/trash', (req, res) => {
  requireNetworkOwner(req);
  const { key } = z.object({ key: z.string().min(1).max(100) }).strict().parse(req.body);
  const entry = conversationHistory.trash(key, bootstrap(req)); changed(); res.json(entry);
});
app.post('/api/history/restore', (req, res) => {
  requireNetworkOwner(req);
  const { key } = z.object({ key: z.string().min(1).max(100) }).strict().parse(req.body);
  conversationHistory.restore(key); changed(); res.json({ ok: true });
});
app.post('/api/history/purge', async (req, res) => {
  requireNetworkOwner(req);
  const { key } = z.object({ key: z.string().min(1).max(100), confirmed: z.literal(true) }).strict().parse(req.body);
  try { await conversationHistory.purge(key); res.json({ ok: true }); } finally { changed(); }
});
app.post('/api/history/empty', async (req, res) => {
  requireNetworkOwner(req); z.object({ confirmed: z.literal(true) }).strict().parse(req.body);
  try { res.json(await conversationHistory.sweep(false)); } finally { changed(); }
});
app.get('/api/ui/sidebar-widths', (req, res) =>
  res.json(workspacePreferences.sidebarWidths(who(req).id)),
);
app.post('/api/ui/sidebar-widths', (req, res) =>
  res.json(workspacePreferences.saveSidebarWidths(who(req).id, req.body)),
);
app.post('/api/ui/directory-alias', (req, res) => {
  const aliases = workspacePreferences.saveDirectoryAlias(who(req).id, req.body);
  changed(); res.json(aliases);
});
app.post('/api/ui/conversation', (req, res) => {
  workspacePreferences.saveConversationPreference(who(req).id, req.body, conversations(bootstrap(req)).map((item) => item.key));
  changed(); res.json({ ok: true });
});
app.post('/api/ui/drafts', (req, res) => {
  workspacePreferences.saveConversationDrafts(who(req).id, req.body); res.json({ saved: true });
});
app.post('/api/attention/check', (req, res) => res.json(taskAttention.check(bootstrap(req))));
app.post('/api/attention/preferences', (req, res) =>
  res.json(taskAttention.savePreferences(who(req).id, req.body)),
);
app.get('/api/model-settings', (_req, res) => res.json(modelSettings()));
app.get('/api/network', (req, res) => res.json(visibleNetwork(req)));
app.get('/api/network/execution-policy', (_req, res) => res.json(executionPolicies.snapshot()));
app.get('/api/resources', (req, res) => {
  requireNetworkOwner(req);
  res.json({ nodes: resources?.directory.nodes() || [] });
});
app.post('/api/resources/query', async (req, res) => {
  requireNetworkOwner(req);
  requireThat(validResourceQuery(req.body), 400, '资源查询条件无效。');
  requireThat(resources, 503, '资源目录正在初始化，请稍后重试。');
  res.json(await resources!.directory.query(req.body));
});
app.post('/api/resources/refresh', async (req, res) => {
  requireNetworkOwner(req);
  requireThat(resources, 503, '资源目录正在初始化，请稍后重试。');
  await resources!.catalog.refresh(); resources!.directory.reconcile();
  res.json({ nodes: resources!.directory.nodes() });
});
const requireNetworkOwner = (req: Request) =>
  requireThat(who(req).owner, 403, '只有本机所有者可以管理设备信任');
app.post('/api/network/diagnostics/retry', async (req, res) => {
  requireNetworkOwner(req);
  const input = z
    .object({
      nodeID: z
        .string()
        .regex(/^[A-Za-z0-9_-]{32}$/)
        .optional(),
    })
    .strict()
    .parse(req.body);
  await nodeNetwork.retryConnection(input.nodeID);
  res.json(visibleNetwork(req));
});
app.post('/api/network/profile', (req, res) => {
  requireNetworkOwner(req);
  requireThat(validNodeProfile(req.body), 400, '请输入 1–80 字的名称，并选择图标或上传小图片。');
  res.json(nodeNetwork.saveProfile(req.body as NodeProfile));
});
app.post('/api/network/pairings', async (req, res) => {
  requireNetworkOwner(req);
  const { nodeID } = z.object({ nodeID: z.string().regex(/^[A-Za-z0-9_-]{32}$/) }).parse(req.body);
  res.status(201).json(await nodeNetwork.requestPairing(nodeID));
});
app.post('/api/network/pairings/:id/confirm', async (req, res) => {
  requireNetworkOwner(req);
  const pairingID = z.string().uuid().parse(req.params.id);
  res.json(await nodeNetwork.confirmPairing(pairingID));
});
app.post('/api/network/pairings/:id/cancel', async (req, res) => {
  requireNetworkOwner(req);
  const pairingID = z.string().uuid().parse(req.params.id);
  res.json(await nodeNetwork.cancelPairing(pairingID));
});
app.post('/api/network/trusted/:nodeID/revoke', async (req, res) => {
  requireNetworkOwner(req);
  const nodeID = z
    .string()
    .regex(/^[A-Za-z0-9_-]{32}$/)
    .parse(req.params.nodeID);
  z.object({ confirmed: z.literal(true) }).parse(req.body);
  res.json(await nodeNetwork.revokeTrust(nodeID));
});
const networkNodeID = (value: unknown) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]{32}$/)
    .parse(value);
app.post('/api/network/nodes/:nodeID/remark', (req, res) => {
  requireNetworkOwner(req);
  const { remark } = z.object({ remark: z.string().trim().max(80).nullable() }).parse(req.body);
  res.json(nodeNetwork.savePeerRemark(networkNodeID(req.params.nodeID), remark || null));
});
app.post('/api/network/execution-policy', (req, res) => {
  requireNetworkOwner(req);
  const input = z
    .object({
      enabled: z.boolean(),
      approvalMode: z.enum(['ask', 'auto', 'full']),
      projectID: z.string().uuid().nullable(),
      model: z.string().min(3).max(200).nullable(),
      reasoningEffort: z.unknown().refine(validReasoningEffort).optional(),
      confirmed: z.literal(true),
      maxConcurrent: z.number().int().min(minimumRemoteConcurrency).max(maximumRemoteConcurrency).optional(),
    })
    .parse(req.body);
  if (input.enabled) {
    requireThat(input.projectID && input.model, 400, '开启执行能力前请选择本机项目和模型。');
    project(input.projectID);
    requireThat(
      engineStatus.models.some((candidate) => candidate.id === input.model),
      400,
      '所选模型当前不可用，请先在本机模型设置中连接。',
    );
  }
  requireThat(!input.enabled || reasoningSupported(engineStatus.models.find(m => m.id === input.model), input.reasoningEffort), 400,
    '所选思考等级当前不可用，请重新选择思考等级或使用自动。');
  const saved = executionPolicies.save({
    enabled: input.enabled,
    approvalMode: input.approvalMode,
    projectID: input.projectID,
    model: input.model, reasoningEffort: input.reasoningEffort,
    ...(input.maxConcurrent !== undefined ? { maxConcurrent: input.maxConcurrent } : {}),
  });
  configureResources();
  changed();
  queueMicrotask(() => void processRemoteTasks());
  res.json(saved);
});
app.post('/api/network/execution-concurrency', (req, res) => {
  requireNetworkOwner(req);
  const input = z.object({
    maxConcurrent: z.number().int().min(minimumRemoteConcurrency).max(maximumRemoteConcurrency),
  }).strict().parse(req.body);
  const saved = executionPolicies.saveConcurrency(input.maxConcurrent);
  changed();
  queueMicrotask(() => void processRemoteTasks());
  res.json(saved);
});
installTaskFileAPI(app, nodeNetwork, who, tasks, changed, (local, fileID) => workflowRuntime.fileLocations(local, fileID),
  (fileID) => historyFileIDs(workflowRuntime.store.list()).includes(fileID),
  { views: (id) => workflowRuntime.remoteFileViews(id), fetch: (id, fileID) => workflowRuntime.fetchResultFile(id, fileID) });
const attachmentIDsSchema = z.array(z.string().uuid()).max(taskFileUploadCount).optional();
const remoteTaskID = (req: Request) => z.string().uuid().parse(req.params.id);
app.post('/api/network/tasks', async (req, res) => {
  requireNetworkOwner(req);
  const input = z
    .object({
      title: z.string().trim().min(1).max(120),
      description: z.string().trim().min(1).max(4000),
      criteria: z.string().trim().min(1).max(2000),
      requestedProjectID: z.string().uuid().nullable().default(null),
      requirements: z
        .object({
          platform: z.string().min(1).max(40).optional(),
          architecture: z.string().min(1).max(40).optional(),
          minimumLogicalCores: z.number().int().positive().optional(),
          minimumMemoryBytes: z.number().int().positive().optional(),
          gpu: z.boolean().optional(),
          minimumGpuMemoryBytes: z.number().int().positive().optional(),
        })
        .default({}),
      confirmed: z.literal(true),
      requestID: z.string().uuid().optional(),
      attachmentIDs: attachmentIDsSchema,
      queueConfirmedFor: z.string().min(1).max(80).optional(),
    })
    .parse(req.body);
  const { requestID, attachmentIDs, queueConfirmedFor, ...normalized } = input;
  const inputFiles = nodeNetwork.files.uploaded(who(req).id, attachmentIDs || []);
  const createdTaskID = creationRequests.reserve(who(req).id, requestID, {
    routing: { kind: 'automatic' },
    ...normalized,
    ...(attachmentIDs?.length ? { attachmentIDs } : {}),
  });
  res.status(201).json(
    await nodeNetwork.createScheduledTask(
      {
        title: redact(input.title),
        description: redact(input.description),
        criteria: redact(input.criteria),
        requestedProjectID: input.requestedProjectID,
        requirements: input.requirements,
        ...inputFileFields(inputFiles),
      },
      createdTaskID,
      queueConfirmedFor,
    ),
  );
});
app.post('/api/network/nodes/:nodeID/tasks', async (req, res) => {
  requireNetworkOwner(req);
  const input = z
    .object({
      title: z.string().trim().min(1).max(120),
      description: z.string().trim().min(1).max(4000),
      criteria: z.string().trim().min(1).max(2000),
      requirements: z.object({}).default({}),
      confirmed: z.literal(true),
      requestID: z.string().uuid().optional(),
      attachmentIDs: attachmentIDsSchema,
      queueConfirmedFor: z.string().min(1).max(80).optional(),
    })
    .parse(req.body);
  const nodeID = networkNodeID(req.params.nodeID);
  const { requestID, attachmentIDs, queueConfirmedFor, ...normalized } = input;
  const inputFiles = nodeNetwork.files.uploaded(who(req).id, attachmentIDs || []);
  const createdTaskID = creationRequests.reserve(who(req).id, requestID, {
    routing: { kind: 'node', nodeID },
    ...normalized,
    ...(attachmentIDs?.length ? { attachmentIDs } : {}),
  });
  res.status(201).json(
    await nodeNetwork.createTaskForNode(
      nodeID,
      {
        title: redact(input.title),
        description: redact(input.description),
        criteria: redact(input.criteria),
        requirements: input.requirements,
        ...inputFileFields(inputFiles),
      },
      createdTaskID,
      queueConfirmedFor,
    ),
  );
});
app.post('/api/network/tasks/:id/cancel', async (req, res) => {
  requireNetworkOwner(req);
  z.object({ confirmed: z.literal(true) }).parse(req.body);
  res.json(await nodeNetwork.cancelRemoteTask(remoteTaskID(req)));
});
app.post('/api/network/tasks/:id/control', async (req, res) => {
  requireNetworkOwner(req);
  const input = z
    .object({
      expectedExecutionSequence: z.number().int().positive(),
      action: z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('permission'),
          requestID: z.string().min(1).max(200),
          reply: z.enum(['once', 'reject']),
        }),
        z.object({
          kind: z.literal('question'),
          requestID: z.string().min(1).max(200),
          answers: z
            .array(z.array(z.string().max(4000)).min(1).max(20))
            .min(1)
            .max(10),
        }),
        z.object({ kind: z.literal('stop') }),
        z.object({
          kind: z.literal('supplement'),
          text: z.string().trim().min(1).max(12_000),
        }),
        z.object({
          kind: z.literal('accept'),
          note: z.string().trim().min(1).max(4000),
        }),
      ]),
      confirmed: z.literal(true),
    })
    .parse(req.body);
  const id = remoteTaskID(req);
  const questionID = input.action.kind === 'question' ? input.action.requestID : null;
  const question = nodeNetwork.remoteTask(id)?.remoteQuestions?.find((q) => q.id === questionID);
  const result = await nodeNetwork.requestRemoteTaskControl(id, input.expectedExecutionSequence, input.action);
  if (question && input.action.kind === 'question') workflowRuntime.service.recordAnswers(id, input.action.requestID,
    question.questions.map((q) => q.question), input.action.answers);
  res.json(result);
});
app.post('/api/network/tasks/:id/prepare', async (req, res) => {
  requireNetworkOwner(req);
  const input = z
    .object({
      projectID: z.string().uuid(),
      model: z.string().min(3).max(200),
      confirmedProject: z.literal(true),
      confirmedModel: z.literal(true),
      confirmedLease: z.literal(true),
    })
    .parse(req.body);
  project(input.projectID);
  requireThat(
    engineStatus.models.some((candidate) => candidate.id === input.model),
    400,
    '所选模型当前不可用，请先在本机模型设置中连接。',
  );
  res.json(
    await exclusive(`project:${input.projectID}`, async () => {
      requireThat(
        !nodeNetwork.projectLeased(input.projectID),
        409,
        '该项目已为另一项远端任务保留。',
      );
      requireThat(
        !tasks().some(
          (candidate) =>
            candidate.projectID === input.projectID &&
            (activeStates.includes(candidate.state) ||
              candidate.state === 'review' ||
              candidate.state === 'interrupted'),
        ),
        409,
        '该项目已有执行中、待验收或未确认中断的任务。',
      );
      return nodeNetwork.prepareRemoteTask(remoteTaskID(req), input.projectID, input.model);
    }),
  );
});
app.post('/api/network/tasks/:id/preparation/revoke', async (req, res) => {
  requireNetworkOwner(req);
  z.object({ confirmed: z.literal(true) }).parse(req.body);
  res.json(await nodeNetwork.revokeRemoteTaskPreparation(remoteTaskID(req)));
});

const processingRemoteTasks = new Set<string>();
const workerAdmission = new WorkerAdmissionGate();
const processingRemoteControls = new Set<string>();
const queueReasonLabels: Partial<Record<NodeQueueReason['code'], string>> = {
  attachments_pending: '等待附件完整接收并通过校验',
  queue: '等待前面的任务',
  slot: '等待执行槽位（运行、待验收或状态待确认）',
  held: '本机所有者已暂缓此任务',
  queue_paused: 'Node 队列已暂停',
  execution_paused: 'Node 已暂停自动执行',
  model_unavailable: '等待本机模型可用',
  project_unavailable: '等待本机项目可用',
  engine_unavailable: '等待执行引擎就绪',
  hardware_unavailable: '等待硬件或资源条件满足',
  peer_unavailable: '等待原节点重新连接',
  acceptance_pending: '正在确认接收状态',
  state_unknown: '执行状态待确认，保留槽位',
  rejected: '执行节点已拒绝此任务',
  cancelled: '原任务已取消',
  expired: '原邀请已过期',
  trust_revoked: '来源设备的信任已撤销',
};
async function publishQueueReceipts() {
  for (const entry of nodeQueue.snapshot().entries) {
    if (entry.source.kind !== 'remote') continue;
    const remote = nodeNetwork.remoteTask(entry.source.remoteTaskID);
    if (!remote || remote.status !== 'accepted') continue;
    if (entry.state === 'ended' && entry.endReason?.code === 'completed') continue;
    const fact = entry.endReason || entry.blockReason;
    const safeReason = fact
      ? redact(fact.message || queueReasonLabels[fact.code] || '状态已更新').slice(0, 300)
      : null;
    await nodeNetwork
      .publishTaskQueueReceipt(remote.id, {
        state:
          entry.state === 'waiting' ? 'queued' : entry.state === 'ended' ? 'rejected' : entry.state,
        position: entry.position,
        reason: safeReason,
      })
      .catch(() => {});
  }
}
app.get('/api/node-queue', (req, res) => {
  requireNetworkOwner(req);
  res.json(nodeQueue.snapshot());
});
app.post('/api/node-queue/pause', async (req, res) => {
  requireNetworkOwner(req);
  const input = z
    .object({
      operationID: z.string().uuid(),
      expectedVersion: z.number().int().nonnegative(),
      paused: z.boolean(),
    })
    .parse(req.body);
  const result = await workerAdmission.run(async () => nodeQueue.setPaused(input));
  changed();
  void processRemoteTasks();
  res.json(result);
});
app.post('/api/node-queue/:id/control', async (req, res) => {
  requireNetworkOwner(req);
  const input = z
    .object({
      operationID: z.string().uuid(),
      expectedVersion: z.number().int().positive(),
      expectedQueueVersion: z.number().int().nonnegative().optional(),
      action: z.enum(['up', 'down', 'hold', 'resume', 'reject', 'cancel']),
      reason: z.string().trim().min(1).max(500).optional(),
    })
    .parse(req.body);
  const result = await workerAdmission.run(async () => {
    const safeReason = input.reason
      ? projects().reduce((text, p) => remoteSafeText(text, p.directory, 500), redact(input.reason))
      : undefined;
    const applied = nodeQueue.control(
      { ...input, reason: safeReason, itemID: z.string().uuid().parse(req.params.id) },
      (entry) => {
        if (entry.source.kind !== 'local') return;
        const current = task(entry.source.taskID);
        requireThat(
          current.state === 'ready' && !current.sessionID,
          409,
          '本机任务已经变化，请刷新队列。',
        );
        patchTask(current.id, { state: 'stopped', error: input.action === 'cancel' ? null : 'Node 已拒绝执行此排队任务。' });
      },
    );
    return applied;
  });
  changed();
  await publishQueueReceipts();
  void processRemoteTasks();
  res.json(result);
});

function remoteSafeText(value: string, directory: string, maximum: number) {
  let result = redact(value);
  for (const variant of [
    directory,
    directory.replaceAll('\\', '/'),
    directory.replaceAll('/', '\\'),
  ]) {
    if (!variant) continue;
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'gi'), '<project>');
  }
  return result.slice(0, maximum);
}

function remoteApprovals(value: Task, directory: string): Approval[] {
  const result: Approval[] = [];
  for (const approval of value.approvals.slice(0, 30)) {
    result.push({
      id: approval.id.slice(0, 200),
      permission: approval.permission.slice(0, 100),
      patterns: approval.patterns
        .slice(0, 30)
        .map((pattern) => remoteSafeText(pattern, directory, 2000)),
      metadata: {},
    });
    if (JSON.stringify(result).length > 8000) {
      result.pop();
      break;
    }
  }
  return result;
}

function remoteQuestions(value: Task, directory: string): Question[] {
  const result: Question[] = [];
  for (const request of value.questions.slice(0, 10)) {
    result.push({
      id: request.id.slice(0, 200),
      questions: request.questions.slice(0, 10).map((question) => ({
        header: remoteSafeText(question.header, directory, 120),
        question: remoteSafeText(question.question, directory, 4000),
        ...(question.multiple === undefined ? {} : { multiple: question.multiple }),
        options: question.options.slice(0, 20).map((option) => ({
          label: remoteSafeText(option.label, directory, 200),
          description: remoteSafeText(option.description, directory, 1000),
        })),
      })),
    });
    if (JSON.stringify(result).length > 8000) {
      result.pop();
      break;
    }
  }
  return result;
}

function remoteArtifacts(value: Task, directory: string): Artifact[] {
  const result: Artifact[] = [];
  for (const artifact of value.artifacts.slice(0, 50)) {
    result.push({
      file: remoteSafeText(artifact.file, directory, 2000) || '未命名文件',
      patch: remoteSafeText(artifact.patch, directory, 24_000),
      additions:
        Number.isSafeInteger(artifact.additions) && artifact.additions >= 0
          ? artifact.additions
          : 0,
      deletions:
        Number.isSafeInteger(artifact.deletions) && artifact.deletions >= 0
          ? artifact.deletions
          : 0,
      status: remoteSafeText(artifact.status, directory, 100) || 'modified',
    });
    if (JSON.stringify(result).length > 28_000) {
      result.pop();
      break;
    }
  }
  return result;
}

async function publishRemoteExecution(taskID: string) {
  let value: Task;
  try {
    value = task(taskID);
  } catch {
    return;
  }
  if (!value.remoteOrigin) return;
  const directory = project(value.projectID).directory;
  await nodeNetwork
    .publishRemoteTaskExecution(
      value.id,
      value.state,
      remoteSafeText(remoteExecutionSummary(value), directory, 8000),
      remoteApprovals(value, directory),
      remoteQuestions(value, directory),
      remoteArtifacts(value, directory),
      remoteSafeText(value.diffSource, directory, 200),
    )
    .catch(() => {});
}

const onTaskUpdateForNetwork = (value: { taskID?: string }) => {
  if (value.taskID) void publishRemoteExecution(value.taskID);
  if (!value.taskID) configureResources();
};
updates.on('update', onTaskUpdateForNetwork);

async function processRemoteTask(taskID: string) {
  if (processingRemoteTasks.has(taskID)) return;
  processingRemoteTasks.add(taskID);
  try {
    await workerAdmission.run(async () => {
      let currentRemote = nodeNetwork.remoteTask(taskID);
      let queueEntry = currentRemote ? queueForRemote(currentRemote) : null;
      if (queueEntry?.state === 'ended') return;
      // A locally confirmed stop is sufficient even if the originating Node is offline.
      const stoppedExecution = taskQueries.forRemote(taskID);
      if (queueEntry && stoppedExecution?.state === 'stopped') {
        const recovery = nodeQueueRecoveryDecision(queueEntry, { source: 'live', task: stoppedExecution });
        if (recovery.action === 'end') { nodeQueue.end(queueEntry.id, recovery.reason); return; }
      }
      const blocked = (code: NodeQueueReason['code']) => {
        if (queueEntry && queueEntry.state === 'waiting')
          nodeQueue.setBlockReason(queueEntry.id, { code });
      };
      if (
        !currentRemote ||
        currentRemote.direction !== 'incoming' ||
        !currentRemote.automaticEligible ||
        (currentRemote.status !== 'pending' && currentRemote.status !== 'accepted') ||
        !nodeNetwork.isTrustedNode(currentRemote.ownerNodeID)
      ) {
        const local = taskQueries.forRemote(taskID);
        const boundButUnstarted =
          queueEntry?.state === 'admitted' &&
          queueEntry.admissionPhase === 'bound' &&
          local?.state === 'ready' &&
          !local.sessionID &&
          !db.prepare('SELECT task_id FROM task_engine_intents WHERE task_id=?').get(local.id);
        if (
          queueEntry &&
          currentRemote &&
          (['waiting', 'held'].includes(queueEntry.state) ||
            boundButUnstarted ||
            canReleaseUnboundReservation(queueEntry, {
              localTaskExists: !!local,
              remoteLocalTaskID: currentRemote.localTaskID,
              executionSequence: currentRemote.executionSequence,
            }))
        ) {
          nodeQueue.end(
            queueEntry.id,
            {
              code: !nodeNetwork.isTrustedNode(currentRemote.ownerNodeID)
                ? 'trust_revoked'
                : currentRemote.status === 'expired'
                  ? 'expired'
                  : 'cancelled',
            },
            () => {
              if (boundButUnstarted && local)
                patchTask(local.id, {
                  state: 'stopped',
                  error: '原投递已终止，尚未开始的执行已取消。',
                });
            },
          );
          if (boundButUnstarted && local) changed(local.id);
        }
        return;
      }
      if (
        currentRemote.deliveryPending ||
        currentRemote.deliveryError ||
        !nodeNetwork.remoteTaskPeerReady(taskID)
      ) {
        blocked('peer_unavailable');
        return;
      }
      if (
        currentRemote.inputFiles?.length &&
        !nodeNetwork.files.complete(
          { scope: 'remote', taskID, purpose: 'input' },
          currentRemote.inputFiles,
        )
      ) {
        blocked('attachments_pending');
        return;
      }
      let localTask = taskQueries.forRemote(taskID);
      // Engine recovery writes the durable Task without a per-task live update event.
      // Reconcile its execution snapshot even when policy/model availability now blocks starts.
      if (localTask && currentRemote.localTaskID === localTask.id)
        await publishRemoteExecution(localTask.id);
      if (
        queueEntry?.state === 'admitted' &&
        !localTask &&
        nodeQueueRecoveryDecision(queueEntry, { source: 'live', task: null }).action !==
          'resume_binding'
      ) {
        nodeQueue.setBlockReason(queueEntry.id, { code: 'state_unknown' });
        return;
      }
      if (currentRemote.brainTaskID && currentRemote.status === 'accepted' && !queueEntry) {
        queueEntry = nodeQueue.enqueue({
          kind: 'remote',
          remoteTaskID: taskID,
          ownerNodeID: currentRemote.ownerNodeID,
          ownerBrainID: currentRemote.ownerBrainID,
          brainTaskID: currentRemote.brainTaskID,
        });
        // Existing M3.4 acceptance is a commitment even after a restart or queue pause.
        queueEntry = nodeQueue.restoreAdmission(
          queueEntry.id,
          localTask?.id || currentRemote.localTaskID || id(),
        );
      }
      // M3.3 direct invitations keep their accepted/waiting behavior. Scheduled M3.4
      // Executions acknowledge acceptance only after final local admission.
      if (!currentRemote.brainTaskID && currentRemote.status === 'pending') {
        await nodeNetwork.respondRemoteTask(taskID, 'accepted');
        currentRemote = nodeNetwork.remoteTask(taskID);
        if (!currentRemote || currentRemote.deliveryPending || currentRemote.deliveryError) {
          blocked('acceptance_pending');
          return;
        }
      }
      if (queueEntry?.state === 'held') return;
      if (nodeQueue.snapshot().paused && queueEntry?.state !== 'admitted') {
        blocked('queue_paused');
        if (currentRemote.brainTaskID && currentRemote.status === 'pending')
          await nodeNetwork.respondRemoteTask(taskID, 'declined');
        return;
      }
      const declinePending = async () => {
        if (currentRemote?.status === 'pending')
          await nodeNetwork.respondRemoteTask(taskID, 'declined');
      };
      const currentPolicy = executionPolicies.snapshot();
      const localOwner = users().find((candidate) => candidate.owner) || users()[0];
      if (
        !currentPolicy.enabled ||
        !currentPolicy.projectID ||
        !currentPolicy.model ||
        !localOwner ||
        !engineStatus.ready ||
        !engineStatus.models.some((model) => model.id === (localTask?.model || currentPolicy.model))
      ) {
        blocked(
          !currentPolicy.enabled
            ? 'execution_paused'
            : !engineStatus.ready
              ? 'engine_unavailable'
              : !currentPolicy.projectID
                ? 'project_unavailable'
                : 'model_unavailable',
        );
        await declinePending();
        return;
      }
      if (
        currentRemote.requestedProjectID &&
        currentRemote.requestedProjectID !== (localTask?.projectID || currentPolicy.projectID)
      ) {
        blocked('project_unavailable');
        await declinePending();
        return;
      }
      const localWorker = nodeNetwork.snapshot().local?.worker;
      if (
        !localTask &&
        queueEntry?.state !== 'admitted' &&
        (!localWorker ||
          !workerMatchesTask(localWorker, {
            projectID: currentRemote.requestedProjectID,
            requirements: currentRemote.requirements,
          }))
      ) {
        blocked(incomingOccupiedSlots() >= currentPolicy.maxConcurrent ? 'slot' : 'hardware_unavailable');
        await declinePending();
        return;
      }
      if (!localTask) {
        if (queueEntry?.state !== 'admitted' && incomingOccupiedSlots(queueEntry?.localTaskID || undefined, queueEntry?.id) >= currentPolicy.maxConcurrent) {
          blocked('slot');
          await declinePending();
          return;
        }
        if (
          currentRemote.brainTaskID &&
          currentRemote.status === 'pending' &&
          nodeQueue
            .list()
            .some((candidate) => candidate.id !== queueEntry?.id && candidate.source.kind === 'remote' && isNodeQueueCandidate(candidate))
        ) {
          await declinePending();
          return;
        }
        if (queueEntry?.state === 'waiting') {
          queueEntry = nodeQueue.setBlockReason(queueEntry.id, null);
          if (firstNodeQueueCandidate(nodeQueue.list(), 'remote')?.id !== queueEntry.id) {
            blocked('queue');
            return;
          }
        }
        if (!queueEntry)
          queueEntry = nodeQueue.enqueue({
            kind: 'remote',
            remoteTaskID: taskID,
            ownerNodeID: currentRemote.ownerNodeID,
            ownerBrainID: currentRemote.ownerBrainID,
            ...(currentRemote.brainTaskID ? { brainTaskID: currentRemote.brainTaskID } : {}),
          });
        if (queueEntry.state !== 'admitted') {
          queueEntry = nodeQueue.setBlockReason(queueEntry.id, null);
          queueEntry = nodeQueue.admit(
            queueEntry.id,
            queueEntry.version,
            queueEntry.localTaskID || id(),
          );
        }
        if (currentRemote.status === 'pending') {
          await nodeNetwork.respondRemoteTask(taskID, 'accepted');
          currentRemote = nodeNetwork.remoteTask(taskID);
          if (
            !currentRemote ||
            currentRemote.status !== 'accepted' ||
            currentRemote.deliveryPending ||
            currentRemote.deliveryError
          )
            return;
        }
        currentRemote = nodeNetwork.remoteTask(taskID);
        if (
          !currentRemote ||
          currentRemote.status !== 'accepted' ||
          !nodeNetwork.isTrustedNode(currentRemote.ownerNodeID)
        )
          return;
        let projectID = currentPolicy.projectID;
        if (currentRemote.requestedProjectID || !currentRemote.brainTaskID) {
          project(projectID);
        } else {
          const directory = join(dataRoot, 'portable-tasks', taskID);
          mkdirSync(directory, { recursive: true });
          const portableProject =
            projects().find((candidate) => candidate.directory === directory) || null;
          if (portableProject) projectID = portableProject.id;
          else {
            projectID = id();
            saveProject({
              id: projectID,
              name: `Portable ${taskID.slice(0, 8)}`,
              directory,
              createdAt: now(),
            });
          }
        }
        const createdAt = now();
        const collaboration = workflowRuntime.contexts.bind(currentRemote, queueEntry.localTaskID!);
        localTask = {
          id: queueEntry.localTaskID!,
          number: taskQueries.nextNumber(),
          projectID,
          ...inputFileFields(currentRemote.inputFiles),
          ...(collaboration ? { collaboration } : {}),
          title: currentRemote.title,
          description: currentRemote.description,
          criteria: currentRemote.criteria,
          creatorID: localOwner.id,
          assigneeID: localOwner.id,
          approverID: localOwner.id,
          reviewerID: localOwner.id,
          acceptedBy: null,
          state: 'ready',
          version: 1,
          createdAt,
          updatedAt: createdAt,
          model: currentPolicy.model, reasoningEffort: currentPolicy.reasoningEffort,
          approvalMode: currentPolicy.approvalMode,
          sessionID: null,
          runAfter: 0,
          messages: [],
          approvals: [],
          questions: [],
          artifacts: [],
          diffSource: '',
          error: null,
          remoteOrigin: {
            remoteTaskID: taskID,
            ownerNodeID: currentRemote.ownerNodeID,
            ownerBrainID: currentRemote.ownerBrainID,
          },
        } satisfies Task;
        if (currentRemote.inputFiles?.length)
          nodeNetwork.files.bindExisting(
            { scope: 'local', taskID: localTask.id, purpose: 'input' },
            currentRemote.inputFiles,
          );
        nodeQueue.bindTask(queueEntry.id, localTask.id, () => saveTask(localTask!));
        activity(
          localTask.id,
          localOwner.id,
          'remote_created',
          `受信 Brain ${currentRemote.ownerBrainID.slice(0, 6)} 按本机策略调用执行能力。`,
        );
        changed(localTask.id);
      }
      if (!queueEntry) {
        queueEntry = nodeQueue.enqueue({
          kind: 'remote',
          remoteTaskID: taskID,
          ownerNodeID: currentRemote.ownerNodeID,
          ownerBrainID: currentRemote.ownerBrainID,
          ...(currentRemote.brainTaskID ? { brainTaskID: currentRemote.brainTaskID } : {}),
        });
        queueEntry = nodeQueue.admit(queueEntry.id, queueEntry.version, localTask.id);
        queueEntry = nodeQueue.bindTask(queueEntry.id, localTask.id);
      }
      if (queueEntry.state === 'waiting' && currentRemote.localTaskID === localTask.id)
        queueEntry = nodeQueue.restoreAdmission(queueEntry.id, localTask.id);
      if (queueEntry.admissionPhase === 'reserved')
        queueEntry = nodeQueue.bindTask(queueEntry.id, localTask.id);
      currentRemote = nodeNetwork.remoteTask(taskID);
      if (!currentRemote?.localTaskID)
        await nodeNetwork.bindRemoteTaskExecution(taskID, localTask.id);
      localTask = task(localTask.id);
      queueEntry = nodeQueue.get(queueEntry.id)!;
      const recovery = nodeQueueRecoveryDecision(queueEntry, { source: 'live', task: localTask });
      if (recovery.action === 'end') {
        nodeQueue.end(queueEntry.id, recovery.reason);
        return;
      }
      if (recovery.action === 'retain_execution') return;
      if (recovery.action === 'interrupt') {
        nodeQueue.setBlockReason(queueEntry.id, recovery.reason);
        patchTask(localTask.id, {
          state: 'interrupted',
          error: '已保存启动意图，执行结果待确认；不会自动重建会话。',
        });
        changed(localTask.id);
        return;
      }
      if (localTask.state !== 'ready' || localTask.sessionID) return;
      try {
        await exclusive('engine-settings', async () => {
          assertCanStartTask();
          nodeQueue.markStarting(queueEntry!.id);
          await exclusive(`project:${localTask!.projectID}`, () =>
            runTask(localTask!.id, localOwner),
          );
          nodeQueue.markStarted(queueEntry!.id);
          lastQueueProgressAt = now();
        });
      } catch (error) {
        const current = task(localTask.id);
        if (current.state === 'ready') {
          patchTask(current.id, {
            state:
              nodeQueue.get(queueEntry!.id)?.admissionPhase === 'starting'
                ? 'interrupted'
                : 'failed',
            error: redact(error instanceof Error ? error.message : '自动执行启动失败。'),
          });
          activity(current.id, localOwner.id, 'remote_start_failed', '自动执行启动失败。');
          changed(current.id);
        }
      }
    });
  } catch (error) {
    console.error(
      `远端任务 ${taskID} 未能按策略启动：${error instanceof Error ? error.message : '未知错误'}`,
    );
  } finally {
    processingRemoteTasks.delete(taskID);
  }
}

async function processLocalQueue(entryID: string) {
  await workerAdmission.run(async () => {
    let entry = nodeQueue.get(entryID);
    if (!entry || entry.source.kind !== 'local' || ['ended', 'held'].includes(entry.state)) return;
    const current = task(entry.source.taskID);
    const recovery = nodeQueueRecoveryDecision(entry, { source: 'live', task: current });
    if (recovery.action === 'end') {
      nodeQueue.end(entry.id, recovery.reason);
      return;
    }
    if (recovery.action === 'retain_execution') return;
    if (recovery.action === 'interrupt') {
      nodeQueue.setBlockReason(entry.id, recovery.reason);
      patchTask(current.id, {
        state: 'interrupted',
        error: '已有未确认的自动启动记录，不会自动重复执行。',
      });
      changed(current.id);
      return;
    }
    if (current.state !== 'ready' || current.sessionID) return;
    const setReason = (code: NodeQueueReason['code']) =>
      nodeQueue.setBlockReason(entry!.id, { code });
    if (nodeQueue.snapshot().paused && entry.state !== 'admitted') {
      setReason('queue_paused');
      return;
    }
    if (!engineStatus.ready) {
      setReason('engine_unavailable');
      return;
    }
    if (!engineStatus.models.some((model) => model.id === current.model)) {
      setReason('model_unavailable');
      return;
    }
    if (!projects().some((p) => p.id === current.projectID)) {
      setReason('project_unavailable');
      return;
    }
    if (nodeNetwork.projectLeased(current.projectID)) {
      setReason('slot');
      return;
    }
    if (entry.state === 'waiting') {
      entry = nodeQueue.setBlockReason(entry.id, null);
      if (firstNodeQueueCandidate(nodeQueue.list(), 'local')?.id !== entry.id) {
        setReason('queue');
        return;
      }
    }
    const actor = user(current.assigneeID);
    if (!actor) {
      setReason('state_unknown');
      return;
    }
    try {
      await exclusive('engine-settings', async () => {
        assertCanStartTask();
        if (entry!.state !== 'admitted') {
          entry = nodeQueue.setBlockReason(entry!.id, null);
          entry = nodeQueue.admit(entry.id, entry.version, current.id);
        }
        nodeQueue.markStarting(entry!.id);
        await exclusive(`project:${current.projectID}`, () => runTask(current.id, actor));
        nodeQueue.markStarted(entry!.id);
        lastQueueProgressAt = now();
      });
    } catch (error) {
      const latest = task(current.id);
      if (latest.state === 'ready') {
        if (nodeQueue.get(entry.id)?.admissionPhase === 'starting')
          patchTask(current.id, {
            state: 'interrupted',
            error: '启动未确认，请检查执行现场；不会自动重试。',
          });
        else setReason('engine_unavailable');
      }
      console.error(
        `本地队列启动未完成：${redact(error instanceof Error ? error.message : '未知错误')}`,
      );
      changed(current.id);
    }
  });
}
let dispatchingQueue = false;
async function processRemoteTasks() {
  if (dispatchingQueue || updateMaintenance.active) return;
  dispatchingQueue = true;
  try {
    const remotes = nodeNetwork
      .snapshot()
      .remoteTasks.filter((remote) => remote.direction === 'incoming' && remote.automaticEligible);
    // Repair the durable offer -> SQLite gap; terminal queue rows are never recreated.
    for (const remote of remotes) {
      try {
        intakeRemoteQueue(remote);
      } catch {
        /* Capacity failure remains visible and is not dispatched. */
      }
    }
    // Accepted M3.4 allocations retain priority over all new admissions.
    for (const remote of remotes.filter(
      (remote) => remote.brainTaskID && remote.status === 'accepted',
    ))
      await processRemoteTask(remote.id);
    const ordered = nodeQueue.list();
    for (const entry of [
      ...ordered.filter((e) => e.state === 'admitted'),
      ...ordered.filter((e) => e.state !== 'admitted'),
    ]) {
      if (entry.state === 'ended') continue;
      if (entry.source.kind === 'local') await processLocalQueue(entry.id);
      else await processRemoteTask(entry.source.remoteTaskID);
    }
    for (const remote of remotes.filter(
      (remote) => remote.brainTaskID && remote.status === 'pending',
    ))
      await processRemoteTask(remote.id);
    await publishQueueReceipts();
  } finally {
    dispatchingQueue = false;
  }
}

nodeNetwork.on('task-files-changed', () => {
  changed();
  void processRemoteTasks();
});
nodeNetwork.on('remote-task-offer', () => {
  void processRemoteTasks();
});

async function processRemoteControl(taskID: string, controlID: string) {
  if (processingRemoteControls.has(controlID)) return;
  processingRemoteControls.add(controlID);
  let localTaskID: string | null = null;
  try {
    const pending = nodeNetwork
      .pendingRemoteTaskControls()
      .find(
        (candidate) => candidate.taskID === taskID && candidate.control.controlID === controlID,
      );
    const remote = nodeNetwork.remoteTask(taskID);
    if (
      !pending ||
      !remote ||
      remote.direction !== 'incoming' ||
      remote.ownerNodeID !== pending.control.ownerNodeID ||
      !nodeNetwork.isTrustedNode(remote.ownerNodeID)
    )
      return;
    localTaskID = pending.localTaskID;
    const localTask = task(localTaskID);
    requireThat(localTask.remoteOrigin?.remoteTaskID === taskID, 409, '远程控制任务绑定不匹配。');
    const localOwner = users().find((candidate) => candidate.owner) || users()[0];
    requireThat(localOwner, 409, '执行节点没有可处理远程操作的本机所有者。');
    if (
      activities(localTask.id).some(
        (entry) =>
          entry.kind === 'remote_control_started' &&
          entry.text === `远程控制开始处理 · ${controlID}`,
      )
    ) {
      activity(
        localTask.id,
        localOwner.id,
        'remote_control_uncertain',
        `远程控制 ${controlID} 曾开始处理；重启后不自动重复执行，请人工检查任务状态。`,
      );
      return;
    }
    activity(
      localTask.id,
      localOwner.id,
      'remote_control_started',
      `远程控制开始处理 · ${controlID}`,
    );
    const action = pending.control.action;
    if (action.kind === 'permission')
      await replyPermission(localTask.id, localOwner, action.requestID, action.reply);
    else if (action.kind === 'question')
      await replyQuestion(localTask.id, localOwner, action.requestID, action.answers);
    else if (action.kind === 'stop') await stopTask(localTask.id, localOwner);
    else if (action.kind === 'accept')
      await acceptResult(localTask.id, localOwner, localTask.version, action.note);
    else
      await workerAdmission.run(() =>
        exclusive('engine-settings', async () => {
          requireThat(executionPolicies.allows(), 409, '本机执行能力已关闭。');
          const entry = queueForRemote(remote);
          requireThat(!entry || entry.state !== 'ended' || entry.endReason?.code === 'stopped', 409, '此任务的队列已终止，不能继续执行。');
          assertExecutionCapacity(localTask, entry);
          assertCanStartTask();
          const updated = await addRequirement(localTask.id, localOwner, action.text);
          await exclusive(`project:${updated.projectID}`, () =>
            runTask(
              updated.id,
              localOwner,
              `归属 Brain 补充要求：\n${redact(action.text)}\n\n请继续完成原任务并重新核对全部验收标准。`,
            ),
          );
        }),
      );
    activity(
      localTask.id,
      localOwner.id,
      'remote_control',
      action.kind === 'permission'
        ? `归属 Brain 远程${action.reply === 'once' ? '批准' : '拒绝'}权限请求。`
        : action.kind === 'question'
          ? '归属 Brain 远程回答 AI 问题。'
          : action.kind === 'stop'
            ? '归属 Brain 远程请求停止任务。'
            : action.kind === 'accept'
              ? '归属 Brain 远程确认验收。'
              : '归属 Brain 远程补充要求并继续执行。',
    );
  } catch (error) {
    console.error(
      `远程控制 ${controlID} 处理失败：${error instanceof Error ? error.message : '未知错误'}`,
    );
  } finally {
    nodeNetwork.finishRemoteTaskControl(taskID, controlID);
    if (localTaskID) await publishRemoteExecution(localTaskID);
    processingRemoteControls.delete(controlID);
  }
}

async function processRemoteControls() {
  for (const pending of nodeNetwork.pendingRemoteTaskControls())
    await processRemoteControl(pending.taskID, pending.control.controlID);
}

nodeNetwork.on('remote-task-control', (value: { taskID: string; controlID: string }) => {
  void processRemoteControl(value.taskID, value.controlID);
});
async function stopExecutionsForRevokedNode(nodeID: string) {
  await workerAdmission.run(async () => {
    for (const entry of nodeQueue.list())
      if (
        entry.source.kind === 'remote' &&
        entry.source.ownerNodeID === nodeID &&
        ['waiting', 'held'].includes(entry.state)
      )
        nodeQueue.end(entry.id, { code: 'trust_revoked' });
  });
  const localOwner = users().find((candidate) => candidate.owner) || users()[0];
  if (!localOwner) return;
  for (const value of tasks().filter(
    (candidate) => candidate.remoteOrigin?.ownerNodeID === nodeID,
  )) {
    try {
      if (value.state === 'ready' && !value.sessionID) {
        patchTask(value.id, {
          state: 'stopped',
          error: '任务来源设备的信任已撤销；尚未开始的自动执行已取消。',
        });
        activity(value.id, localOwner.id, 'trust_revoked', '来源设备信任撤销，取消自动执行。');
        changed(value.id);
      } else if (activeStates.includes(value.state) || value.state === 'interrupted') {
        await stopTask(value.id, localOwner);
        activity(value.id, localOwner.id, 'trust_revoked', '来源设备信任撤销，停止远端执行。');
      }
    } catch {
      const current = task(value.id);
      patchTask(current.id, {
        state: 'interrupted',
        error: '来源设备信任已撤销，但无法确认 OpenCode 已停止；请立即在本机检查。',
      });
      changed(current.id);
    }
  }
}
const onTrustRevoked = (value: { nodeID: string }) => {
  void stopExecutionsForRevokedNode(value.nodeID);
};
nodeNetwork.on('trust-revoked', onTrustRevoked);
const remoteTaskProcessor = setInterval(() => {
  void processRemoteTasks();
  void processRemoteControls();
}, 2_000);
remoteTaskProcessor.unref();
const modelInput = z.object({ model: z.string().min(3).max(200) });
app.use('/api/model-settings', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
app.get('/api/model-settings/providers', async (_req, res) => res.json(await providerCatalog()));
const providerKeyInput = z.object({ providerID: providerIDSchema, key: apiKeySchema, shared: z.literal(true), account: accountTargetSchema.optional() });
app.post('/api/model-settings/provider/key', async (req, res) => {
  const { providerID, key, account } = providerKeyInput.parse(req.body);
  res.json(await saveProviderKey(who(req), providerID, key, account));
});
app.post('/api/model-settings/provider/rename', async (req, res) => {
  const body = z.object({ id: providerIDSchema, name: accountNameSchema }).parse(req.body);
  res.json(await renameProviderAccount(who(req), body.id, body.name));
});
app.post('/api/model-settings/provider/custom', async (req, res) => {
  const body = z.object({ provider: z.unknown(), key: apiKeySchema.optional(), shared: z.literal(true) }).parse(req.body);
  res.json(await saveCustomProvider(who(req), body.provider, body.key));
});
app.post('/api/model-settings/provider/remove', async (req, res) => {
  const body = z.object({ providerID: providerIDSchema, confirmed: z.literal(true) }).parse(req.body);
  res.json(await removeProvider(who(req), body.providerID));
});
app.get('/api/model-settings/oauth', (req, res) => {
  requireThat(who(req).owner, 403, '只有工作区创建者可以管理模型及凭据');
  res.json(providerOAuth.snapshot(who(req).id));
});
app.post('/api/model-settings/oauth/start', async (req, res) => {
  const body = z.object({ providerID: providerIDSchema, method: z.number().int().min(0).max(30),
    inputs: z.record(z.string().max(80), z.string().max(1000)).refine((v) => Object.keys(v).length <= 20).default({}), shared: z.literal(true), account: accountTargetSchema.optional() }).parse(req.body);
  res.status(202).json(await beginProviderOAuth(who(req), body.providerID, body.method, body.inputs, body.account));
});
const attemptInput = z.object({ id: z.string().uuid() });
app.post('/api/model-settings/oauth/complete', (req, res) => {
  requireThat(who(req).owner, 403, '只有工作区创建者可以管理模型及凭据');
  const body = attemptInput.extend({ code: z.string().trim().min(1).max(8192).optional() }).parse(req.body);
  res.status(202).json(providerOAuth.complete(who(req).id, body.id, body.code));
});
app.post('/api/model-settings/oauth/cancel', async (req, res) => {
  const { id } = attemptInput.parse(req.body);
  res.json(await cancelProviderOAuth(who(req), id));
});
app.post('/api/model-settings/oauth/open', async (req, res) => {
  requireThat(who(req).owner, 403, '只有工作区创建者可以管理模型及凭据');
  const { id } = attemptInput.parse(req.body);
  const url = providerOAuth.url(who(req).id, id);
  // No shell command composition and no client-supplied URL: only the active official authorization URL.
  await new Promise<void>((done, reject) => execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, timeout: 15_000 }, (error) => error ? reject(new HttpError(503, 'Could not open the browser. Copy the authorization link instead.')) : done()));
  res.json({ ok: true });
});
app.post('/api/model-settings/deepseek', async (req, res) => {
  const { key } = z
    .object({
      key: z
        .string()
        .trim()
        .min(20, 'DeepSeek API Key 长度不正确')
        .max(512, 'DeepSeek API Key 长度不正确')
        .regex(/^[\x21-\x7e]+$/, 'DeepSeek API Key 不能包含空格或控制字符'),
      shared: z.literal(true),
    })
    .parse(req.body);
  res.json(await saveDeepSeek(who(req), key));
});
app.post('/api/model-settings/deepseek/remove', async (req, res) => {
  z.object({ confirmed: z.literal(true) }).parse(req.body);
  res.json(await saveDeepSeek(who(req), null));
});
app.post('/api/model-settings/default', async (req, res) => {
  const { model } = modelInput.parse(req.body);
  res.json(await chooseDefaultModel(who(req), model));
});
app.post('/api/model-settings/test', async (req, res) => {
  const { model } = modelInput.extend({ confirmed: z.literal(true) }).parse(req.body);
  res.status(202).json(await startConnectionCheck(who(req), model));
});
app.post('/api/model-settings/test/stop', (req, res) => res.json(cancelConnectionCheck(who(req))));
app.post('/api/invitations', (req, res) => {
  requireThat(who(req).owner, 403, '只有工作区创建者可以邀请成员');
  const code = token();
  db.prepare('INSERT INTO invitations VALUES (?,?,?,0)').run(
    hash(code),
    who(req).id,
    Date.now() + 24 * 60 * 60_000,
  );
  res.json({ code, expiresIn: '24 小时，仅限使用一次' });
});
app.post('/api/projects', async (req, res) => {
  requireThat(who(req).owner, 403, '只有工作区创建者可以授权本机项目');
  const body = z
    .object({
      name: z.string().trim().min(1).max(60),
      directory: z.string().min(1).max(1000),
      trusted: z.literal(true),
    })
    .parse(req.body);
  const directory = await validateProject(body.directory);
  requireThat(
    !projects().some((p) => p.directory.toLowerCase() === directory.toLowerCase()),
    409,
    '项目已经添加',
  );
  const p = { id: id(), name: body.name, directory, createdAt: now() };
  saveProject(p);
  changed();
  res.status(201).json(p);
});
const taskInput = z.object({
  attachmentIDs: attachmentIDsSchema,
  queueConfirmedFor: z.string().min(1).max(80).optional(),
  requestID: z.string().uuid().optional(),
  runRequested: z.boolean().default(false),
  projectID: z.string().uuid(),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(12000),
  criteria: z.string().trim().min(1).max(4000),
  assigneeID: z.string().uuid(),
  approverID: z.string().uuid(),
  reviewerID: z.string().uuid(),
  model: z.string().min(3).max(200),
  reasoningEffort: z.unknown().refine(validReasoningEffort).optional(),
  approvalMode: z.enum(['ask', 'auto', 'full']),
});
app.post('/api/tasks', (req, res) => {
  const { requestID, runRequested, attachmentIDs, queueConfirmedFor, ...input } = taskInput.parse(
    req.body,
  );
  const inputFiles = nodeNetwork.files.uploaded(who(req).id, attachmentIDs || []);
  const createdTaskID = creationRequests.reserve(who(req).id, requestID, {
    routing: { kind: 'local' },
    ...(attachmentIDs?.length ? { attachmentIDs } : {}),
    runRequested,
    ...input,
  });
  const existing = tasks().find((candidate) => candidate.id === createdTaskID);
  if (existing) return void res.status(201).json(existing);
  requireThat(
    engineStatus.models.some((m) => m.id === input.model),
    400,
    '请选择已配置的模型；可先到模型设置连接提供方',
  );
  project(input.projectID);
  requireThat(reasoningSupported(engineStatus.models.find(m => m.id === input.model), input.reasoningEffort), 400,
    '所选思考等级当前不可用，请重新选择思考等级或使用自动。');
  requireThat(
    [input.assigneeID, input.approverID, input.reviewerID].every((uid) => user(uid)),
    400,
    '请选择已加入工作区的成员',
  );
  if (runRequested) {
    requireThat(who(req).id === input.assigneeID, 403, '只有指定接受人可以请求立即排队执行。');
    const localNode = nodeNetwork.snapshot().local;
    requireQueueConfirmation(
      localNode?.id || 'local',
      localNode?.name || '本机',
      queueHealth().waitingCount + occupiedSlots(),
      queueConfirmedFor,
    );
    requireThat(queueHealth().accepting, 409, '本机等待队列已达到接收上限。');
  }
  const t: Task = {
    ...input,
    ...inputFileFields(inputFiles),
    description: redact(input.description),
    criteria: redact(input.criteria),
    id: createdTaskID,
    number: taskQueries.nextNumber(),
    creatorID: who(req).id,
    acceptedBy: null,
    state: runRequested ? 'ready' : 'open',
    version: 1,
    createdAt: now(),
    updatedAt: now(),
    sessionID: null,
    runAfter: 0,
    messages: [],
    approvals: [],
    questions: [],
    artifacts: [],
    diffSource: '',
    error: null,
  };
  if (inputFiles.length)
    nodeNetwork.files.bindUploaded(
      { scope: 'local', taskID: t.id, purpose: 'input' },
      who(req).id,
      attachmentIDs!,
    );
  if (runRequested) nodeQueue.enqueue({ kind: 'local', taskID: t.id }, () => saveTask(t));
  else saveTask(t);
  activity(t.id, who(req).id, 'created', '创建任务并指定执行人和审批人。');
  changed(t.id);
  if (runRequested) void processRemoteTasks();
  res.status(201).json(t);
});
app.get('/api/tasks/:id', (req, res) =>
  res.json({ task: visibleTask(req), activities: activities(String(req.params.id)) }),
);
app.get('/api/tasks/:id/context', (req, res) => res.json(taskContexts.list(visibleTask(req).id)));
app.get('/api/tasks/:id/context/knowledge', (req, res) => {
  const taskID = visibleTask(req).id;
  const offset = z.coerce.number().int().min(0).max(1_000_000).parse(req.query.offset || 0);
  res.json(knowledge?.tools.usage(taskID, offset) || { entries: [], total: 0, nextOffset: null });
});
app.post('/api/tasks/:id/claim', (req, res) => {
  const t = visibleTask(req);
  requireThat(who(req).id === t.assigneeID, 403, '只有指定接受人可以接受任务');
  requireThat(t.state === 'open', 409, '任务已经被接受');
  const result = patchTask(t.id, { state: 'ready' });
  activity(t.id, who(req).id, 'claimed', '接受任务，负责启动和跟进 AI 执行。');
  changed(t.id);
  res.json(result);
});
app.post('/api/tasks/:id/run', async (req, res) => {
  const t = visibleTask(req);
  const body = z
    .object({
      confirmed: z.literal(true),
      addition: z.string().trim().min(1).max(12000).optional(),
    })
    .parse(req.body);
  if (t.sessionID) requireThat(body.addition, 400, '继续执行需要说明要求');
  res.json(
    await workerAdmission.run(() =>
      exclusive('engine-settings', async () => {
        assertExecutionCapacity(t, nodeQueue.list().find((entry) => entry.localTaskID === t.id));
        assertCanStartTask();
        return exclusive(`project:${t.projectID}`, () => {
          requireThat(
            !nodeNetwork.projectLeased(t.projectID),
            409,
            '该项目已由本机所有者暂时保留给一项跨设备任务；请先撤销或等待准备授权过期。',
          );
          return runTask(t.id, who(req), body.addition);
        });
      }),
    ),
  );
});
app.post('/api/tasks/:id/messages', async (req, res) => {
  const value = visibleTask(req);
  const body = z.object({ requestID: z.string().uuid(), text: z.string().trim().min(1).max(12_000),
    model: z.string().trim().min(3).max(200).optional(), reasoningEffort: z.unknown().refine(validReasoningEffort).optional(), confirmed: z.literal(true) }).strict().parse(req.body);
  res.json(await workerAdmission.run(() => exclusive('engine-settings', () =>
    exclusive(`project:${value.projectID}`, () => sendTaskMessage(value.id, who(req), body, current => {
      requireThat(!isRemoteExecution(current, nodeQueue.list(), nodeNetwork.remoteTaskRecords()), 409,
        'Only ordinary local conversations support this message endpoint.');
      assertExecutionCapacity(current, nodeQueue.list().find(entry => entry.localTaskID === current.id));
      assertCanStartTask();
      requireThat(!nodeNetwork.projectLeased(current.projectID), 409,
        '该项目已由本机所有者暂时保留给一项跨设备任务；请先撤销或等待准备授权过期。');
    })))));
});
app.post('/api/tasks/:id/stop', async (req, res) =>
  res.json(await stopTask(visibleTask(req).id, who(req))),
);
app.post('/api/tasks/:id/requirements', async (req, res) => {
  const initial = visibleTask(req);
  const body = z.object({ text: z.string().trim().min(1).max(12000) }).parse(req.body);
  res.json(await addRequirement(initial.id, who(req), body.text));
});
app.post('/api/tasks/:id/permissions/:requestID', async (req, res) => {
  const t = visibleTask(req);
  const { reply } = z.object({ reply: z.enum(['once', 'reject']) }).parse(req.body);
  res.json(await replyPermission(t.id, who(req), String(req.params.requestID), reply));
});
app.post('/api/tasks/:id/questions/:requestID', async (req, res) => {
  const t = visibleTask(req);
  const { answers } = z
    .object({
      answers: z
        .array(z.array(z.string().max(4000)).min(1))
        .min(1)
        .max(10),
    })
    .parse(req.body);
  const requestID = String(req.params.requestID), question = t.questions.find((q) => q.id === requestID);
  const result = await replyQuestion(t.id, who(req), requestID, answers);
  if (question) workflowRuntime.service.recordAnswers(t.id, requestID, question.questions.map((q) => q.question), answers);
  res.json(result);
});
app.post('/api/tasks/:id/accept', async (req, res) => {
  const t = visibleTask(req);
  const body = z
    .object({
      version: z.number().int(),
      note: z.string().trim().min(1).max(4000),
      confirmed: z.literal(true),
    })
    .parse(req.body);
  res.json(await acceptResult(t.id, who(req), body.version, body.note));
});
app.post('/api/tasks/:id/request-changes', async (req, res) => {
  const initial = visibleTask(req);
  const { note } = z.object({ note: z.string().trim().min(1).max(4000) }).parse(req.body);
  res.json(await requestChanges(initial.id, who(req), note));
});
app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const send = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const visible = (taskID?: string) => !taskID || participant(task(taskID), who(req));
  const onUpdate = (value: { taskID?: string }) => {
    if (visible(value.taskID)) send('update', value);
  };
  const onDelta = (value: { taskID: string }) => {
    if (visible(value.taskID)) send('delta', value);
  };
  const onNetwork = () => send('network', { changed: true });
  updates.on('update', onUpdate);
  updates.on('delta', onDelta);
  const onStream = (value: { taskID: string }) => { if (visible(value.taskID)) send('task-stream', value); };
  updates.on('task-stream', onStream);
  nodeNetwork.on('update', onNetwork);
  send('connected', { ok: true });
  const heartbeat = setInterval(() => {
    if (
      !db
        .prepare('SELECT token FROM sessions WHERE token=? AND expires>?')
        .get(hash(sessionToken(req)), Date.now())
    )
      return void res.end();
    res.write(': heartbeat\n\n');
  }, 15_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    updates.off('update', onUpdate);
    updates.off('delta', onDelta);
    updates.off('task-stream', onStream);
    nodeNetwork.off('update', onNetwork);
  });
});
app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
if (headless) {
  app.use((_req, res) => res.status(404).json({ error: 'This is a Rivloom headless node. Use the rivloom CLI.' }));
} else if (dev) {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  app.use(vite.middlewares);
  app.get('/{*path}', async (req, res) =>
    res
      .type('html')
      .send(
        await vite.transformIndexHtml(
          req.originalUrl,
          await readFile(resolve('index.html'), 'utf8'),
        ),
      ),
  );
} else {
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
}
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof ProviderAccountError) return void res.status(400).json({ error: error.message });
  if (error instanceof QueueConfirmationRequired)
    return void res
      .status(error.status)
      .json({ error: error.message, queueConfirmation: error.queueConfirmation });
  if (error instanceof z.ZodError)
    return void res.status(400).json({
      error: `输入不正确：${error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('；')}`,
    });
  if (error instanceof HttpError || error instanceof HistoryError || error instanceof WorkspacePreferenceError)
    return void res.status(error.status).json({ error: error.message });
  if (error instanceof TaskFileError)
    return void res.status(error.status).json({ error: error.message });
  if (error instanceof NodeNetworkError)
    return void res.status(error.status).json({ error: error.message });
  if (error instanceof CreationConflict)
    return void res.status(error.status).json({ error: error.message });
  if (error instanceof NodeQueueError)
    return void res.status(error.status).json({ error: error.message });
  if (error instanceof Error && /^(knowledge|context)_[a-z_]+$/.test(error.message))
    return void res.status(409).json({ error: error.message });
  res.status(500).json({ error: '操作未完成。请检查任务状态、项目文件夹及引擎连接后重试。' });
});
const server = createServer(app);
try {
  await listenHttp(server, '127.0.0.1', port);
} catch (error) {
  console.error(
    `无法监听端口 ${port}：${error instanceof Error ? error.message : '端口绑定失败'}。`,
  );
  process.exit(1);
}
{
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法获取本机端口');
  allowedHosts.clear();
  origins.clear();
  for (const host of [`127.0.0.1:${address.port}`, `localhost:${address.port}`]) {
    allowedHosts.add(host);
    origins.add(`http://${host}`);
  }
  const url = `http://127.0.0.1:${address.port}`;
  if (headlessToken) removeHeadlessControl = publishHeadlessControl(dataRoot, url, headlessToken);
  console.log(headless ? `RIVLOOM_HEADLESS_READY ${url}` : desktop ? `RIVLOOM_DESKTOP_READY ${url}` : `Rivloom: ${url}`);
  if (!users().length && !desktop && !headless)
    console.log(`首次初始化码保存在 ${join(dataRoot, 'setup-code.txt')}，请在页面中输入。`);
  knowledgeBridge = await startKnowledgeBridge(() => knowledge?.tools || null, (root, body) => taskContexts.call(root, body), async (root, raw) => {
    const body = z.object({ sessionID: z.string(), directory: z.string(), name: z.enum(['rivloom_history', 'rivloom_context_note']), args: z.unknown() }).strict().parse(raw);
    const before = taskContexts.authorize(root, body.sessionID, body.directory);
    const result = await workflowRuntime.historyTool(before.taskID, body.name, body.args);
    if (taskContexts.authorize(root, body.sessionID, body.directory).id !== before.id) throw new Error('context_execution_changed');
    return result;
  }, (root, sessionID, directory) => taskContexts.authorize(root, sessionID, directory).id);
  void nodeNetwork.start().then(() => { configureResources(); });
  void initializeEngine().then(() => sweepConversationHistory());
  workflowRuntime.start();
}
let closing = false;
export async function shutdown(update?: { lease: string; version: string }) {
  if (closing) return;
  closing = true;
  clearInterval(historyCleanup);
  workerSampler?.dispose();
  clearInterval(remoteTaskProcessor);
  updates.off('update', onTaskUpdateForNetwork);
  nodeNetwork.off('trust-revoked', onTrustRevoked);
  const deadline = setTimeout(() => process.exit(1), update ? 25_000 : headless ? 20_000 : 6000);
  deadline.unref();
  removeDesktopToken();
  removeHeadlessControl();
  nodeNetwork.off('update', configureResources);
  await workflowRuntime.close();
  await resources?.files.close();
  await resources?.directory.close();
  await resources?.catalog.close();
  await nodeNetwork.stop();
  await providerOAuth.close();
  await shutdownEngine(!!update || headless);
  await knowledgeBridge?.close();
  knowledge?.network.close();
  knowledge?.tools.close();
  knowledge?.store.close();
  if (update) {
    nodeNetwork.files.close();
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    writeFileSync(join(dataRoot, 'update-shutdown.json'), JSON.stringify({ ...update, closed: true }), { mode: 0o600 });
  }
  server.close();
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
