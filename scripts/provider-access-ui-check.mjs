import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startModelAccessPreview } from './model-access-preview.ts';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = resolve(
  process.env.RIVLOOM_UI_OUTPUT || '.data/verification/provider-access-20260916',
);
await mkdir(output, { recursive: true });
const preview = await startModelAccessPreview();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const report = { checks: [], errors: [] },
  check = (text) => {
    report.checks.push(text);
    console.log('PASS', text);
  };
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  locale: 'zh-CN',
  reducedMotion: 'reduce',
});
await context.route('**/*', (route) =>
  route.request().url().startsWith(preview.origin) ? route.continue() : route.abort(),
);
const page = await context.newPage();
page.setDefaultTimeout(10000);
page.on('pageerror', (e) => report.errors.push(String(e)));
const overflow = async () =>
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
try {
  await page.goto(preview.origin);
  await page.getByRole('button', { name: '设备与模型', exact: true }).click();
  await page.getByRole('heading', { name: '模型接入', exact: true }).waitFor();
  const box = page.locator('.provider-settings');

  assert.equal(
    await box.getByRole('tab', { name: /账号登录/ }).getAttribute('aria-selected'),
    'true',
  );
  assert.equal(await box.locator('.provider-choice[title="deepseek"]').count(), 0);
  assert(await box.locator('.provider-choice[title="openai"]').isVisible());
  assert(await box.getByRole('button', { name: '登录 OpenAI' }).isVisible());
  assert.equal(await box.getByLabel('API Key', { exact: true }).count(), 0);
  await page.screenshot({ path: resolve(output, 'account-entry-desktop.png') });
  await box.screenshot({ path: resolve(output, 'account-entry-card.png') });
  check(
    'Account sign-in is visible on first opening, with real OAuth providers and no default DeepSeek key form',
  );
  await box.getByLabel('查找厂商').fill('ChatGPT');
  assert.equal(await box.locator('.provider-choice').count(), 1);
  await box.getByLabel('查找厂商').fill('missing-provider');
  await box.getByText('没有匹配的厂商，请尝试其他名称。').waitFor();
  assert.equal(await box.getByRole('button', { name: /^登录 / }).count(), 0);
  await box.getByLabel('查找厂商').fill('');
  await box.getByRole('tab', { name: /账号登录/ }).press('ArrowRight');
  assert.equal(
    await box.getByRole('tab', { name: /API Key/ }).getAttribute('aria-selected'),
    'true',
  );
  await box.getByLabel('API Key', { exact: true }).fill('synthetic-unsaved-key');
  assert(await box.getByRole('button', { name: '保存凭据', exact: true }).isEnabled());
  await box.locator('.provider-choice[title="openai"]').click();
  assert.equal(await box.getByLabel('API Key', { exact: true }).inputValue(), '');
  assert.equal(await box.getByRole('checkbox').count(), 0);
  assert(await box.getByRole('button', { name: '保存凭据', exact: true }).isDisabled());
  await box.getByLabel('API Key', { exact: true }).fill('synthetic-saved-key');
  await box.getByRole('button', { name: '保存凭据', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('.provider-meta')?.textContent.includes('已接入'),
  );
  assert.equal(await box.getByLabel('API Key', { exact: true }).inputValue(), '');
  assert.equal(await box.getByRole('button', { name: /^登录 / }).count(), 0);
  await page.screenshot({ path: resolve(output, 'api-key-entry.png') });
  await box.getByRole('tab', { name: /账号登录/ }).click();
  check(
    'Search and keyboard tabs work; provider switching clears unsubmitted keys and valid API credentials save directly without quota confirmation',
  );
  await box.locator('.provider-choice[title="openai"]').click();
  assert(await box.getByRole('button', { name: '登录 OpenAI' }).isEnabled());
  assert.equal(await box.getByRole('checkbox').count(), 0);
  await box.getByRole('button', { name: '登录 OpenAI' }).click();
  await box
    .getByText('演示授权码：RIVLOOM-DEMO。请勿输入真实账号或凭据。', { exact: true })
    .waitFor();

  assert(await box.getByRole('tab', { name: /API Key/ }).isDisabled());
  assert(await box.getByRole('tab', { name: /自定义服务/ }).isDisabled());
  await page.screenshot({ path: resolve(output, 'oauth-desktop.png') });
  await box.getByRole('button', { name: '已完成授权，连接' }).click();
  await box.getByText('账号已接入，可选择模型。', { exact: true }).waitFor();
  const oauthAccount = preview.providers
    .filter((p) => p.account?.providerID === 'openai' && p.connected)
    .at(-1);
  assert(oauthAccount);
  await page
    .getByLabel('要测试的模型', { exact: true })
    .selectOption(`${oauthAccount.id}/demo-model`);
  check(
    'Official OAuth starts directly without quota confirmation; browser instructions, completion and model availability render',
  );
  await box.locator('.provider-choice[title="github-copilot"]').click();
  await box.getByLabel('Select GitHub deployment type').selectOption('enterprise');
  await box.getByLabel('Enter your GitHub Enterprise URL or domain').fill('enterprise.example');
  await box.getByLabel('Select GitHub deployment type').selectOption('github.com');
  assert.equal(await box.getByLabel('Enter your GitHub Enterprise URL or domain').count(), 0);
  check('Conditional vendor login fields follow the selected deployment');
  await box.locator('.provider-choice[title="openai"]').click();
  await box.getByLabel('厂商 OAuth 登录').selectOption('1');
  await box.getByRole('button', { name: '登录 OpenAI' }).click();
  await box.getByLabel('厂商返回的授权码').waitFor();
  assert(await box.getByRole('button', { name: '已完成授权，连接' }).isDisabled());
  await box.getByRole('button', { name: '取消登录' }).click();
  await box.getByText('登录已取消。', { exact: true }).waitFor();
  check('Authorization code flow requires a code and can be cancelled');
  await box.getByRole('tab', { name: /API Key/ }).click();
  await box.locator('.provider-choice[title="opencode-go"]').click();
  await box.getByLabel('账号别名', { exact: true }).fill('Go Work');
  await box.getByLabel('API Key', { exact: true }).fill('synthetic-go-work');
  await box.getByRole('button', { name: '保存凭据', exact: true }).click();
  await box.getByRole('button', { name: 'OpenCode Go · Go Work 3', exact: true }).waitFor();
  await box.getByRole('button', { name: '添加账号', exact: true }).click();
  assert.equal(await box.getByLabel('API Key', { exact: true }).inputValue(), '');
  await box.getByLabel('账号别名', { exact: true }).fill('Go Personal');
  await box.getByLabel('API Key', { exact: true }).fill('synthetic-go-personal');
  await box.getByRole('button', { name: '保存凭据', exact: true }).click();
  await box.getByRole('button', { name: 'OpenCode Go · Go Personal 3', exact: true }).waitFor();
  const goAccounts = preview.providers.filter((p) => p.account?.providerID === 'opencode-go');
  assert.equal(goAccounts.length, 2);
  assert.notEqual(goAccounts[0].id, goAccounts[1].id);
  await box.getByLabel('账号别名', { exact: true }).fill('Go Backup');
  await box.getByRole('button', { name: '保存别名', exact: true }).click();
  await box.getByRole('button', { name: 'OpenCode Go · Go Backup 3', exact: true }).waitFor();
  assert.equal(preview.providers.filter((p) => p.account?.providerID === 'opencode-go').length, 2);
  await box.getByRole('button', { name: 'OpenCode Go · Go Work 3', exact: true }).click();
  assert.equal(await box.getByLabel('账号别名', { exact: true }).inputValue(), 'Go Work');
  await box.screenshot({ path: resolve(output, 'multiple-go-accounts.png') });
  check(
    'Two Go accounts can be added independently, switched and renamed without changing their stable IDs or exposing keys',
  );
  await box.getByRole('tab', { name: /自定义服务/ }).click();
  await box.getByLabel('显示名称', { exact: true }).fill('My local provider');
  await box.getByLabel('Provider ID', { exact: true }).fill('local-check');
  await box.getByLabel('API 地址', { exact: true }).fill('http://localhost:1234/v1');
  await box
    .getByLabel('模型 ID（每行一个）', { exact: true })
    .fill('org/model | Local model\nsecond-model');
  await box.getByLabel('API Key', { exact: true }).fill('synthetic-ui-secret');
  await box.getByText('上下文容量（可选）', { exact: true }).click();
  await page.screenshot({ path: resolve(output, 'custom-desktop.png') });
  await overflow();
  await box.getByRole('button', { name: '保存 Provider', exact: true }).click();
  await box.getByRole('button', { name: 'My local provider 2', exact: true }).waitFor();
  assert(
    !(await page
      .locator('input[type=password]')
      .evaluateAll((els) => els.some((el) => el.value === 'synthetic-ui-secret'))),
  );
  await page.getByLabel('默认模型', { exact: true }).selectOption('local-check/org/model');
  await page.getByRole('button', { name: '保存默认模型', exact: true }).click();
  await page.locator('.default-card footer').filter({ hasText: 'local-check/org/model' }).waitFor();
  check(
    'Custom provider accepts URL, secret and multiple exact model IDs; saving clears secret and supports default selection',
  );
  await box.getByRole('button', { name: 'My local provider 2', exact: true }).click();
  assert(await box.getByLabel('Provider ID', { exact: true }).isDisabled());
  assert.equal(await box.getByLabel('API Key', { exact: true }).inputValue(), '');
  await box.getByLabel('接口协议').selectOption('responses');
  await box.getByLabel('模型 ID（每行一个）', { exact: true }).fill('third-model | Updated model');
  await box.getByRole('button', { name: '保存 Provider', exact: true }).click();
  await box.getByRole('button', { name: 'My local provider 1', exact: true }).waitFor();
  await page.getByLabel('要测试的模型', { exact: true }).selectOption('local-check/third-model');
  check('Editing preserves a blank key, replaces models and selects Responses protocol');
  await box.getByRole('button', { name: '添加另一个服务', exact: true }).click();
  assert.equal(await box.getByLabel('Provider ID', { exact: true }).inputValue(), '');
  assert(!(await box.getByLabel('Provider ID', { exact: true }).isDisabled()));
  await box.getByLabel('显示名称', { exact: true }).fill('Second local service');
  await box.getByLabel('Provider ID', { exact: true }).fill('second-local');
  await box.getByLabel('API 地址', { exact: true }).fill('http://localhost:1235/v1');
  await box.getByLabel('模型 ID（每行一个）', { exact: true }).fill('local-model');
  await box.getByRole('checkbox', { name: '此服务不需要 API Key', exact: true }).check();
  assert.equal(await box.getByLabel('API Key', { exact: true }).count(), 0);
  await box.getByRole('button', { name: '保存 Provider', exact: true }).click();
  await box.getByRole('button', { name: 'Second local service 1', exact: true }).waitFor();
  await box.getByRole('button', { name: 'My local provider 1', exact: true }).click();
  assert.equal(await box.getByLabel('Provider ID', { exact: true }).inputValue(), 'local-check');
  assert.equal(await box.getByLabel('接口协议').inputValue(), 'responses');
  await box.getByRole('button', { name: 'Second local service 1', exact: true }).click();
  assert(
    await box.getByRole('checkbox', { name: '此服务不需要 API Key', exact: true }).isChecked(),
  );
  check(
    'Another custom service can be added directly after saving, with independent editing and keyless settings',
  );
  await page.getByRole('button', { name: '新会话', exact: false }).click();
  await page.getByRole('button', { name: '执行模型', exact: true }).click();
  await page.getByRole('combobox', { name: '搜索模型', exact: true }).fill('OpenCode Go');
  assert.equal(await page.locator('.model-picker-section').count(), 2);
  assert.equal(
    await page
      .locator('.model-picker-group-label small')
      .allTextContents()
      .then((names) => names.sort().join('|')),
    'Go Backup|Go Work',
  );
  await page
    .locator('.model-picker-panel')
    .screenshot({ path: resolve(output, 'go-account-groups.png') });
  await page.getByRole('combobox', { name: '搜索模型', exact: true }).fill('Go Backup');
  assert.equal(await page.locator('[data-model-id]').count(), 1);
  assert(
    (await page.locator('[data-model-id]').getAttribute('title')).startsWith(
      goAccounts[1].id + '/',
    ),
  );
  await page
    .getByRole('combobox', { name: '搜索模型', exact: true })
    .fill('local-check/third-model');
  await page.locator('[data-model-id][title="local-check/third-model"]').click();
  assert(
    (
      await page.getByRole('button', { name: '执行模型', exact: true }).getAttribute('title')
    ).includes('local-check/third-model'),
  );
  await page.getByRole('button', { name: '设备与模型', exact: true }).click();
  check(
    'A new conversation can freely select the newly added custom model without submitting a task',
  );
  await box.getByRole('button', { name: 'My local provider 1', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await box.getByLabel('API 地址', { exact: true }).scrollIntoViewIfNeeded();
  await page.waitForFunction(
    () => document.querySelector('.conversation-sidebar').getBoundingClientRect().right <= 0,
  );
  const fieldBox = await box.getByLabel('API 地址', { exact: true }).boundingBox();
  assert(fieldBox && fieldBox.x >= 0 && fieldBox.x + fieldBox.width <= 390);
  await page.screenshot({ path: resolve(output, 'custom-mobile.png') });
  await overflow();
  check('Custom provider form fits a 390 pixel viewport');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('.language-control select').selectOption('en');
  await box.getByRole('heading', { name: 'Edit custom provider' }).waitFor();
  await page.screenshot({ path: resolve(output, 'custom-english.png') });
  assert(!/[\u3400-\u9fff]/.test(await box.locator('.provider-form').innerText()));
  check('English labels switch live without losing entered provider settings');
  await box.getByRole('button', { name: 'Remove connection', exact: true }).click();
  await box.getByRole('button', { name: 'Confirm removal', exact: true }).click();
  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll('.provider-chip')).some((el) =>
        el.textContent.includes('My local provider'),
      ),
  );

  check('Removal is confirmed and clears the provider from the available list');
  await box.getByRole('tab', { name: /Account sign-in/ }).click();
  assert(await box.getByRole('button', { name: 'Sign in to OpenAI' }).isVisible());
  await page.screenshot({ path: resolve(output, 'account-entry-english.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await box.getByRole('tab', { name: /Account sign-in/ }).scrollIntoViewIfNeeded();
  for (const tab of await box.getByRole('tab').all()) {
    const bounds = await tab.boundingBox();
    assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390);
  }
  await page.screenshot({ path: resolve(output, 'account-entry-mobile.png') });
  await overflow();
  check(
    'Account entry and all three connection methods remain visible in English and a narrow viewport',
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('**/api/model-settings/providers', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Synthetic catalog failure' }),
    }),
  );
  await page.reload();
  await page.getByRole('button', { name: 'Devices & models', exact: true }).click();
  await box.getByText('Synthetic catalog failure').waitFor();
  await page.unroute('**/api/model-settings/providers');
  await box.getByRole('button', { name: 'Reload providers' }).click();
  await box.getByRole('button', { name: 'Sign in to OpenAI' }).waitFor();
  check('Catalog errors show a working retry action');
  let releaseCatalog;
  const heldCatalog = new Promise((resolve) => {
    releaseCatalog = resolve;
  });
  await page.route('**/api/model-settings/providers', async (route) => {
    await heldCatalog;
    await route.continue();
  });
  await page.reload();
  await page.getByRole('button', { name: 'Devices & models', exact: true }).click();
  try {
    await box.getByText('Loading providers…').waitFor();
    assert.equal(await box.getByRole('button', { name: /^Sign in to / }).count(), 0);
  } finally {
    releaseCatalog();
  }
  await box.getByRole('button', { name: 'Sign in to OpenAI' }).waitFor();
  await page.unroute('**/api/model-settings/providers');
  check('A pending catalog shows loading without stale sign-in actions, then becomes usable');
  preview.data.engine.ready = false;
  await page.reload();
  await page.getByRole('button', { name: 'Devices & models', exact: true }).click();
  await box.getByText('Available providers will load when the engine is ready.').waitFor();
  await box.getByRole('tab', { name: /Custom service/ }).click();
  assert(await box.getByLabel('Provider ID', { exact: true }).isDisabled());
  assert(await box.getByRole('button', { name: 'Save provider', exact: true }).isDisabled());
  preview.data.engine.ready = true;
  preview.data.user.owner = false;
  await page.reload();
  await page.getByRole('button', { name: 'Devices & models', exact: true }).click();
  await box.getByRole('button', { name: 'Sign in to OpenAI' }).waitFor();
  assert(await box.getByRole('button', { name: 'Sign in to OpenAI' }).isDisabled());
  assert(await box.getByLabel('Vendor OAuth sign-in').isDisabled());
  await box.getByRole('tab', { name: /API Key/ }).click();
  assert(await box.getByLabel('API Key', { exact: true }).isDisabled());
  await box.getByRole('tab', { name: /Custom service/ }).click();
  assert(await box.getByLabel('Provider ID', { exact: true }).isDisabled());
  check('An unavailable engine and a read-only member cannot modify connections through any entry');
  preview.data.user.owner = true;
  await page.route('**/api/model-settings', async (route) => {
    const response = await route.fetch();
    const settings = await response.json();
    await route.fulfill({
      response,
      json: { ...settings, busy: true, busyReason: 'Synthetic task is running' },
    });
  });
  await page.reload();
  await page.getByRole('button', { name: 'Devices & models', exact: true }).click();
  await box.getByRole('button', { name: 'Sign in to OpenAI' }).waitFor();
  assert(await box.getByRole('button', { name: 'Sign in to OpenAI' }).isDisabled());
  await box.getByRole('tab', { name: /API Key/ }).click();
  assert(await box.getByLabel('API Key', { exact: true }).isDisabled());
  await box.getByRole('tab', { name: /Custom service/ }).click();
  assert(await box.getByRole('button', { name: 'Save provider', exact: true }).isDisabled());
  await page.unroute('**/api/model-settings');
  check('Running tasks keep credential changes locked across all connection methods');
  preview.providers.splice(0, preview.providers.length, {
    id: 'deepseek',
    name: 'DeepSeek',
    connected: false,
    apiKey: true,
    modelCount: 2,
    oauth: [],
  });
  await page.reload();
  await page.getByRole('button', { name: 'Devices & models', exact: true }).click();
  await box
    .getByText('This engine has no account sign-in options. Use an API key or a custom service.')
    .waitFor();
  await box.getByRole('tab', { name: /API Key/ }).click();
  await box.getByLabel('API Key', { exact: true }).waitFor();
  check('A directory without OAuth has an explicit empty state and a usable API key alternative');
  assert.equal(
    preview.modelRequests.filter((r) => r.path === '/api/model-settings/test').length,
    0,
  );
  assert.deepEqual(report.errors, []);
  check('UI actions do not automatically execute a connection test; no browser runtime errors');
} finally {
  report.requests = preview.modelRequests;
  await writeFile(resolve(output, 'ui-report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  await preview.close();
}
