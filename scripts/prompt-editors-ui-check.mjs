// Isolated component/browser checks; no installed data, model, account or network service is used.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import express from 'express';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { listenHttp } from '../server/http-ports.ts';
import { PromptTemplateStore } from '../server/prompt-templates.ts';
import { installPromptTemplateAPI } from '../server/prompt-template-api.ts';
import { WorkflowStore } from '../server/workflows.ts';
import { WorkflowService } from '../server/workflow-service.ts';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = resolve('.data/verification/agent-foundations-20260918', `prompt-editors-ui-${randomUUID()}`);
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [], output, synthetic: true, noEngine: true };
const check = text => { report.checks.push(text); console.log('PASS', text); };
const db = new DatabaseSync(':memory:'), templates = new PromptTemplateStore(db), workflows = new WorkflowStore(db);
const sideEffects = [], service = new WorkflowService(workflows, {
  candidates: () => [], evidence: () => '', lookup: async () => null,
  dispatch: async () => { sideEffects.push('dispatch'); return { state: 'accepted' }; },
  stop: async () => { sideEffects.push('stop'); return 'stopped'; }, query: async () => [], materialize: async () => [], stageInputs: async (_workflow, _key, files) => files,
});
const template = templates.create('fixture-user', { title: 'Saved example', text: 'Original template body' });
const workflow = service.create({ requestID: randomUUID(), creatorID: 'fixture-user', title: 'Fixture workflow', description: 'Current request', projectID: null, model: null, approvalMode: 'ask', target: { mode: 'automatic' }, inputFiles: [] });
const pendingID = randomUUID(); service.enqueue(workflow.id, pendingID, 'Pending original', []); service.messageControl(workflow.id, 'pause');
const initialMessage = workflows.get(workflow.id).messages[0];
const entry = join(output, 'entry.tsx');
await writeFile(entry, `import React,{useState} from 'react';
import{createRoot}from'react-dom/client';
import{PromptTemplateLibrary}from'/src/prompt-template-library.tsx';
import{PendingMessageEditor}from'/src/pending-message-editor.tsx';
import{applyMessageReuse}from'/src/message-reuse.ts';
import'/src/styles.css';
function Fixture(){const[draft,setDraft]=useState({text:'',requestID:'fixture-request',routing:{kind:'workflow',target:{mode:'automatic'}},files:[]});
const[library,setLibrary]=useState(false),[pending,setPending]=useState(false),[message,setMessage]=useState(${JSON.stringify(initialMessage)}),[saved,setSaved]=useState(0);
return <main style={{padding:24}}><label>Fixture draft<textarea aria-label="Fixture draft" value={draft.text} onChange={e=>setDraft({...draft,text:e.target.value})}/></label>
<button onClick={()=>setLibrary(true)}>Open templates fixture</button><button onClick={()=>setPending(true)}>Open pending fixture</button><output aria-label="Saved pending count">{saved}</output>
{library&&<PromptTemplateLibrary scopeKey="fixture-user" draft={draft} existingConversation onApply={intent=>{const value=applyMessageReuse(draft,intent,true);if(!value.ok)return false;setDraft(value.draft);return true}} close={()=>setLibrary(false)}/>}
{pending&&<PendingMessageEditor workflowID="${workflow.id}" message={message} onSaved={value=>{setMessage(value.messages.find(m=>m.requestID===message.requestID));setSaved(saved+1)}} close={()=>setPending(false)}/>}
</main>}createRoot(document.getElementById('root')).render(<Fixture/>);`, 'utf8');
const html = `<html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body><div id="root"></div><script type="module" src="./entry.tsx"></script></body></html>`;
await writeFile(join(output, 'index.html'), html);
console.log('Building isolated component fixture');
await build({ configFile: false, root: output, plugins: [react()], logLevel: 'error', resolve: { alias: { '/src': resolve('src') } },
  build: { outDir: join(output, 'dist'), emptyOutDir: false } });
const app = express(); app.use(express.json()); let gate = null, release = () => {};
const writes = [];
app.use('/api', async (req, _res, next) => { if (req.method === 'POST') { writes.push({ path: req.path, body: req.body }); if (gate) await gate; } next(); });
installPromptTemplateAPI(app, () => ({ id: 'fixture-user' }), templates);
app.post(`/api/workflows/${workflow.id}/messages/edit`, (req, res, next) => { try { res.json(service.editMessage(workflow.id, req.body)); } catch (error) { next(error); } });
app.use((error, _req, res, _next) => res.status(error.status || 409).json({ error: error.message }));
app.use(express.static(join(output, 'dist')));
const server = createServer(app), port = await listenHttp(server, '127.0.0.1'), origin = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ channel: process.env.RIVLOOM_BROWSER_CHANNEL || 'msedge', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(12_000);
  page.on('pageerror', error => report.errors.push(String(error)));
  await page.goto(origin); await page.getByRole('button', { name: 'Open templates fixture' }).click();
  const library = () => page.getByRole('dialog', { name: '提示词模板', exact: true });
  const editor = () => page.getByRole('dialog', { name: /^(新建模板|编辑模板)$/ });
  const discard = () => page.getByRole('dialog', { name: '放弃未保存的修改？', exact: true });
  await page.getByText('Saved example', { exact: true }).waitFor();
  assert(await library().getByRole('button', { name: '将当前草稿存为模板' }).isDisabled());
  await library().getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('textbox', { name: 'Fixture draft' }).fill('x'.repeat(12001));
  await page.getByRole('button', { name: 'Open templates fixture' }).click();
  assert(await library().getByRole('button', { name: '将当前草稿存为模板' }).isDisabled());
  await library().getByRole('button', { name: '关闭', exact: true }).click();
  const sourceDraft = 'A user draft\nwith exact formatting.';
  await page.getByRole('textbox', { name: 'Fixture draft' }).fill(sourceDraft);
  await page.getByRole('button', { name: 'Open templates fixture' }).click();
  await library().getByRole('button', { name: '将当前草稿存为模板' }).click();
  assert.equal(await editor().getByRole('textbox', { name: '模板正文' }).inputValue(), sourceDraft);
  assert.equal(await editor().getByRole('textbox', { name: '模板名称' }).inputValue(), '');
  assert.equal(writes.length, 0); check('draft-to-template copies only bounded nonempty body into an unsaved named editor');
  await editor().getByRole('textbox', { name: '模板名称' }).fill('Draft copy');
  await editor().getByRole('button', { name: '取消', exact: true }).click(); await discard().waitFor();
  await discard().getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.equal(await editor().getByRole('textbox', { name: '模板名称' }).inputValue(), 'Draft copy');
  await page.keyboard.press('Escape'); await discard().waitFor();
  await page.keyboard.press('Escape'); await discard().waitFor({ state: 'hidden' });
  await editor().getByRole('button', { name: '关闭', exact: true }).click(); await discard().waitFor();
  await discard().getByRole('button', { name: '放弃修改', exact: true }).click(); await editor().waitFor({ state: 'hidden' });
  assert(await library().isVisible()); assert.equal(writes.length, 0); check('template cancel, Escape and close require explicit discard; keeping edits preserves text');
  await library().getByRole('button', { name: '将当前草稿存为模板' }).click();
  await editor().getByRole('textbox', { name: '模板名称' }).fill('Draft copy');
  await editor().getByRole('button', { name: '保存', exact: true }).click(); await editor().waitFor({ state: 'hidden' });
  assert.equal(await discard().count(), 0); assert.equal(templates.list('fixture-user').find(item => item.title === 'Draft copy').text, sourceDraft);
  assert.deepEqual(Object.keys(writes[0].body).sort(), ['id', 'text', 'title']);
  assert.equal(await page.getByRole('textbox', { name: 'Fixture draft' }).inputValue(), sourceDraft);
  check('explicit save persists only id/name/text and leaves the source draft untouched without a discard prompt');
  await library().getByRole('button', { name: '编辑模板：Saved example' }).click();
  await editor().getByRole('textbox', { name: '模板正文' }).fill('Saved after delayed request');
  gate = new Promise(resolve => { release = resolve; });
  await editor().getByRole('button', { name: '保存', exact: true }).click();
  await editor().getByRole('button', { name: '正在保存…', exact: true }).waitFor();
  await page.keyboard.press('Escape'); await editor().getByRole('button', { name: '关闭', exact: true }).click();
  assert(await editor().isVisible()); assert.equal(await discard().count(), 0);
  gate = null; release(); await editor().waitFor({ state: 'hidden' }); check('an in-flight template save cannot be dismissed or mistaken for an unsaved cancellation');
  await library().getByRole('button', { name: '编辑模板：Saved example' }).click();
  await editor().getByRole('textbox', { name: '模板正文' }).fill('Keep my conflicting edits');
  const current = templates.get('fixture-user', template.id); templates.update('fixture-user', template.id, current.revision, { title: current.title, text: 'Saved in another window' });
  await editor().getByRole('button', { name: '保存', exact: true }).click();
  await editor().getByText('Saved in another window', { exact: true }).waitFor();
  assert.equal(await editor().getByRole('textbox', { name: '模板正文' }).inputValue(), 'Keep my conflicting edits');
  await editor().getByRole('button', { name: '将当前编辑另存为新模板', exact: true }).click();
  assert.equal(await editor().getByRole('textbox', { name: '模板正文' }).inputValue(), 'Keep my conflicting edits');
  await editor().getByRole('button', { name: '取消', exact: true }).click(); await discard().getByRole('button', { name: '放弃修改', exact: true }).click();
  await library().getByRole('button', { name: '关闭', exact: true }).click(); check('template conflicts preserve edits, expose the latest version and permit an explicit new copy');
  await page.getByRole('button', { name: 'Open pending fixture' }).click();
  const pending = () => page.getByRole('dialog', { name: '编辑待执行消息', exact: true });
  await pending().getByRole('textbox', { name: '消息正文' }).fill('Revised pending request');
  await pending().getByRole('button', { name: '取消', exact: true }).click(); await discard().getByRole('button', { name: '继续编辑', exact: true }).click();
  await page.keyboard.press('Escape'); await discard().waitFor(); await page.keyboard.press('Escape'); await discard().waitFor({ state: 'hidden' });
  await pending().getByRole('button', { name: '关闭', exact: true }).click(); await discard().getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.equal(await pending().getByRole('textbox', { name: '消息正文' }).inputValue(), 'Revised pending request');
  gate = new Promise(resolve => { release = resolve; });
  await pending().getByRole('button', { name: '保存修改', exact: true }).click(); await pending().getByRole('button', { name: '正在保存…', exact: true }).waitFor();
  await page.keyboard.press('Escape'); await pending().getByRole('button', { name: '关闭', exact: true }).click(); assert(await pending().isVisible());
  gate = null; release(); await pending().waitFor({ state: 'hidden' });
  assert.equal(workflows.get(workflow.id).messages[0].text, 'Revised pending request'); assert.equal(workflows.get(workflow.id).queuePaused, true);
  assert.equal(await discard().count(), 0); check('pending edits guard all close paths and in-flight saves, then save without resuming the queue');
  await page.getByRole('button', { name: 'Open pending fixture' }).click();
  await pending().getByRole('textbox', { name: '消息正文' }).fill('Unsent conflicting edit');
  service.editMessage(workflow.id, { requestID: pendingID, expectedText: 'Revised pending request', text: 'Edited by another window' });
  await pending().getByRole('button', { name: '保存修改', exact: true }).click(); await pending().getByRole('alert').waitFor();
  assert.equal(await pending().getByRole('textbox', { name: '消息正文' }).inputValue(), 'Unsent conflicting edit');
  await pending().getByRole('button', { name: '取消', exact: true }).click(); await discard().waitFor();
  await page.screenshot({ path: join(output, 'pending-conflict-discard.png'), fullPage: true });
  await discard().getByRole('button', { name: '放弃修改', exact: true }).click(); await pending().waitFor({ state: 'hidden' });
  assert.equal(workflows.get(workflow.id).messages[0].text, 'Edited by another window'); check('a conflicting pending edit remains copyable and requires explicit discard before closing');
  assert.deepEqual(sideEffects, []); assert.deepEqual(report.errors, []); check('no model/task execution, external requests or browser page errors');
  report.passed = true;
} catch (error) { report.passed = false; report.errors.push(String(error?.stack || error)); throw error; }
finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ output, passed: report.passed, checks: report.checks.length }));
  gate = null; release(); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await service.close(); db.close();
}
