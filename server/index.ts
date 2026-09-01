import express, { type Request, type Response, type NextFunction } from 'express';
import { readFile } from 'node:fs/promises';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
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
  replyPermission,
  replyQuestion,
  acceptResult,
  shutdownEngine,
} from './task-service.ts';
import { validateProject, redact } from './artifacts.ts';
import { dataRoot } from './engine.ts';
import { acquireDataLock } from './process-lock.ts';
import { activeStates, type Task } from '../shared/types.ts';
import {
  modelSettings,
  defaultModel,
  saveDeepSeek,
  chooseDefaultModel,
  startConnectionCheck,
  cancelConnectionCheck,
  assertCanStartTask,
} from './model-settings.ts';
import { NodeNetwork } from './node-network.ts';

try {
  acquireDataLock();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
const app = express();
const nodeNetwork = new NodeNetwork(dataRoot);
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
    network: nodeNetwork.snapshot(),
  }),
);
app.get('/api/model-settings', (_req, res) => res.json(modelSettings()));
app.get('/api/network', (_req, res) => res.json(nodeNetwork.snapshot()));
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
  projectID: z.string().uuid(),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(12000),
  criteria: z.string().trim().min(1).max(4000),
  assigneeID: z.string().uuid(),
  approverID: z.string().uuid(),
  reviewerID: z.string().uuid(),
  model: z.string().min(3).max(200),
});
app.post('/api/tasks', (req, res) => {
  const input = taskInput.parse(req.body);
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
  const t: Task = {
    ...input,
    description: redact(input.description),
    criteria: redact(input.criteria),
    id: id(),
    number: Math.max(0, ...tasks().map((t) => t.number)) + 1,
    creatorID: who(req).id,
    acceptedBy: null,
    state: 'open',
    version: 1,
    createdAt: now(),
    updatedAt: now(),
    sessionID: null,
    baseCommit: null,
    runAfter: 0,
    messages: [],
    approvals: [],
    questions: [],
    artifacts: [],
    artifactHash: null,
    diffSource: '',
    error: null,
  };
  saveTask(t);
  activity(t.id, who(req).id, 'created', '创建任务并指定接受人、审批人和验收人。');
  changed(t.id);
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
    await exclusive('engine-settings', async () => {
      assertCanStartTask();
      return exclusive(`project:${t.projectID}`, () => runTask(t.id, who(req), body.addition));
    }),
  );
});
app.post('/api/tasks/:id/stop', async (req, res) =>
  res.json(await stopTask(visibleTask(req).id, who(req))),
);
app.post('/api/tasks/:id/requirements', async (req, res) => {
  const initial = visibleTask(req);
  const body = z.object({ text: z.string().trim().min(1).max(12000) }).parse(req.body);
  await exclusive(`project:${initial.projectID}`, async () => {
    const t = task(initial.id);
    requireThat(
      [t.creatorID, t.assigneeID].includes(who(req).id),
      403,
      '只有发起人或接受人可以补充要求',
    );
    requireThat(t.state !== 'accepted', 409, '已验收任务不可修改');
    if (activeStates.includes(t.state) || t.state === 'interrupted') await stopTask(t.id, who(req));
    patchTask(t.id, { description: `${task(t.id).description}\n\n补充要求：${redact(body.text)}` });
    activity(
      t.id,
      who(req).id,
      'requirement',
      `补充要求（由接受人确认后继续）：${redact(body.text)}`,
    );
    changed(t.id);
    res.json(task(t.id));
  });
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
  await exclusive(initial.id, async () => {
    const t = task(initial.id);
    requireThat(who(req).id === t.reviewerID, 403, '只有验收人可以退回');
    requireThat(t.state === 'review', 409, '任务不在验收阶段');
    const result = patchTask(t.id, {
      state: 'ready',
      description: `${t.description}\n\n验收退回：${redact(note)}`,
    });
    activity(t.id, who(req).id, 'changes_requested', `退回修改：${redact(note)}`);
    changed(t.id);
    res.json(result);
  });
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
  res.status(500).json({ error: '操作未完成。请检查任务状态、Git 仓库及引擎连接后重试。' });
});
const server = app.listen(port, '127.0.0.1', (error?: Error) => {
  if (error) {
    console.error(`无法监听端口 ${port}：${error.message}。请勿同时启动开发与生产服务。`);
    process.exit(1);
  }
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
});
let closing = false;
export async function shutdown() {
  if (closing) return;
  closing = true;
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
