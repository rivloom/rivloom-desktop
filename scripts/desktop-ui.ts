// Test harness for an already-running, explicitly isolated desktop instance.
// The native app must establish its local operator and open the task UI without onboarding.
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const dataDirectory = resolve(process.env.RIVLOOM_DESKTOP_UI_DATA || '.data/desktop-ui-visible');
const cdpPort = Number(process.env.RIVLOOM_DESKTOP_UI_CDP || 9339);
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
  const initialInputs = await page
    .locator('input')
    .evaluateAll((inputs: Element[]) =>
      inputs.map((input: Element) => (input as HTMLInputElement).name),
    );
  assert(
    !initialInputs.some((name: string) => ['code', 'name', 'username', 'password'].includes(name)),
    'Desktop startup must not ask for workspace or account fields',
  );
  await page.getByRole('button', { name: /任务工作台/ }).waitFor();
  assert.equal(await page.getByText('自动发现已启动').count(), 1);
  mkdirSync(resolve('.data', 'verification'), { recursive: true });
  const directScreenshot = resolve('.data', 'verification', 'desktop-direct-start.png');
  await page.screenshot({ path: directScreenshot, fullPage: true });
  await page.getByRole('button', { name: '添加本地项目' }).first().click();
  await page.getByRole('button', { name: '浏览本机文件夹' }).waitFor();
  await page.screenshot({
    path: resolve('.data', 'verification', 'desktop-workbench.png'),
    fullPage: true,
  });
  writeFileSync(
    resolve('.data', 'verification', 'desktop-ui.json'),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        status: 'passed',
        desktopPID: runtime.desktopPID,
        backendPID: runtime.backendPID,
        url: runtime.url,
        directScreenshot,
        assertions: [
          'Actual WebView2 page loaded in the Tauri process',
          'First launch showed no workspace, display-name, username, password, or setup-code form',
          'Native launch token established the local operator and opened the task workbench directly',
          'LAN node discovery was already active in the ordinary workbench',
          'Desktop-only native directory action is visible',
        ],
      },
      null,
      2,
    ),
  );
  console.log('PASS actual Tauri WebView2 direct-to-workbench startup and native directory action');
  process.exit(0);
} finally {
  // CDP is attached to the app-owned WebView2 process. Do not call
  // browser.close(): that would try to close the user's native application.
}
