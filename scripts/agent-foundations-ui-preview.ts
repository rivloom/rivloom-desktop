// Production UI with synthetic conversations and real template/Git APIs on isolated data.
// This preview never starts an engine, sends tasks, or opens the installed application's data.
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { startSearchPreview } from './conversation-search-preview.ts';
import { installPromptTemplateAPI } from '../server/prompt-template-api.ts';
import { PromptTemplateStore } from '../server/prompt-templates.ts';
import { installProjectChangesAPI } from '../server/project-changes-api.ts';
import type { Bootstrap } from '../shared/types.ts';
import { WorkflowStore } from '../server/workflows.ts';
import { WorkflowService, type WorkflowExecutionAdapter } from '../server/workflow-service.ts';
import { validWorkflowMessageEdit } from '../shared/workflows.ts';

export async function startFoundationsPreview() {
  const root = resolve('.data/verification/agent-foundations-20260918', `preview-${randomUUID()}`);
  const directory = join(root, 'project'); mkdirSync(directory, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=NUL', ...args], { cwd: directory, windowsHide: true, stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.name', 'Rivloom isolated preview'); git('config', 'user.email', 'preview@example.invalid');
  writeFileSync(join(directory, 'review.txt'), 'Original line\n'); git('add', '--', 'review.txt'); git('commit', '-qm', 'Synthetic fixture');
  writeFileSync(join(directory, 'review.txt'), 'Staged change\n'); git('add', '--', 'review.txt');
  writeFileSync(join(directory, 'review.txt'), 'Staged change\nWorking change\n');
  writeFileSync(join(directory, '说明.txt'), '隔离预览文件，不是真实项目。\n');
  writeFileSync(join(directory, '.env'), 'SYNTHETIC_SECRET=should-not-be-rendered\n');
  writeFileSync(join(directory, 'binary.bin'), Buffer.from([0, 1, 2]));
  const db = new DatabaseSync(join(root, 'templates.db')); const store = new PromptTemplateStore(db);
  const workflows = new WorkflowStore(db);
  const forbidden = async (): Promise<never> => { throw new Error('Execution is disabled in this preview'); };
  const adapter: WorkflowExecutionAdapter = { candidates: () => [], evidence: () => '', lookup: forbidden, dispatch: forbidden,
    stop: forbidden, query: forbidden, materialize: forbidden, stageInputs: forbidden };
  const service = new WorkflowService(workflows, adapter);
  const app = express(); app.use(express.json({ limit: '256kb' })); let data: Bootstrap;
  installPromptTemplateAPI(app, () => data.user, store);
  installProjectChangesAPI(app, () => data.user, () => data.projects);
  app.post('/api/workflows/:id/messages/edit', (req, res) => {
    if (!validWorkflowMessageEdit(req.body)) { res.status(400).json({ error: 'workflow_message_edit_invalid' }); return; }
    const id = String(req.params.id), workflow = workflows.get(id);
    if (!workflow || workflow.creatorID !== data.user.id) { res.status(404).json({ error: 'workflow_not_found' }); return; }
    try {
      const value = service.editMessage(id, req.body); data.workflows = (data.workflows || []).map(item => item.id === id ? value : item); res.json(value); preview.flush();
    } catch (error) { res.status(409).json({ error: (error as Error).message }); }
  });
  const preview = await startSearchPreview(resolve('dist'), async (req, res, value) => {
    data = value;
    if (!/^\/api\/(prompt-templates|projects)(\/|$)/.test(req.url || '') && !/^\/api\/workflows\/[^/]+\/messages\/edit$/.test(req.url || '')) return false;
    app(req, res); return true;
  });
  data = preview.data; data.projects[0].directory = directory; data.projects[0].name = 'Agent 功能验收 · 隔离项目';
  data.user.name = '本地功能验收'; data.network.local!.name = '本地预览 · 不执行任务';
  for (const workflow of data.workflows || []) db.prepare('INSERT INTO workflows VALUES (?,?,?,?,?)')
    .run(workflow.id, workflow.creatorID, workflow.requestID, workflow.version, JSON.stringify(workflow));
  const task = data.tasks[0]; task.sessionID = 'synthetic-session'; task.runAfter = Date.now() - 1000;
  task.telemetry = { source: 'opencode', sessionID: task.sessionID, runAfter: task.runAfter,
    usage: { scope: 'session', assistantMessages: 2, cost: 0.0123, tokens: { input: 1600, output: 520, reasoning: null, cacheRead: 400, cacheWrite: 0, total: null } },
    todos: { state: 'available', revision: 'synthetic-todo', truncated: false, items: [
      { content: '检查现有接口', status: 'completed', priority: 'high' },
      { content: '验证兼容性', status: 'in_progress', priority: 'medium' },
      { content: '整理交付说明', status: 'pending', priority: 'low' },
    ] } };
  store.create(data.user.id, { title: '验收清单', text: '请核对需求、功能边界和验证结果，再给出下一步建议。' });
  store.create(data.user.id, { title: '代码审查', text: '请审查当前改动的正确性，说明具体位置和回归风险。' });
  return { ...preview, root, db, store, close: async () => { await preview.close(); await service.close(); db.close(); } };
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const preview = await startFoundationsPreview();
  const report = { origin: preview.origin, root: preview.root, pid: process.pid, startedAt: new Date().toISOString(), synthetic: true, noEngine: true };
  writeFileSync(resolve('.data/verification/agent-foundations-20260918/preview.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  process.once('SIGINT', () => void preview.close()); process.once('SIGTERM', () => void preview.close());
}
