import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startWorkflowDiagnosticsPreview } from './workflow-diagnostics-preview.ts';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = resolve(process.env.RIVLOOM_UI_OUTPUT || '.data/verification/workflow-waiting-recovery-20260917');
await mkdir(output, { recursive: true });
const preview = await startWorkflowDiagnosticsPreview();
const report = { checks: [] as string[], errors: [] as string[], status: 'failed' };
const check = (name: string) => { report.checks.push(name); console.log('PASS', name); };
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'zh-CN', reducedMotion: 'reduce' });
await context.route('**/*', (route: any) => route.request().url().startsWith(preview.origin) ? route.continue() : route.abort());
const page = await context.newPage(); page.setDefaultTimeout(10000);
await page.addInitScript(() => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async (text: string) => { (window as any).copiedDiagnostic = text; },
  } });
});
page.on('pageerror', (error: Error) => report.errors.push(String(error)));
const panel = () => page.locator('.workflow-diagnostics');
const row = (title: string) => panel().locator('.workflow-diagnostic-step').filter({ has: page.getByRole('button', { name: title, exact: true }) });
const requests = () => preview.requests.filter((r) => r.path.endsWith('/diagnostics')).length;
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((ok) => setTimeout(ok, 50)); }
  throw new Error('UI condition did not settle');
}
try {
  await page.goto(preview.origin);
  await page.getByText('多机任务状态验收', { exact: true }).first().click();
  await panel().getByText('执行状态待确认', { exact: true }).waitFor();
  await panel().getByRole('button', { name: '查看全部 6 个步骤', exact: true }).click();
  assert((await row('生成音频').innerText()).includes('正在执行'));
  assert((await row('视频转码').innerText()).includes('当前没有满足要求的设备'));
  assert((await row('整理交付成果').innerText()).includes('等待：生成音频、视频转码'));
  assert((await row('准备字幕材料').innerText()).includes('正在准备输入材料'));
  assert((await row('生成封面').innerText()).includes('最近回执排位：2'));
  assert.equal(await row('检查远端字幕').getByRole('button', { name: '重试此步骤', exact: true }).count(), 0);
  check('Parallel branches expose waiting, dependencies, materials, queue receipts and unknown execution without unsafe retry');
  await row('视频转码').locator('summary').click();
  assert((await row('视频转码').innerText()).includes('FFmpeg 的可用状态待确认'));
  assert((await row('视频转码').innerText()).includes('当前未连接到设备'));
  await page.locator('#conversation-transcript').evaluate((element: HTMLElement) => { element.scrollTop = 0; });
  await page.screenshot({ path: resolve(output, 'workflow-diagnostics-zh.png'), fullPage: true });
  check('Evidence details show per-device causes and original report times');
  for (const [state, label] of [['held', '此项工作已暂缓'], ['admitted', '已获执行槽'], ['rejected', 'Node 已拒绝执行']] as const) {
    preview.queue(state);
    await panel().getByRole('button', { name: '刷新步骤状态' }).click();
    await row('生成封面').getByText(label, { exact: true }).waitFor();
    assert(!(await row('生成封面').innerText()).includes('最近回执排位'));
    assert.equal(await row('生成封面').getByRole('button', { name: '重试此步骤', exact: true }).count(), 0);
  }
  check('Held, admitted and rejected receipts replace queue position without enabling duplicate retries');
  const summary = panel().locator('.workflow-diagnostic-summary');
  await summary.locator('summary').click();
  await summary.getByRole('button', { name: '复制诊断摘要' }).click();
  await summary.getByText('已复制到剪贴板').waitFor();
  const copied = await page.evaluate(() => (window as any).copiedDiagnostic);
  assert.equal(copied, await summary.locator('pre').innerText());
  assert.equal(JSON.parse(copied).steps[4].queue.state, 'rejected');
  for (const privateText of [preview.value.id, preview.value.title, '工作笔记本', '书房电脑', 'FFmpeg']) assert(!copied.includes(privateText));
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Synthetic clipboard denial'); }; });
  await summary.getByRole('button', { name: '复制诊断摘要' }).click();
  await summary.getByText('复制失败，请选中文字后按 Ctrl+C。').waitFor();
  assert.equal(await summary.locator('pre').innerText(), copied);
  await summary.locator('pre').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, 'workflow-diagnostic-summary-zh.png'), fullPage: true });
  await summary.locator('summary').click();
  preview.queue('queued');
  await panel().getByRole('button', { name: '刷新步骤状态' }).click();
  await row('生成封面').getByText('已进入执行队列', { exact: true }).waitFor();
  check('Copy exports anonymous evidence and leaves selectable text when clipboard permission is unavailable');
  await row('视频转码').getByRole('button', { name: '查看连接诊断', exact: true }).last().click();
  await page.getByRole('heading', { name: '连接诊断', exact: true }).waitFor();
  assert.equal(await page.locator('.diagnostic-target select').inputValue(), preview.data.network.paired![0].id);
  await page.getByRole('button', { name: '返回会话', exact: true }).click();
  await panel().getByText('执行状态待确认', { exact: true }).waitFor();
  check('Device-specific diagnostics opens and returns to the same conversation');
  await row('视频转码').getByRole('button', { name: '修改此步骤', exact: true }).click();
  await page.getByRole('heading', { name: '修改尚未开始的步骤', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('heading', { name: '修改尚未开始的步骤', exact: true }).waitFor({ state: 'hidden' });
  check('Unstarted-step editing opens the existing editor');
  preview.fail(true);
  await panel().getByRole('button', { name: '刷新步骤状态' }).click();
  await panel().getByText('最新状态暂时无法确认；下方如有记录，仅供参考。', { exact: true }).waitFor();
  assert(await row('视频转码').getByRole('button', { name: '修改此步骤', exact: true }).isDisabled());
  assert.equal(JSON.parse(await panel().locator('.workflow-diagnostic-summary pre').textContent()).freshness, 'last_known');
  preview.fail(false);
  await panel().getByRole('button', { name: '刷新步骤状态' }).click();
  await panel().getByText('最新状态暂时无法确认；下方如有记录，仅供参考。', { exact: true }).waitFor({ state: 'hidden' });
  check('Failed refresh marks records as unconfirmed and successful refresh recovers');
  const beforeHidden = requests();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await new Promise((ok) => setTimeout(ok, 5500));
  assert.equal(requests(), beforeHidden);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await until(() => requests() > beforeHidden);
  check('Visibility changes suspend polling and refresh on return');
  preview.delay();
  await panel().getByRole('button', { name: '刷新步骤状态' }).click();
  await until(preview.held);
  preview.value.version++; preview.value.state = 'paused'; preview.flush();
  await panel().getByText('已暂停派发', { exact: true }).first().waitFor();
  preview.release();
  assert((await row('视频转码').innerText()).includes('已暂停派发'));
  check('Late diagnostic response cannot overwrite a newer workflow version');
  for (const width of [960, 390]) {
    await page.setViewportSize({ width, height: 960 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: resolve(output, `workflow-diagnostics-${width}.png`), fullPage: true });
    await panel().locator('.workflow-diagnostic-summary summary').click();
    await panel().locator('.workflow-diagnostic-summary pre').scrollIntoViewIfNeeded();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: resolve(output, `workflow-diagnostic-summary-${width}.png`), fullPage: true });
    await panel().locator('.workflow-diagnostic-summary summary').click();
  }
  check('Status and actions fit 960px and 390px layouts');
  await page.setViewportSize({ width: 1280, height: 960 });
  await page.locator('.language-control select').selectOption('en');
  await panel().getByText('Step status', { exact: true }).waitFor();
  await panel().locator('.workflow-diagnostic-summary summary').click();
  await panel().getByRole('button', { name: 'Copy diagnostic summary' }).waitFor();
  await panel().locator('.workflow-diagnostic-summary pre').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, 'workflow-diagnostics-en.png'), fullPage: true });
  check('English status and recovery copy renders');
  assert.equal(preview.requests.filter((r) => r.method === 'POST' && r.path.startsWith('/api/workflows')).length, 0);
  assert.deepEqual(report.errors, []);
  check('Viewing, navigation, refresh and cancelled editing never submit workflow mutations');
  report.status = 'passed';
} finally {
  preview.release();
  await writeFile(resolve(output, 'ui-report.json'), JSON.stringify({ ...report, requests: preview.requests }, null, 2));
  await browser.close(); await preview.close();
}
