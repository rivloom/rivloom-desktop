import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer } from 'node:http';
import { listenHttp } from './http-ports.ts';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import {
  db,
  users,
  user,
  projects,
  project,
  tasks,
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
  stopTask,
  addRequirement,
  replyPermission,
  replyQuestion,
  acceptResult,
  requestChanges,
  shutdownEngine,
  setTaskStartGuard,
} from './task-service.ts';
import { validateProject, redact } from './artifacts.ts';
import { dataRoot } from './engine.ts';
import { acquireDataLock } from './process-lock.ts';
import {
  activeStates,
  stateLabels,
  type Approval,
  type Artifact,
  type Question,
  type Task,
  type RemoteTaskInvite,
} from '../shared/types.ts';
import {
  modelSettings,
  defaultModel,
  saveDeepSeek,
  chooseDefaultModel,
  startConnectionCheck,
  cancelConnectionCheck,
  assertCanStartTask,
} from './model-settings.ts';
import { NodeNetwork, NodeNetworkError } from './node-network.ts';
import { ExecutionPolicyStore } from './execution-policy.ts';
import { WorkerResourceSampler, workerMatchesTask } from './worker-resources.ts';
import { WorkerAdmissionGate, occupiesWorkerSlot } from './worker-admission.ts';
import { validNodeProfile, type NodeProfile } from '../shared/node-profile.ts';
import { CreationRequestStore, CreationConflict } from './creation-requests.ts';
import {
  NodeQueueStore,
  NodeQueueError,
  canReleaseUnboundReservation,
  nodeQueueRecoveryDecision,
} from './node-queue.ts';
import { NodeHealthMonitor } from './node-health.ts';
import { isNodeQueueCandidate, type NodeQueueReason } from '../shared/node-queue.ts';

try {
  acquireDataLock();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
const app = express();
const creationRequests = new CreationRequestStore(db);
const nodeQueue = new NodeQueueStore(db);
const nodeHealth = new NodeHealthMonitor();
let lastQueueProgressAt: string | null = null;
const nodeNetwork = new NodeNetwork(dataRoot);
const executionPolicies = new ExecutionPolicyStore(dataRoot);
try {
  executionPolicies.load();
} catch (error) {
  console.error(error instanceof Error ? error.message : '本机执行能力配置无法读取。');
}
let workerSampler: WorkerResourceSampler | null = null;
nodeNetwork.setWorkerRegistrationProvider((nodeID) => {
  const policy = executionPolicies.snapshot();
  const configuredProject = policy.projectID
    ? projects().find((candidate) => candidate.id === policy.projectID) || null
    : null;
  const accepting =
    policy.enabled &&
    !!configuredProject &&
    !!policy.model &&
    engineStatus.ready &&
    engineStatus.models.some((candidate) => candidate.id === policy.model);
  const runningTasks = occupiedSlots();
  workerSampler ||= new WorkerResourceSampler(dataRoot);
  const report = workerSampler.sample({
    nodeID,
    accepting,
    projects: configuredProject ? [{ id: configuredProject.id, name: configuredProject.name }] : [],
    runningTasks,
    maxConcurrent: policy.maxConcurrent,
  });
  nodeHealth.observeResource(report.load);
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
function occupiedSlots(excludeTaskID?: string, excludeQueueID?: string) {
  const localTasks = tasks();
  const occupied = new Set(
    localTasks.filter((t) => t.id !== excludeTaskID && occupiesWorkerSlot(t)).map((t) => t.id),
  );
  for (const entry of nodeQueue.list()) {
    if (
      entry.id === excludeQueueID ||
      entry.state !== 'admitted' ||
      entry.localTaskID === excludeTaskID
    )
      continue;
    const local = localTasks.find((candidate) => candidate.id === entry.localTaskID);
    if (!local || local.state === 'ready') occupied.add(entry.localTaskID || entry.id);
  }
  for (const remote of nodeNetwork.remoteTaskRecords()) {
    if (remote.direction !== 'incoming' || !remote.brainTaskID || remote.status !== 'accepted')
      continue;
    const entry = queueForRemote(remote);
    if (entry || remote.localTaskID || remote.executionSequence > 0) continue;
    occupied.add(`remote:${remote.id}`);
  }
  return occupied.size;
}
function queueHealth() {
  return nodeHealth.assess({
    queue: nodeQueue.snapshot(),
    availableSlots: Math.max(0, 1 - occupiedSlots()),
    executionPaused: !executionPolicies.allows(),
    lastDispatchProgressAt: lastQueueProgressAt,
  });
}
nodeNetwork.setNodeQueueProvider(() => {
  const health = queueHealth();
  const snapshot = nodeQueue.snapshot();
  return {
    waitingCount: health.waitingCount,
    paused: snapshot.paused || !executionPolicies.allows(),
    updatedAt: snapshot.updatedAt,
    sampledAt: health.updatedAt,
    health: health.state,
  };
});
function intakeRemoteQueue(remote: RemoteTaskInvite) {
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
  const remote = nodeNetwork.remoteTask(remoteTaskID);
  return !!remote && queueForRemote(remote)?.state !== 'ended';
});
setTaskStartGuard((value) => {
  const entry = nodeQueue.list().find((candidate) => candidate.localTaskID === value.id);
  requireThat(
    !entry || entry.state === 'admitted',
    409,
    '此任务由 Node 队列管理，请等待准入或使用队列操作。',
  );
  requireThat(
    !occupiedSlots(value.id, entry?.id),
    409,
    '本机执行槽位已被运行、待验收或状态未知的任务占用。',
  );
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
app.use(express.json({ limit: '128kb' }));
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
function visibleTask(req: Request) {
  const t = task(String(req.params.id));
  requireThat(participant(t, who(req)), 403, '你不是此任务的参与者');
  return t;
}
function visibleNetwork(req: Request) {
  const snapshot = nodeNetwork.snapshot();
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
app.get('/api/bootstrap', (req, res) =>
  res.json({
    user: who(req),
    users: users(),
    projects: projects(),
    tasks: tasks().filter((t) => participant(t, who(req))),
    engine: engineStatus,
    defaultModel: defaultModel(),
    executionPolicy: executionPolicies.snapshot(),
    network: visibleNetwork(req),
  }),
);
app.get('/api/model-settings', (_req, res) => res.json(modelSettings()));
app.get('/api/network', (req, res) => res.json(visibleNetwork(req)));
app.get('/api/network/execution-policy', (_req, res) => res.json(executionPolicies.snapshot()));
const requireNetworkOwner = (req: Request) =>
  requireThat(who(req).owner, 403, '只有本机所有者可以管理设备信任');
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
      confirmed: z.literal(true),
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
  const saved = executionPolicies.save({
    enabled: input.enabled,
    approvalMode: input.approvalMode,
    projectID: input.projectID,
    model: input.model,
  });
  changed();
  queueMicrotask(() => void processRemoteTasks());
  res.json(saved);
});
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
    })
    .parse(req.body);
  const { requestID, ...normalized } = input;
  const createdTaskID = creationRequests.reserve(who(req).id, requestID, {
    routing: { kind: 'automatic' },
    ...normalized,
  });
  res.status(201).json(
    await nodeNetwork.createScheduledTask(
      {
        title: redact(input.title),
        description: redact(input.description),
        criteria: redact(input.criteria),
        requestedProjectID: input.requestedProjectID,
        requirements: input.requirements,
      },
      createdTaskID,
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
    })
    .parse(req.body);
  const nodeID = networkNodeID(req.params.nodeID);
  const { requestID, ...normalized } = input;
  const createdTaskID = creationRequests.reserve(who(req).id, requestID, {
    routing: { kind: 'node', nodeID },
    ...normalized,
  });
  res.status(201).json(
    await nodeNetwork.createTaskForNode(
      nodeID,
      {
        title: redact(input.title),
        description: redact(input.description),
        criteria: redact(input.criteria),
        requirements: input.requirements,
      },
      createdTaskID,
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
  res.json(
    await nodeNetwork.requestRemoteTaskControl(
      remoteTaskID(req),
      input.expectedExecutionSequence,
      input.action,
    ),
  );
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
      action: z.enum(['up', 'down', 'hold', 'resume', 'reject']),
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
        patchTask(current.id, { state: 'stopped', error: 'Node 已拒绝执行此排队任务。' });
      },
    );
    return applied;
  });
  changed();
  await publishQueueReceipts();
  void processRemoteTasks();
  res.json(result);
});

function remoteExecutionSummary(value: Task) {
  if (value.state === 'review') {
    const assistant = value.messages.filter((message) => message.role === 'assistant').at(-1)?.text;
    return redact(assistant?.trim() || 'AI 已完成执行，等待发起方查看结果。').slice(0, 12_000);
  }
  if (value.state === 'failed' || value.state === 'interrupted')
    return redact(value.error || stateLabels[value.state]);
  if (value.state === 'waiting_approval') return '执行节点正在等待本机审批。';
  if (value.state === 'waiting_input') return '执行节点正在等待本机补充信息。';
  if (value.state === 'running') return 'OpenCode 正在执行任务。';
  if (value.state === 'stopped') return '执行节点已停止任务，已完成的修改不会自动回滚。';
  return stateLabels[value.state];
}

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
        const local = tasks().find((candidate) => candidate.remoteOrigin?.remoteTaskID === taskID);
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
      let localTask = tasks().find((candidate) => candidate.remoteOrigin?.remoteTaskID === taskID);
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
        blocked(occupiedSlots() ? 'slot' : 'hardware_unavailable');
        await declinePending();
        return;
      }
      if (!localTask) {
        if (occupiedSlots(queueEntry?.localTaskID || undefined, queueEntry?.id)) {
          blocked('slot');
          await declinePending();
          return;
        }
        if (
          currentRemote.brainTaskID &&
          currentRemote.status === 'pending' &&
          nodeQueue
            .list()
            .some((candidate) => candidate.id !== queueEntry?.id && isNodeQueueCandidate(candidate))
        ) {
          await declinePending();
          return;
        }
        if (queueEntry?.state === 'waiting') {
          queueEntry = nodeQueue.setBlockReason(queueEntry.id, null);
          if (nodeQueue.list().find(isNodeQueueCandidate)?.id !== queueEntry.id) {
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
        localTask = {
          id: queueEntry.localTaskID!,
          number: Math.max(0, ...tasks().map((candidate) => candidate.number)) + 1,
          projectID,
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
          model: currentPolicy.model,
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
    if (occupiedSlots(current.id, entry.id) || nodeNetwork.projectLeased(current.projectID)) {
      setReason('slot');
      return;
    }
    if (entry.state === 'waiting') {
      entry = nodeQueue.setBlockReason(entry.id, null);
      if (nodeQueue.list().find(isNodeQueueCandidate)?.id !== entry.id) {
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
  if (dispatchingQueue) return;
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
          requireThat(!entry || entry.state !== 'ended', 409, '此任务的队列已终止，不能继续执行。');
          requireThat(
            !occupiedSlots(localTask.id, entry?.id),
            409,
            '本机槽位已被其他执行或预留占用。',
          );
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
  approvalMode: z.enum(['ask', 'auto', 'full']),
});
app.post('/api/tasks', (req, res) => {
  const { requestID, runRequested, ...input } = taskInput.parse(req.body);
  const createdTaskID = creationRequests.reserve(who(req).id, requestID, {
    routing: { kind: 'local' },
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
  requireThat(
    [input.assigneeID, input.approverID, input.reviewerID].every((uid) => user(uid)),
    400,
    '请选择已加入工作区的成员',
  );
  if (runRequested) {
    requireThat(who(req).id === input.assigneeID, 403, '只有指定接受人可以请求立即排队执行。');
    requireThat(queueHealth().accepting, 409, '本机等待队列已达到接收上限。');
  }
  const t: Task = {
    ...input,
    description: redact(input.description),
    criteria: redact(input.criteria),
    id: createdTaskID,
    number: Math.max(0, ...tasks().map((t) => t.number)) + 1,
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
  if (runRequested) nodeQueue.enqueue({ kind: 'local', taskID: t.id }, () => saveTask(t));
  else saveTask(t);
  activity(t.id, who(req).id, 'created', '创建任务并指定接受人、审批人和验收人。');
  changed(t.id);
  if (runRequested) void processRemoteTasks();
  res.status(201).json(t);
});
app.get('/api/tasks/:id', (req, res) =>
  res.json({ task: visibleTask(req), activities: activities(String(req.params.id)) }),
);
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
        requireThat(
          !occupiedSlots(t.id),
          409,
          '本机执行槽位已被运行、待验收或状态未知的任务占用。',
        );
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
  res.json(await replyQuestion(t.id, who(req), String(req.params.requestID), answers));
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
    nodeNetwork.off('update', onNetwork);
  });
});
app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
if (dev) {
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
  if (error instanceof z.ZodError)
    return void res.status(400).json({
      error: `输入不正确：${error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('；')}`,
    });
  if (error instanceof HttpError)
    return void res.status(error.status).json({ error: error.message });
  if (error instanceof NodeNetworkError)
    return void res.status(error.status).json({ error: error.message });
  if (error instanceof CreationConflict)
    return void res.status(error.status).json({ error: error.message });
  if (error instanceof NodeQueueError)
    return void res.status(error.status).json({ error: error.message });
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
  console.log(desktop ? `RIVLOOM_DESKTOP_READY ${url}` : `Rivloom: ${url}`);
  if (!users().length && !desktop)
    console.log(`首次初始化码保存在 ${join(dataRoot, 'setup-code.txt')}，请在页面中输入。`);
  void nodeNetwork.start();
  void initializeEngine();
}
let closing = false;
export async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(remoteTaskProcessor);
  updates.off('update', onTaskUpdateForNetwork);
  nodeNetwork.off('trust-revoked', onTrustRevoked);
  const deadline = setTimeout(() => process.exit(1), 6000);
  deadline.unref();
  removeDesktopToken();
  await nodeNetwork.stop();
  await shutdownEngine();
  server.close();
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
