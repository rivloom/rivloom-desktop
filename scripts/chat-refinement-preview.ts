// Synthetic browser fixture; never starts an engine or reads the user's data.
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { startSearchPreview } from './conversation-search-preview.ts';
import { sessionUsage } from '../shared/task-telemetry.ts';
import { quotedMessageText } from '../src/message-quote.ts';

const attempts: { requestID: string; text: string; failed: boolean; path: string }[] = [];
const distIndex = process.argv.indexOf('--dist');
const evidenceIndex = process.argv.indexOf('--evidence');
const evidence = evidenceIndex < 0 ? null : resolve(process.argv[evidenceIndex + 1]);
const save = async () => { if (evidence) await writeFile(evidence, JSON.stringify({ origin: preview.origin, attempts, requests: preview.requests }, null, 2)); };
const preview = await startSearchPreview(resolve(distIndex < 0 ? 'dist' : process.argv[distIndex + 1]), async (req, res, data) => {
  const path = new URL(req.url!, 'http://127.0.0.1').pathname;
  const json = (value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (req.method === 'GET' && path.startsWith('/api/task-files/')) {
    json({ inputs: [], results: [], canSave: false, canPublish: true, canRetry: false }); return true;
  }
  if (req.method === 'POST' && /^\/api\/(tasks|workflows)\/[^/]+\/messages$/.test(path)) {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const part of req) { bytes += part.length; if (bytes > 50_000) { json({ error: 'Fixture input too large' }, 413); return true; } chunks.push(part); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const failed = body.text.includes('模拟失败') && !attempts.some(item => item.requestID === body.requestID);
    attempts.push({ requestID: body.requestID, text: body.text, failed, path }); await save();
    if (failed) { json({ error: '合成测试：首次发送失败，请重试。' }, 500); return true; }
    const task = data.tasks.find(item => path.includes(item.id));
    if (task) {
      task.messages.push({ id: randomUUID(), role: 'user', text: body.text, tools: [] },
        { id: randomUUID(), role: 'assistant', text: '收到补充内容。引用与正文已一起送达，以上仅为隔离界面测试。', tools: [] });
      task.version++; task.updatedAt = new Date().toISOString(); json(task);
    } else {
      const workflow = data.workflows!.find(item => path.includes(item.id))!;
      workflow.messages ||= []; workflow.messages.push({ requestID: body.requestID, text: body.text, inputFiles: [], state: 'queued', createdAt: new Date().toISOString() });
      json(workflow);
    }
    preview.flush(); return true;
  }
  return false;
});
const data = preview.data, task = data.tasks[0], now = Date.now();
task.title = '聊天界面与引用验收'; task.description = '请帮我整理本次改动，保留已完成、已验证和待确认三部分。'; task.sessionID = 'synthetic-quote-session';
const answer = '本次改动可以整理为三部分：\n\n**已完成**：统一聊天布局，精简重复图标，并把引用独立展示为卡片。\n\n**已验证**：保留输入内容、切换会话恢复草稿、发送失败后重试。\n\n**待确认**：安装后的实际显示效果，以及日常长对话中的使用感受。';
task.messages = [{ id: 'synthetic-user', role: 'user', text: task.description, tools: [] },
  { id: 'synthetic-tool', role: 'assistant', text: '', tools: [{ name: 'question', title: 'question', status: 'error', output: 'Synthetic cancelled request' }] },
  { id: 'synthetic-answer', role: 'assistant', text: answer, tools: [], timing: { created: now - 20000, completed: now, outputTokens: 832, reasoningTokens: 0 } }];
task.telemetry = { source: 'opencode', sessionID: task.sessionID, runAfter: task.runAfter,
  usage: sessionUsage([{ info: { id: 'synthetic-answer', role: 'assistant', tokens: { input: 1250, output: 832, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 } }]),
  todos: { state: 'available', items: [], truncated: false, revision: 'synthetic' } };
data.user.name = '界面验收'; data.projects[0].name = '隔离演示文件夹'; data.network.local!.name = '本机 · 合成数据';
const workflow = data.workflows![0];
workflow.description = quotedMessageText('继续补充导出说明。', { author: 'assistant', text: '标题、配色和版式已确认。' });
data.workflows![2].messages![0].text = quotedMessageText('补充离线恢复的验收说明。', { author: 'assistant', text: '已有内容会保留，等待继续。' });
await save();
console.log(JSON.stringify({ url: preview.origin, taskID: task.id, workflowID: workflow.id, syntheticOnly: true }));
const close = async () => { await save(); await preview.close(); };
process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close());
