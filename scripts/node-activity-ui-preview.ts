// Loopback-only UI fixture. All activity, connections and documents are synthetic and in memory.
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { NodeActivitySnapshot } from '../shared/node-activity.ts';
import type { NodeModelActivityCounts, NodeModelActivityConnection } from '../shared/node-model-activity.ts';
import type { OperationActivity } from '../shared/operation-activity.ts';
import type { AttentionItem } from '../shared/task-attention.ts';
import type { ModelSettings } from '../shared/types.ts';
import type { ProviderAccess } from '../shared/model-providers.ts';
import { startSearchPreview } from './conversation-search-preview.ts';

export const activityScenarios = ['parallel', 'partial-failure', 'input-only', 'output-only', 'none', 'confirmed-zero',
  'stale-counts', 'knowledge-running', 'knowledge-partial', 'knowledge-complete', 'idle', 'unavailable'] as const;
export type ActivityPreviewScenario = typeof activityScenarios[number];
const names: Record<ActivityPreviewScenario, string> = {
  parallel: '并行：3 个会话 / 2 个连接', 'partial-failure': '部分任务失败，其他会话正常输出',
  'input-only': '仅有输入数据', 'output-only': '仅有输出数据', none: '运行中但缺少指标',
  'confirmed-zero': '已确认零值', 'knowledge-running': '知识：多个动作进行中',
  'stale-counts': '会话计数不完整，仅保留有效连接分项',
  'knowledge-partial': '知识：进行中 + 部分失败', 'knowledge-complete': '知识：短暂完成反馈',
  idle: '全部空闲', unavailable: '活动接口不可用（隐藏过期指标）',
};
const counts = (value: Partial<NodeModelActivityCounts> = {}): NodeModelActivityCounts =>
  ({ active: 0, generating: 0, tools: 0, waiting: 0, failed: 0, ...value });
const providerA = 'preview-office', providerB = 'preview-lab';

export function activityPreviewSnapshot(scenario: ActivityPreviewScenario, knowledge: OperationActivity[] = [], now = Date.now()): NodeActivitySnapshot {
  const connections: NodeModelActivityConnection[] = [
    { id: providerA, name: '办公主连接', providerName: 'Synthetic Office', inputTokensPerSecond: 432, outputTokensPerSecond: 80,
      countsComplete: true, counts: counts({ active: 2, generating: 1, tools: 1 }) },
    { id: providerB, name: '研究备用连接 · 长名称窄栏检查', providerName: 'Synthetic Lab', inputTokensPerSecond: 168, outputTokensPerSecond: 48,
      countsComplete: true, counts: counts({ active: 1, generating: 1 }) },
  ];
  if (scenario === 'partial-failure') {
    connections[0].counts = counts({ active: 1, generating: 1 });
    connections[1].counts.failed = 1;
  }
  if (scenario === 'input-only' || scenario === 'none') for (const connection of connections) {
    connection.outputTokensPerSecond = null; connection.counts.generating = 0;
  }
  if (scenario === 'output-only' || scenario === 'none') for (const connection of connections) connection.inputTokensPerSecond = null;
  if (scenario === 'confirmed-zero') for (const connection of connections) {
    connection.inputTokensPerSecond = 0; connection.outputTokensPerSecond = 0;
    connection.counts = counts({ active: 1, waiting: 1 });
  }
  if (scenario === 'stale-counts') {
    connections[0].countsComplete = false;
    connections[0].inputTokensPerSecond = null;
    connections[0].outputTokensPerSecond = null;
  }
  if (scenario === 'idle') connections.length = 0;
  const total = counts();
  for (const connection of connections) for (const key of Object.keys(total) as (keyof NodeModelActivityCounts)[]) total[key] += connection.counts[key];
  const inputComplete = connections.length > 0 && connections.every(value => value.inputTokensPerSecond !== null);
  const outputComplete = connections.length > 0 && connections.every(value => value.outputTokensPerSecond !== null);
  return { models: {
    sampledAt: now, inputWindowSeconds: 60, outputWindowSeconds: 3, limited: false, inputComplete, outputComplete,
    inputTokensPerSecond: inputComplete ? connections.reduce((sum, value) => sum + value.inputTokensPerSecond!, 0) : null,
    outputTokensPerSecond: outputComplete ? connections.reduce((sum, value) => sum + value.outputTokensPerSecond!, 0) : null,
    countsComplete: connections.every(value => value.countsComplete), counts: total, connections,
  }, knowledge };
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 300_000) throw new Error('Preview input too large'); }
  return req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')
    ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw || '{}');
}
function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); return true;
}

export async function startNodeActivityPreview(dist = resolve('dist')) {
  let sidebarWidths: { history: number | null; network: number | null } = { history: null, network: null };
  let scenario: ActivityPreviewScenario = 'parallel', knowledge: OperationActivity[] = [], fileFailure = false, attentionCount = 0;
  let fileText = '# 合成项目资料\n\n此内容只存在于预览服务内存。\n\n可编辑并保存以检查文件活动；不会触及真实项目。\n';
  const revision = () => createHash('sha256').update(fileText).digest('hex');
  const models = [
    { id: `${providerA}/office-model`, name: 'Office model · 合成演示', modelName: 'Office model', providerID: providerA, providerName: 'Synthetic Office', accountName: '办公主连接' },
    { id: `${providerB}/lab-model`, name: 'Lab model · 合成演示', modelName: 'Lab model', providerID: providerB, providerName: 'Synthetic Lab', accountName: '研究备用连接 · 长名称窄栏检查' },
  ];
  const settings: ModelSettings = { defaultModel: models[0].id, models, deepseekConfigured: false, credentialState: 'unconfigured',
    credentialUpdatedAt: null, checks: {}, busy: false, busyReason: null, operations: [] };
  const providers: ProviderAccess[] = models.map(model => ({ id: model.providerID, name: model.providerName, accountName: model.accountName,
    connected: true, apiKey: false, modelCount: 1, oauth: [], custom: { id: model.providerID, name: model.providerName,
      baseURL: 'http://127.0.0.1:1/synthetic-only', protocol: 'chat', keyless: true, context: 32768, output: 4096,
      models: [{ id: model.id.split('/')[1], name: model.modelName }] } }));
  const setScenario = (next: ActivityPreviewScenario) => {
    scenario = next; knowledge = []; const now = Date.now();
    const operation = (action: OperationActivity['action'], status: OperationActivity['status'], error?: string): OperationActivity =>
      ({ id: randomUUID(), action, status, startedAt: now - 1500, updatedAt: now, ...(status !== 'running' ? { completedAt: now } : {}), ...(error ? { error } : {}) });
    if (next === 'knowledge-running' || next === 'knowledge-partial') knowledge = [operation('refresh', 'running'), operation('read', 'running'), operation('save', 'running'), operation('organize', 'running')];
    if (next === 'knowledge-partial') knowledge.push(operation('search', 'partial', 'knowledge_some_sources_unavailable'));
    if (next === 'knowledge-complete') knowledge = [operation('save', 'completed'), operation('organize', 'completed')];
  };
  const preview = await startSearchPreview(dist, async (req, res, data) => {
    const path = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' blob:; connect-src 'self'; media-src 'self' blob:; object-src 'none'; form-action 'self'");
    data.user.name = 'Node 活动验收 · 合成数据'; if (data.network.local) data.network.local.name = '演示 Node';
    data.engine.models = models; data.defaultModel = settings.defaultModel;
    for (const project of data.projects) { project.name = '活动预览素材'; project.directory = 'Synthetic / in-memory'; }
    if (path === '/activity-controls' && req.method === 'POST') {
      const input = await body(req);
      if (typeof input.scenario === 'string' && (activityScenarios as readonly string[]).includes(input.scenario)) setScenario(input.scenario as ActivityPreviewScenario);
      else if (input.action === 'file-failure') fileFailure = !fileFailure;
      else if (input.action === 'attention-add') attentionCount = Math.min(120, attentionCount + 1);
      else if (input.action === 'attention-clear') attentionCount = 0;
      else if (input.action === 'device-toggle') for (const peer of data.network.paired || []) {
        peer.online = !peer.online; peer.channelReady = peer.online; peer.lastSeen = new Date().toISOString();
      }
      else return json(res, { error: 'Unknown synthetic control' }, 400);
      preview.flush(); res.writeHead(303, { Location: '/activity-controls' }); res.end(); return true;
    }
    if (path === '/activity-controls') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Node activity · synthetic controls</title>
        <style>body{font:14px system-ui;max-width:760px;margin:32px auto;padding:0 20px;background:#f5f5f2;color:#242624}h1{font-size:22px}p{line-height:1.6}form{display:inline-block;margin:4px}button,a{padding:8px 12px}button{border:1px solid #b8bbb6;border-radius:6px;background:white;cursor:pointer}button[aria-pressed=true]{background:#dbeadf;border-color:#47865b}section{border-top:1px solid #d9dbd6;padding:16px 0}small{color:#626960}</style>
        <h1>Node 活动 · 合成场景控制</h1><p>仅本机预览。不会运行模型、访问凭据或读写真实项目。切换后原页面约 1 秒内更新。</p><p><a href="/" target="rivloom-activity-preview">打开 Rivloom 预览</a> <a href="/api/node-activity" target="_blank">查看当前合成数据</a></p>
        <section><strong>当前：${names[scenario]}</strong><div>${activityScenarios.map(value => `<form method="post" action="/activity-controls"><button name="scenario" value="${value}" aria-pressed="${value === scenario}">${names[value]}</button></form>`).join('')}</div></section>
        <section><strong>入口反馈</strong><div><form method="post"><button name="action" value="attention-add">增加一个待办（当前 ${attentionCount}）</button></form><form method="post"><button name="action" value="attention-clear">清空待办</button></form><form method="post"><button name="action" value="device-toggle">切换设备在线状态</button></form><form method="post"><button name="action" value="file-failure">文件读取/保存失败：${fileFailure ? '开启' : '关闭'}</button></form></div><p><small>项目文件入口提供一份内存 Markdown。读取/保存延迟 900ms，便于观察真实请求期间的反馈；成功后按产品逻辑消退。知识完成场景同样只短暂保留。</small></p></section></html>`); return true;
    }
    if (path === '/api/ui/sidebar-widths') {
      if (req.method === 'POST') {
        const input = await body(req);
        sidebarWidths = { history: typeof input.history === 'number' ? input.history : null, network: typeof input.network === 'number' ? input.network : null };
      }
      return json(res, sidebarWidths);
    }
    if (path === '/api/node-activity' && req.method === 'GET') return scenario === 'unavailable'
      ? json(res, { error: 'node_activity_unavailable' }, 503) : json(res, activityPreviewSnapshot(scenario, knowledge));
    if (path === '/api/node-activity/knowledge/dismiss' && req.method === 'POST') {
      const input = await body(req), item = knowledge.find(value => value.id === input.id);
      const dismissed = !!item && item.status !== 'running'; if (dismissed) knowledge = knowledge.filter(value => value !== item);
      return json(res, { dismissed });
    }
    if (path === '/api/model-settings/onboarding') return json(res, { dismissed: true });
    if (path === '/api/model-settings' && req.method === 'GET') return json(res, settings);
    if (path === '/api/model-settings/providers' && req.method === 'GET') return json(res, providers);
    if (path === '/api/model-settings/oauth' && req.method === 'GET') return json(res, null);
    if (path.startsWith('/api/model-settings')) return json(res, { error: 'Synthetic activity preview does not configure or call models.' }, 409);
    if (path === '/api/network/profile' && req.method === 'GET') return json(res, { name: data.network.local?.name || '演示 Node', icon: data.network.local?.icon || 'monitor' });
    if (path === '/api/attention/check') {
      const items: AttentionItem[] = Array.from({ length: attentionCount }, (_, i) => ({ key: `synthetic-attention-${i}`, conversationKey: `local:${data.tasks[0].id}`,
        kind: 'input', title: `合成待办 ${i + 1}`, detail: '请核对合成资料。', updatedAt: data.tasks[0].updatedAt, fingerprint: `synthetic-${i}` }));
      return json(res, { items, notifications: [], preferences: { enabled: false, quietUntil: null, completionSound: 'off' }, checkedAt: new Date().toISOString() });
    }
    if (path === '/api/knowledge' && req.method === 'GET') return json(res, { entries: [], brains: [], organization: null });
    if (path.startsWith('/api/knowledge')) return json(res, { error: 'Synthetic activity is controlled from /activity-controls.' }, 409);
    const prefix = `/api/projects/${data.projects[0].id}`;
    if (path === `${prefix}/files` || path.startsWith(`${prefix}/file/`)) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 900));
      if (fileFailure) return json(res, { error: 'office_unavailable' }, 503);
      const file = { name: '合成资料.md', bytes: Buffer.byteLength(fileText) };
      if (path === `${prefix}/files`) return json(res, { path: '', entries: [{ ...file, path: file.name, directory: false }], truncated: false });
      const route = `${prefix}/file/${encodeURIComponent(file.name)}`;
      if (path === route) return json(res, file);
      if (path === `${route}/document`) return json(res, { ...file, kind: 'markdown', revision: revision(), text: fileText, editable: true, encoding: 'utf-8', truncated: false, warnings: [] });
      if (path === `${route}/text`) return json(res, { text: fileText, revision: revision() });
      if (path === `${route}/save` && req.method === 'POST') {
        const input = await body(req); if (input.expectedRevision !== revision()) return json(res, { error: 'office_changed' }, 409);
        if (typeof input.text !== 'string' || Buffer.byteLength(input.text) > 256 * 1024) return json(res, { error: 'office_edit_unavailable' }, 400);
        fileText = input.text; return json(res, { revision: revision() });
      }
      return json(res, { error: 'office_unsupported' }, 400);
    }
    return false;
  });
  return { ...preview, controlsURL: `${preview.origin}/activity-controls`, setScenario, scenario: () => scenario };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const index = process.argv.indexOf('--dist');
  const preview = await startNodeActivityPreview(index >= 0 && process.argv[index + 1] ? resolve(process.argv[index + 1]) : undefined);
  console.log(JSON.stringify({ origin: preview.origin, controlsURL: preview.controlsURL, scenario: preview.scenario(), pid: process.pid }));
  process.once('SIGINT', () => void preview.close()); process.once('SIGTERM', () => void preview.close());
}
