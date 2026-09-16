import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startModelPickerPreview, modelPickerFixture } from './model-picker-preview.ts';

// Use an installed Playwright runtime; no browser or dependency downloads here.
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = resolve(process.env.RIVLOOM_UI_OUTPUT || '.data/verification/model-picker-20260916');
await mkdir(output, { recursive: true });
const preview = await startModelPickerPreview();
const report = { checks: [] as string[], errors: [] as string[] };
const check = (name: string) => {
  report.checks.push(name);
  console.log('PASS', name);
};
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  locale: 'zh-CN',
  reducedMotion: 'reduce',
});
await context.route('**/*', (route: any) =>
  route.request().url().startsWith(preview.origin) ? route.continue() : route.abort(),
);
const page = await context.newPage();
page.setDefaultTimeout(10000);
page.on('pageerror', (error: Error) => report.errors.push(String(error)));
const trigger = () => page.getByRole('button', { name: '执行模型', exact: true });
const search = () => page.getByRole('combobox', { name: '搜索模型', exact: true });
const panel = () => page.locator('.model-picker-panel');
async function inBounds() {
  const box = await panel().boundingBox();
  const viewport = page.viewportSize();
  assert(
    box &&
      box.x >= 0 &&
      box.y >= 0 &&
      box.x + box.width <= viewport.width &&
      box.y + box.height <= viewport.height,
  );
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
}
try {
  await page.goto(preview.origin);
  await trigger().click();
  await search().waitFor();
  assert(await search().evaluate((element: HTMLElement) => element === document.activeElement));
  assert.deepEqual(
    await panel()
      .locator('[role="group"]')
      .evaluateAll((elements: HTMLElement[]) =>
        elements.map((el) => el.querySelector('.model-picker-group')!.textContent),
      ),
    ['DeepSeek 官方', 'Local', 'opencode-go', 'opencode-go-anthropic'],
  );
  assert.equal(
    await panel().getByRole('option', { selected: true }).getAttribute('title'),
    'opencode-go/deepseek-v4-flash',
  );
  assert.equal(
    await panel()
      .locator('[title="deepseek/deepseek-v4-flash-vision-exp"] .model-picker-badge')
      .allTextContents()
      .then((v: string[]) => v.join(',')),
    '1M,图片',
  );
  assert.equal(await panel().locator('[title="local/org/model"] .model-picker-badge').count(), 0);
  await inBounds();
  await page.screenshot({ path: resolve(output, 'grouped-desktop.png') });
  await panel().screenshot({ path: resolve(output, 'grouped-menu.png') });
  check(
    'Provider groups, same-model independent selection, known/unknown badges, focus and desktop positioning',
  );

  await search().fill('deepseek-v4-flash');
  assert.equal(await panel().getByRole('group').count(), 2);
  await panel().locator('[role="option"][title="deepseek/deepseek-v4-flash"]').click();
  assert.equal(await panel().count(), 0);
  assert((await trigger().getAttribute('title')).includes('deepseek/deepseek-v4-flash'));
  assert(await trigger().evaluate((element: HTMLElement) => element === document.activeElement));
  await trigger().press('ArrowDown');
  assert.equal(await search().inputValue(), '');
  assert.equal(
    await panel().getByRole('option', { selected: true }).getAttribute('title'),
    'deepseek/deepseek-v4-flash',
  );
  check('Duplicate model names choose and retain the exact provider and restore trigger focus');

  await search().fill('OPENCODE-GO   kimi');
  assert.equal(await panel().getByRole('option').count(), 2);
  await search().press('ArrowDown');
  await search().press('Enter');
  assert((await trigger().getAttribute('title')).includes('opencode-go/kimi-k3'));
  check('Case-insensitive provider/model term search, natural ordering and keyboard selection');

  await trigger().click();
  await search().fill('missing-provider');
  await page.getByRole('status').filter({ hasText: '没有匹配的模型' }).waitFor();
  await search().press('Enter');
  assert(await panel().isVisible());
  await search().press('Escape');
  assert.equal(await panel().count(), 0);
  assert((await trigger().getAttribute('title')).includes('opencode-go/kimi-k3'));
  check('No matches never select an unrelated model; Escape preserves selection');

  await trigger().click();
  await search().fill('kimi');
  await search().dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  assert(await panel().isVisible());
  assert((await trigger().getAttribute('title')).includes('opencode-go/kimi-k3'));
  await search().press('Escape');
  check('IME confirmation does not select or submit a model');

  await trigger().click();
  await search().fill('org/model');
  assert.equal(await panel().getByRole('option').count(), 1);
  await search().press('Enter');
  await page.reload();
  await trigger().waitFor();
  assert((await trigger().getAttribute('title')).includes('local/org/model'));
  await trigger().click();
  await search().fill('kimi');
  await search().press('Tab');
  assert.equal(await panel().count(), 0);
  await trigger().click();
  await page.locator('.conversation-header').click({ position: { x: 15, y: 15 } });
  assert.equal(await panel().count(), 0);
  check(
    'Slash model IDs, persisted selection after reload, Tab navigation and outside-click dismissal',
  );

  await trigger().click();
  preview.data.engine.models = [{ id: 'legacy/org/model', name: 'Legacy model · Legacy provider' }];
  preview.flush();
  await panel().locator('[role="option"][title="legacy/org/model"]').waitFor();
  assert.equal(await panel().getByRole('option').count(), 1);
  await search().fill('legacy');
  await search().press('Enter');
  assert((await trigger().getAttribute('title')).includes('legacy/org/model'));
  preview.data.engine.models = [];
  preview.flush();
  await page.waitForFunction(() =>
    document.querySelector('.model-picker-trigger')?.textContent?.includes('尚未连接模型'),
  );
  await trigger().click();
  assert.equal(await panel().getByRole('option').count(), 0);
  await search().press('Enter');
  assert(await panel().isVisible());
  await search().press('Escape');
  check('Live catalog removal, backward-compatible snapshots and zero-model state');

  preview.data.engine.models = structuredClone(modelPickerFixture);
  preview.data.engine.models.push({
    id: 'long/org/very-long-model',
    name: 'Long model · Very long provider',
    providerID: 'long',
    providerName: 'Very long custom provider name '.repeat(6),
    modelName: 'model-with-a-very-long-identifier-'.repeat(6),
    contextWindow: 262144,
    supportsImages: true,
  });
  preview.flush();
  await page.setViewportSize({ width: 390, height: 844 });
  await trigger().click();
  await search().fill('very-long');
  await panel().locator('[role="option"][title="long/org/very-long-model"]').waitFor();
  assert.equal(await panel().getByRole('option').count(), 1);
  await inBounds();
  await page.screenshot({ path: resolve(output, 'grouped-mobile.png') });
  await search().press('Escape');
  await page.setViewportSize({ width: 1280, height: 420 });
  await trigger().click();
  await inBounds();
  await search().press('Escape');
  check('390px narrow window, wrapped long labels and short-window boundaries');

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('.language-control select').selectOption('en');
  await page.getByRole('button', { name: 'Execution model', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search models', exact: true }).fill('kimi');
  assert.equal(await panel().getByRole('option').count(), 2);
  assert.equal(await panel().getByText('Images', { exact: true }).count(), 2);
  await inBounds();
  await page.screenshot({ path: resolve(output, 'grouped-english.png') });
  await page.getByRole('combobox', { name: 'Search models', exact: true }).press('Escape');
  assert.deepEqual(report.errors, []);
  assert.equal(
    preview.requests.filter(
      (request) => request.method === 'POST' && /model-settings|workflows|tasks/.test(request.path),
    ).length,
    0,
  );
  check('English labels, no browser errors and no automatic model/task request');

  const submitted: any[] = [];
  let releaseSubmission!: () => void;
  const submissionGate = new Promise<void>((done) => {
    releaseSubmission = done;
  });
  await page.route('**/api/workflows', async (route: any) => {
    submitted.push(route.request().postDataJSON());
    await submissionGate;
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Synthetic submission captured; no task executed.' }),
    });
  });
  await page.getByRole('button', { name: 'Execution model', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Search models', exact: true })
    .fill('opencode-go deepseek-v4-flash');
  await panel().getByRole('option').click();
  await page.locator('.conversation-composer textarea').fill('Synthetic model routing check');
  await Promise.all([
    page.waitForRequest('**/api/workflows'),
    page.getByRole('button', { name: 'Send message', exact: true }).click(),
  ]);
  assert.equal(submitted[0].model, 'opencode-go/deepseek-v4-flash');
  assert(await page.getByRole('button', { name: 'Execution model', exact: true }).isDisabled());
  releaseSubmission();
  await page.getByRole('alert').filter({ hasText: 'Synthetic submission captured' }).waitFor();
  check(
    'Explicit send uses the exact selected provider/model ID and locks selection while submitting (request intercepted locally)',
  );
} finally {
  await writeFile(
    resolve(output, 'ui-report.json'),
    JSON.stringify({ ...report, requests: preview.requests }, null, 2),
  );
  await browser.close();
  await preview.close();
}
