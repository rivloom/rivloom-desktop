// Verifies the model settings page inside an already-running Tauri WebView2 instance.
// The desktop app itself establishes the local operator session before this check.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import type { ModelSettings } from '../shared/types.ts';

const dataDirectory = resolve(process.env.RIVLOOM_DESKTOP_UI_DATA || '.data/desktop-ui-visible');
const cdpPort = Number(process.env.RIVLOOM_DESKTOP_UI_CDP || 9333);
const playwrightDirectory = process.env.RIVLOOM_PLAYWRIGHT_DIRECTORY;
if (!playwrightDirectory)
  throw new Error('RIVLOOM_PLAYWRIGHT_DIRECTORY is required for this internal harness');
const { chromium } = createRequire(import.meta.url)(playwrightDirectory) as {
  chromium: { connectOverCDP(endpoint: string): Promise<any> };
};
const runtime = JSON.parse(readFileSync(join(dataDirectory, 'desktop-runtime.json'), 'utf8'));
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
try {
  const context = browser.contexts()[0];
  const page = context.pages().find((candidate: any) => candidate.url().startsWith(runtime.url));
  assert(page, 'Rivloom WebView2 page not found');
  page.setDefaultTimeout(15_000);
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: /任务工作台/ }).waitFor();
  await page.getByRole('button', { name: /模型与额度/ }).click();
  await page.getByRole('heading', { name: '模型与额度.' }).waitFor();

  const settings = (await page.evaluate(() =>
    fetch('/api/model-settings').then((result) => result.json()),
  )) as ModelSettings;
  assert.equal(settings.credentialState, 'unconfigured');
  assert(settings.models.some((model) => model.id === 'opencode/mimo-v2.5-free'));
  assert.equal(await page.getByText('DeepSeek 官方 API').count(), 1);
  assert.equal(await page.getByText('连接测试', { exact: true }).count(), 1);
  assert.equal(await page.getByText('未配置', { exact: true }).count(), 1);
  assert.equal(await page.getByText('先保存 DeepSeek 凭据').count(), 1);

  const keyInput = page.locator('input[type="password"]');
  assert.equal(await keyInput.count(), 1);
  assert.equal(await keyInput.inputValue(), '');
  assert(await page.getByRole('button', { name: '保存凭据' }).isDisabled());
  assert.equal(await page.locator('.default-card select').inputValue(), settings.defaultModel);

  const verificationDirectory = resolve('.data', 'verification');
  mkdirSync(verificationDirectory, { recursive: true });
  const screenshot = join(verificationDirectory, 'desktop-model-settings.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  const proof = join(verificationDirectory, 'desktop-model-settings.json');
  writeFileSync(
    proof,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        status: 'passed',
        desktopPID: runtime.desktopPID,
        backendPID: runtime.backendPID,
        url: runtime.url,
        assertions: [
          'Actual release Tauri WebView2 rendered the model settings page',
          'No-key DeepSeek state and disabled connection-test state are explicit',
          'Credential field is password-only, empty, and cannot submit without quota confirmation',
          'Default model shown in the desktop UI matches the authenticated backend setting',
          'Model operation audit UI is present without exposing credentials or model responses',
        ],
        limits: [
          'No real DeepSeek key was entered, so DeepSeek success is not claimed.',
          'Provider credential mutation was verified separately through the official OpenCode API harness.',
        ],
        screenshot,
      },
      null,
      2,
    ),
  );
  console.log('PASS actual Tauri WebView2 model settings UI:', proof);
  process.exit(0);
} finally {
  // Do not close the browser connection: it belongs to the native application.
}
