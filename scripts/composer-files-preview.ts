// Isolated UI fixture: real file upload API/store, synthetic chats, no engine or user data.
import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { startSearchPreview } from './conversation-search-preview.ts';
import { TaskFileStore } from '../server/task-files.ts';
import { installTaskFileAPI } from '../server/task-file-api.ts';
import type { NodeNetwork } from '../server/node-network.ts';
import type { Bootstrap } from '../shared/types.ts';

const option = (name: string, fallback: string) => {
  const index = process.argv.indexOf(name); return resolve(index < 0 ? fallback : process.argv[index + 1]);
};
const root = option('--data', `.data/verification/composer-files-20260925/run-${randomUUID()}`);
if (!root.startsWith(resolve('.data/verification') + sep)) throw new Error('Fixture data must stay under .data/verification');
await mkdir(root, { recursive: true });
const dist = option('--dist', '.data/verification/composer-files-20260925/dist');
const uploads = new TaskFileStore(root), app = express(), failedOnce = new Set<string>();
const attempts: unknown[] = [];
let data: Bootstrap;
app.use(express.json({ limit: '100kb' }));
app.use(async (req, res, next) => {
  const match = req.path.match(/^\/api\/task-files\/uploads\/([^/]+)\/chunk$/);
  if (match) {
    await new Promise(done => setTimeout(done, 180));
    if (uploads.descriptorFor(match[1]).name === 'retry.txt' && !failedOnce.has(match[1])) {
      failedOnce.add(match[1]); res.status(503).json({ error: '合成测试：首次上传失败，请重试。' }); return;
    }
  }
  next();
});
installTaskFileAPI(app, { files: uploads } as NodeNetwork, () => data.user, () => data.tasks, () => {});
app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(error.status || 500).json({ error: error.message });
});
const save = async () => writeFile(resolve(root, 'evidence.json'), JSON.stringify({ origin: preview.origin, attempts, requests: preview.requests }, null, 2));
const preview = await startSearchPreview(dist, async (req, res, bootstrap) => {
  data = bootstrap;
  const path = new URL(req.url!, 'http://127.0.0.1').pathname;
  const json = (value: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (path.startsWith('/api/task-files/uploads')) {
    await new Promise<void>(done => { res.once('finish', done); app(req, res); }); await save(); return true;
  }
  if (path.startsWith('/api/task-files/')) { json({ inputs: [], results: [], canPublish: true, canSave: false, canRetry: false }); return true; }
  if (req.method === 'POST' && (path === '/api/workflows' || /^\/api\/workflows\/[^/]+\/messages$/.test(path))) {
    const parts: Buffer[] = []; let length = 0;
    for await (const part of req) { length += part.length; if (length > 100_000) throw new Error('Fixture body too large'); parts.push(part); }
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
    const attached = uploads.uploaded(data.user.id, body.attachmentIDs || []);
    attempts.push({ path, body, attached });
    if (path === '/api/workflows') {
      const workflow = { ...structuredClone(data.workflows![0]), id: randomUUID(), requestID: body.requestID, title: '附件发送验收', description: body.description,
        inputFiles: attached, target: body.target, rounds: [], messages: [], updatedAt: new Date().toISOString() };
      data.workflows!.unshift(workflow); json(workflow);
    } else {
      const workflow = data.workflows!.find(item => path.includes(item.id))!;
      workflow.messages ||= []; workflow.messages.push({ requestID: body.requestID, text: body.text, inputFiles: attached, state: 'queued', createdAt: new Date().toISOString() });
      json(workflow);
    }
    await save(); preview.flush(); return true;
  }
  if (path === '/') {
    const html = await readFile(resolve(dist, 'index.html'), 'utf8');
    res.setHeader('Content-Type', 'text/html');
    res.end(html.replace('</body>', `<details open id="fixture-dock" style="position:fixed;z-index:10000;right:20px;top:12px;background:#fff;border:1px solid #cbd2dc;border-radius:6px;padding:6px;font:12px sans-serif"><summary>合成拖拽测试素材</summary><button draggable="true" data-file="dragged.txt">拖动测试文件</button><button draggable="true" data-file="retry.txt">拖动重试文件</button><button draggable="true" data-batch="6">拖动 6 个文件</button></details><script src="/fixture-drag.js"></script></body>`)); return true;
  }
  if (path === '/fixture-drag.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(`const report = document.createElement('output'); report.id='fixture-drag-events'; document.querySelector('#fixture-dock').append(report);
    document.querySelectorAll('#fixture-dock [draggable]').forEach(button => button.addEventListener('dragstart', event => {
      event.dataTransfer.effectAllowed = 'copy';
      const count = Number(button.dataset.batch || 1);
      for (let i=0;i<count;i++) event.dataTransfer.items.add(new File(['SYNTHETIC FILE ONLY\\n'.repeat(6000)], button.dataset.file || 'batch-'+i+'.txt', {type:'text/plain'}));
      report.textContent='Start: '+Array.from(event.dataTransfer.types).join(',')+' / '+event.dataTransfer.files.length;
    }));
    window.addEventListener('drop', event => { report.textContent+=' Drop: '+Array.from(event.dataTransfer.types).join(',')+' / '+event.dataTransfer.files.length; }, true);
    // Browser-internal drags can strip generated File objects. These explicit fixture
    // controls test real DOM listeners with a Files transfer, not an OS drag claim.
    for (const [label, eventName, count] of [['模拟拖入高亮','dragover',1],['模拟松开文件','drop',1],['模拟超额文件','drop',6],['模拟离开','dragleave',0]]) {
      const control=document.createElement('button'); control.textContent=label;
      control.addEventListener('click', () => {
        const transfer=new DataTransfer();
        for(let i=0;i<count;i++) transfer.items.add(new File(['Synthetic drop verification'], 'drop-'+i+'.txt', {type:'text/plain'}));
        document.querySelector('.conversation-composer textarea').dispatchEvent(new DragEvent(eventName, {bubbles:true,cancelable:true,dataTransfer:transfer}));
      });
      document.querySelector('#fixture-dock').append(control);
    }`); return true;
  }
  return false;
});
data = preview.data;
data.user.name = '附件交互验收'; data.projects[0].name = '合成演示文件夹'; data.network.local!.name = '本机';
// Use a valid 32-character node identity; drafts reject malformed routing IDs.
const peer = data.network.paired?.[0];
if (!peer) throw new Error('Synthetic peer missing');
peer.id = 'a'.repeat(32);
for (const task of data.tasks) if (task.remoteOrigin) task.remoteOrigin.ownerNodeID = peer.id;
await writeFile(resolve(root, 'selected.txt'), 'Synthetic file chooser content. No user data.\n');
await writeFile(resolve(root, 'second.txt'), 'Second synthetic file.\n');
await save();
console.log(JSON.stringify({ url: preview.origin, root, chooserFile: resolve(root, 'selected.txt'), syntheticOnly: true }));
const close = async () => { await save(); await preview.close(); uploads.close(); };
process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close());
