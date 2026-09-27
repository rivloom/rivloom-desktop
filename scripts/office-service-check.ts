// Real application and pinned engine, deterministic loopback model, synthetic office files.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { modelFixture, ServiceClient, until } from './m34-fixtures.ts';
import { officeFixtureFiles } from './office-ui-preview.ts';
import type { Task } from '../shared/types.ts';

const root = resolve('.data/verification/office-workspace-20260926', `service-${randomUUID()}`);
const directory = join(root, 'project'); mkdirSync(root, { recursive: true }); await officeFixtureFiles(directory);
const toolResults: string[] = []; const offered = new Set<string>();
const model = await modelFixture(120000, input => {
  if (!JSON.stringify(input.messages).includes('OFFICE_READ_FIXTURE')) return { content: 'Office fixture' };
  for (const tool of input.tools || []) if (tool.function?.name) offered.add(tool.function.name);
  const results = input.messages.filter((message: any) => message.role === 'tool');
  for (const result of results) if (!toolResults.includes(result.content)) toolResults.push(result.content);
  const step = results.length;
  if (step === 0) return { toolName: 'rivloom_document_read', arguments: { path: '../outside.docx' } };
  if (step === 1) return { toolName: 'rivloom_document_read', arguments: { path: '简报.docx' } };
  if (step === 2) return { toolName: 'rivloom_document_read', arguments: { path: '销售.xlsx', sheet: 0 } };
  if (step === 3) return { toolName: 'rivloom_document_read', arguments: { path: '报告.pdf', page: 1 } };
  if (step === 4) return { toolName: 'write', arguments: { filePath: join(directory, '交付报告.md'), content: '# 合成办公报告\n\n来源：简报.docx、销售.xlsx（销售汇总）、报告.pdf（第 1 页）。\n\n华东收入 32000 元，成本 12000 元，利润 20000 元。\n' } };
  return { content: 'OFFICE_DELIVERED: 已读取三份合成材料，并保存交付报告.md。' };
});
model.release(); const service = new ServiceClient(join(root, 'local')); model.configure(service.root);
const report: Record<string, unknown> = { root, synthetic: true, checks: [] };
try {
  await service.start({ logPath: join(root, 'service.log') }); const data = await service.bootstrap(); report.engine = data.engine.version;
  const project = await service.call('/projects', { name: 'Office fixture', directory, trusted: true }, 201);
  const task = await service.call<Task>('/tasks', { requestID: randomUUID(), runRequested: true, projectID: project.id, title: 'Office files',
    description: 'OFFICE_READ_FIXTURE: Read the local DOCX, XLSX and PDF. Recover from a denied path, then use the write tool to save 交付报告.md. Only use the synthetic files in this project.',
    criteria: 'Read three documents and save the report.', assigneeID: data.user.id, approverID: data.user.id, reviewerID: data.user.id,
    model: 'fixture/m34', approvalMode: 'auto' }, 201);
  const result = await until(async () => (await service.call<{ task: Task }>(`/tasks/${task.id}`)).task,
    value => ['accepted', 'failed'].includes(value.state), 'office completion', 90000);
  assert.equal(result.state, 'accepted', result.error || JSON.stringify(result.messages));
  assert(offered.has('rivloom_document_read')); assert(toolResults.some(value => value.includes('office_path')));
  assert(toolResults.some(value => value.includes('季度经营简报')));
  assert(toolResults.some(value => value.includes('32000') && value.includes('office_cached_formulas')));
  assert(toolResults.some(value => value.includes('Quarterly Office Report') && value.includes('"page":1')));
  assert.match(readFileSync(join(directory, '交付报告.md'), 'utf8'), /利润 20000/);
  assert(result.messages.some(value => value.text.includes('OFFICE_DELIVERED')));
  assert.equal((await service.call('/model-settings/onboarding')).dismissed, false);
  await service.call('/model-settings/onboarding', {});
  await service.call('/model-settings/default', { model: 'fixture/m34' });
  await service.stop(); await service.start({ logPath: join(root, 'restart.log') });
  assert.equal((await service.call('/model-settings/onboarding')).dismissed, true);
  assert.equal((await service.call('/model-settings')).defaultModel, 'fixture/m34');
  assert.equal((await service.call<{ task: Task }>(`/tasks/${task.id}`)).task.model, 'fixture/m34');
  report.status = 'passed'; report.taskID = task.id;
  report.checks = ['real engine exposes document tool', 'out-of-project read rejected and task recovers', 'DOCX/XLSX/PDF text and provenance reach model',
    'multi-step task writes a report through normal write tool', 'onboarding dismissal and chosen model persist after restart', 'historical task model unchanged'];
} catch (error) { report.status = 'failed'; report.error = String(error); throw error; }
finally { await service.stop(); await model.close(); report.modelRequests = model.requests;
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
