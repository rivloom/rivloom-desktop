// Synthetic, loopback-only production UI preview. No engine, identity, model, or real workspace access.
import { createServer, type ServerResponse, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import type { Bootstrap, Task } from '../shared/types.ts';
import type { Workflow, WorkflowAttempt, WorkflowRound } from '../shared/workflows.ts';
import { workflowStep } from '../server/workflows.ts';
import { listenHttp } from '../server/http-ports.ts';

export function searchPreviewData(): Bootstrap {
  const when = new Date().toISOString(), user = { id: 'search-preview-owner', username: 'preview', name: '搜索验收', owner: true };
  const projectID = 'search-preview-project', localID = 'search-preview-local', model = 'preview/no-model';
  const blank = (id: string, title: string) => workflowStep({ id, title, instructions: '仅用于界面验收。', dependsOn: [], nodeID: null, resources: [], software: [], requirements: {} });
  const workflow = (title: string, description: string): Workflow => ({
    id: randomUUID(), requestID: randomUUID(), contentDigest: '0'.repeat(64), creatorID: user.id, title, description, criteria: '',
    projectID, model, approvalMode: 'ask', target: { mode: 'automatic' }, state: 'completed', version: 1, planVersion: 1,
    summary: '按要求整理材料，完成后保存结果。', planner: { ...blank('planner', '规划'), state: 'completed' }, steps: [], events: [], handoffs: [],
    inputFiles: [], confirmations: [], pendingConfirmation: null, createdAt: when, updatedAt: when, error: null,
  });
  const run = (w: Workflow, number: number, summary: string): WorkflowAttempt => ({
    number, executionID: randomUUID(), nodeID: localID, kind: 'local', phase: 'completed', createdAt: when, updatedAt: when, summary,
    outcome: { kind: 'completed', summary, files: [] }, inputFiles: [], outputFiles: [], error: null, handled: true,
    context: { workflowID: w.id, stepID: 'result', attempt: number, role: 'executor', target: w.target, instructions: '', evidence: '', priorContext: '' },
  });
  const result = (w: Workflow, summary: string) => {
    w.steps = [{ ...blank('result', '整理成果'), state: 'completed', checkpoint: summary, attempts: [run(w, 1, summary)] }];
  };
  const poster = workflow('海报设计与修改', '先制作一张深海蓝主题海报，保留标题与日期。');
  result(poster, '## 初稿完成\n\n海报采用 **深海蓝**，标题居中，底部保留日期。\n\n| 元素 | 处理 |\n| --- | --- |\n| 背景 | 深海蓝 |\n| 文字 | 暖白 |\n\n可以继续修改配色。');
  poster.rounds = [{ ...structuredClone(poster), requestID: poster.requestID } as WorkflowRound];
  poster.roundRequestID = randomUUID(); poster.description = '第二轮请改成珊瑚橙，标题靠左。';
  result(poster, '第二稿采用**珊瑚橙**，标题已靠左，日期和比例保持。');
  poster.rounds.push({ ...structuredClone(poster), requestID: poster.roundRequestID, rounds: undefined } as WorkflowRound);
  poster.roundRequestID = randomUUID(); poster.description = '最后增加导出说明和配置示例。';
  result(poster, '## 交付说明\n\n最终稿和导出配置已整理。\n\n```json\n{ "preset": "C++ [draft]", "accent": "coral" }\n```\n\n以上均为搜索验收的演示内容。');

  const video = workflow('制作产品短片', '制作两秒的视频，并保留音频步骤的成果。'); video.state = 'failed'; video.summary = '先准备音频，再合并视频。';
  const audio = { ...blank('audio', '生成音频'), state: 'completed' as const, checkpoint: '音频素材准备完成。', attempts: [run(video, 1, '音频素材准备完成。')] };
  const first = run(video, 1, '音频检查点：已保存波形，等待接力处理。');
  first.outcome = { kind: 'handoff', nodeID: null, reason: '继续处理', checkpoint: first.summary, files: [], processesStopped: true };
  const second = run(video, 2, ''); second.phase = 'failed'; second.outcome = null; second.error = 'workflow_execution_failed';
  video.steps = [audio, { ...blank('result', '合并短片'), dependsOn: ['audio'], state: 'failed', checkpoint: '等待修正时长。', attempts: [first, second] }];

  const notes = workflow('整理发布说明', '整理已完成的改动与验证结果。'); result(notes, '发布说明已整理，接下来可以补充恢复场景。'); notes.queuePaused = true;
  notes.messages = [{ requestID: randomUUID(), text: '补充离线恢复的验收说明。', inputFiles: [], state: 'queued', createdAt: when },
    { requestID: randomUUID(), text: 'CANCELLED_PRIVATE_SENTINEL', inputFiles: [], state: 'cancelled', createdAt: when }];

  const task = (title: string, incoming = false): Task => ({
    id: randomUUID(), number: incoming ? 2 : 1, title, description: incoming ? '请汇总远端执行的情况。' : '请检查旧接口的迁移路径。\n\n补充要求：保留 Safari 兼容性。',
    criteria: '', projectID, creatorID: user.id, assigneeID: user.id, approverID: user.id, reviewerID: user.id, acceptedBy: user.id,
    state: 'accepted', version: 1, createdAt: when, updatedAt: when, model, approvalMode: 'ask', sessionID: null, runAfter: 0,
    messages: [{ id: randomUUID(), role: 'user', text: 'ENGINE_PRIVATE_SENTINEL', tools: [] },
      { id: randomUUID(), role: 'assistant', text: incoming ? '远端报告：缓存校验完成，传输完整。' : '## 接口迁移\n\n' + Array.from({ length: 36 }, (_, i) => `- 检查第 ${i + 1} 项兼容性，保留现有配置。`).join('\n') + '\n\n离线缓冲已覆盖重连场景。\n\n```typescript\nconst mode = "C++ [draft]";\nconsole.log(mode);\n```',
        tools: [{ name: 'read', title: '读取示例记录', status: 'completed', output: 'TOOL_PRIVATE_SENTINEL' }] }],
    approvals: [], questions: [], artifacts: [], diffSource: '', error: null,
    ...(incoming ? { remoteOrigin: { remoteTaskID: 'preview-remote', ownerNodeID: 'preview-peer', ownerBrainID: 'preview-brain' } } : {}),
  });
  const node = { protocolVersion: 1, addresses: [], port: 1, fingerprint: 'synthetic', brains: [], capabilities: [], worker: null,
    verified: true, lastSeen: when, icon: 'monitor', trusted: true, online: true, channelReady: true };
  const data = {
    user, users: [user], tasks: [task('接口迁移记录'), task('另一台设备的报告', true)], workflows: [poster, video, notes],
    projects: [{ id: projectID, name: '搜索验收素材', directory: 'C:/Rivloom-search-preview', createdAt: when }],
    engine: { ready: true, version: 'preview', models: [{ id: model, name: '演示 · 不调用模型' }], error: null }, defaultModel: model,
    executionPolicy: { enabled: false, projectID, model, approvalMode: 'ask', maxConcurrent: 3, updatedAt: when },
    network: { status: 'online', serviceType: 'synthetic', local: { ...node, id: localID, name: '搜索验收 · 演示数据', local: true },
      paired: [{ ...node, id: 'preview-peer', name: '演示笔记本', local: false }], nearby: [], pairings: [], remoteTasks: [], brainTasks: [], brains: [], error: null },
    conversationTrash: [], conversationPreferences: { [`workflow:${poster.id}`]: { pinned: true } },
  } as unknown as Bootstrap;
  return data;
}

export async function startSearchPreview(dist = resolve('dist'), extension?: (req: IncomingMessage, res: ServerResponse, data: Bootstrap) => Promise<boolean>) {
  const data = searchPreviewData(), feeds = new Set<ServerResponse>(), requests: { method: string; path: string }[] = [];
  const flush = () => { for (const res of feeds) res.write('event: update\ndata: {}\n\n'); };
  const json = (res: ServerResponse, value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url || '/', 'http://127.0.0.1').pathname;
      if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host || '')) return json(res, { error: 'Loopback preview only' }, 403);
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(res, { error: 'Origin rejected' }, 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, { error: 'Cross-site request rejected' }, 403);
      requests.push({ method: req.method || 'GET', path });
      if (extension && await extension(req, res, data)) return;
      if (path === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        res.write('event: connected\ndata: {}\n\n'); feeds.add(res); req.on('close', () => feeds.delete(res)); return;
      }
      if (req.method === 'POST' && path === '/api/ui/drafts') {
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const part of req) { bytes += part.length; if (bytes > 1_000_000) return json(res, { error: 'Preview input too large' }, 413); chunks.push(part); }
        data.conversationDrafts = JSON.parse(Buffer.concat(chunks).toString('utf8')).value; return json(res, { ok: true });
      }
      if (req.method === 'POST' && path !== '/api/attention/check') return json(res, { error: '这是搜索演示，请在正式应用中执行任务。' }, 409);
      if (path === '/api/bootstrap') return json(res, data);
      if (path === '/api/network') return json(res, data.network);
      if (path === '/api/node-queue') return json(res, { version: 1, paused: false, updatedAt: new Date().toISOString(), entries: [] });
      if (path === '/api/ui/sidebar-widths') return json(res, { history: null, network: null });
      if (path === '/api/attention/check') return json(res, { items: [], notifications: [], preferences: { enabled: false, quietUntil: null } });
      if (path.startsWith('/api/tasks/')) return json(res, { task: data.tasks.find((task) => task.id === path.split('/').at(-1)), activities: [] });
      if (path.startsWith('/api/task-files/')) return json(res, { inputs: [], results: [], canSave: false, canPublish: false, canRetry: false });
      if (path.startsWith('/api/')) return json(res, { error: 'This endpoint is not part of the search preview' }, 404);
      const file = resolve(dist, '.' + (path === '/' ? '/index.html' : path));
      if (!file.startsWith(dist + sep)) return json(res, { error: 'Invalid path' }, 403);
      const bytes = await readFile(file);
      res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' } as Record<string, string>)[extname(file)] || 'application/octet-stream' });
      res.end(bytes);
    } catch { if (!res.headersSent) json(res, { error: 'Preview content unavailable' }, 404); else res.end(); }
  });
  await listenHttp(server, '127.0.0.1');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const close = async () => { for (const res of feeds) res.end(); server.closeAllConnections(); await new Promise<void>((ok) => server.close(() => ok())); };
  return { data, requests, origin, flush, close };
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const distIndex = process.argv.indexOf('--dist');
  const preview = await startSearchPreview(distIndex === -1 ? undefined : resolve(process.argv[distIndex + 1]));
  console.log(`Rivloom search preview: ${preview.origin}\nSynthetic data only. Press Ctrl+C to stop.`);
  if (process.argv.includes('--open')) {
    if (process.platform === 'win32') execFile('rundll32.exe', ['url.dll,FileProtocolHandler', preview.origin]);
    else console.log('Open the URL above in your browser.');
  }
  process.once('SIGINT', () => void preview.close()); process.once('SIGTERM', () => void preview.close());
}
