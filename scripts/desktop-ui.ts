// Test harness for an already-running, explicitly isolated desktop instance.
// It seeds a synthetic account through HTTP instead of automating an auth dialog.
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
  const initialInputs = await page
    .locator('input')
    .evaluateAll((inputs: Element[]) =>
      inputs.map((input: Element) => (input as HTMLInputElement).name),
    );
  assert(
    !initialInputs.includes('code'),
    'Desktop setup must not ask the user to read a terminal code',
  );
  const setup = await fetch(`${runtime.url}/api/auth/state`).then((response) => response.json());
  const response = await fetch(
    `${runtime.url}/api/auth/${setup.setupRequired ? 'setup' : 'login'}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Rivloom-Request': '1' },
      body: JSON.stringify({
        username: 'desktop_test',
        name: '桌面验收测试',
        password: 'Rivloom-desktop-synthetic-test-2026',
        ...(setup.setupRequired
          ? { code: readFileSync(join(dataDirectory, 'setup-code.txt'), 'utf8').trim() }
          : {}),
      }),
    },
  );
  assert.equal(response.status, 200, await response.text());
  const cookiePair = response.headers.get('set-cookie')!.split(';')[0];
  const separator = cookiePair.indexOf('=');
  await context.addCookies([
    {
      name: cookiePair.slice(0, separator),
      value: cookiePair.slice(separator + 1),
      url: runtime.url,
    },
  ]);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 });
  await page.getByText('协作工作区').waitFor();
  assert.equal(await page.getByText('WINDOWS DESKTOP').count(), 1);
  await page.getByRole('button', { name: '添加本地项目' }).first().click();
  await page.getByRole('button', { name: '浏览本机文件夹' }).waitFor();
  mkdirSync(resolve('.data', 'verification'), { recursive: true });
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
        assertions: [
          'Actual WebView2 page loaded in the Tauri process',
          'Native setup bridge removed the terminal-only setup-code field',
          'Synthetic authenticated owner reached the desktop workspace',
          'Desktop-only native directory action is visible',
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS actual Tauri WebView2, native setup bridge, desktop workspace and native directory action',
  );
  process.exit(0);
} finally {
  // CDP is attached to the app-owned WebView2 process. Do not call
  // browser.close(): that would try to close the user's native application.
}
