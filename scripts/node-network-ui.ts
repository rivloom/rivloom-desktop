// Verifies the node network page inside an already-running Tauri WebView2 instance.
// A second isolated NodeNetwork supplies a real signed mDNS advertisement.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { NodeNetwork } from '../server/node-network.ts';

const dataDirectory = resolve(process.env.RIVLOOM_DESKTOP_UI_DATA || '.data/desktop-node-ui');
const cdpPort = Number(process.env.RIVLOOM_DESKTOP_UI_CDP || 9341);
const playwrightDirectory = process.env.RIVLOOM_PLAYWRIGHT_DIRECTORY;
if (!playwrightDirectory)
  throw new Error('RIVLOOM_PLAYWRIGHT_DIRECTORY is required for this internal harness');
const { chromium } = createRequire(import.meta.url)(playwrightDirectory) as {
  chromium: { connectOverCDP(endpoint: string): Promise<any> };
};
const runtime = JSON.parse(readFileSync(join(dataDirectory, 'desktop-runtime.json'), 'utf8'));
const peerRoot = mkdtempSync(join(tmpdir(), 'rivloom-desktop-peer-'));
const peer = new NodeNetwork(peerRoot, true);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
try {
  await peer.start();
  assert.equal(peer.snapshot().status, 'online');
  const context = browser.contexts()[0];
  const page = context.pages().find((candidate: any) => candidate.url().startsWith(runtime.url));
  assert(page, 'Rivloom WebView2 page not found');
  page.setDefaultTimeout(20_000);
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: /任务工作台/ }).waitFor();
  await page.getByRole('button', { name: /节点与 Brain/ }).click();
  await page.getByRole('heading', { name: '节点与 Brain.' }).waitFor();
  await page.getByText('本机身份已由 Windows DPAPI 保护').waitFor();

  const deadline = Date.now() + 20_000;
  while (
    Date.now() < deadline &&
    (await page.getByText('签名身份已验证，尚未配对授权').count()) < 1
  )
    await wait(500);
  await expectText(page.locator('.discovery-status'), '正在自动发现');
  assert((await page.getByText('签名身份已验证，尚未配对授权').count()) >= 1);
  assert((await page.locator('.network-node-card.local').count()) === 1);
  assert((await page.locator('.network-node-card:not(.local)').count()) >= 1);

  const verificationDirectory = resolve('.data', 'verification');
  mkdirSync(verificationDirectory, { recursive: true });
  const screenshot = join(verificationDirectory, 'desktop-node-network.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  const proof = join(verificationDirectory, 'desktop-node-network.json');
  writeFileSync(
    proof,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        status: 'passed',
        desktopPID: runtime.desktopPID,
        backendPID: runtime.backendPID,
        url: runtime.url,
        localNode: peer.snapshot().nearby[0]?.id || null,
        syntheticPeer: peer.snapshot().local?.id || null,
        assertions: [
          'Actual Tauri WebView2 rendered the Node and Brain page',
          'Packaged backend loaded a stable Windows-DPAPI-protected node identity',
          'A second isolated Rivloom instance was discovered through real mDNS',
          'The nearby node passed nonce and Ed25519 signature verification',
          'The verified nearby node remained explicitly untrusted and unable to access business APIs',
        ],
        limits: [
          'Both instances ran on one Windows machine; a second physical device remains required.',
          'Pairing, revocation, encrypted business transport, and task delegation are not part of M3.1.',
        ],
        screenshot,
      },
      null,
      2,
    ),
  );
  console.log('PASS actual Tauri WebView2 node network UI:', proof);
  process.exitCode = 0;
} finally {
  await peer.stop();
  rmSync(peerRoot, { recursive: true, force: true });
  // Do not close the browser connection: it belongs to the native application.
}

// Playwright keeps its CDP transport referenced even though the WebView2 belongs to Rivloom.
// Cleanup is complete here, so terminate only this verification harness.
process.exit(0);

async function expectText(locator: any, value: string) {
  assert((await locator.innerText()).includes(value));
}
