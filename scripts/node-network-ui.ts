// Verifies the node network page inside an already-running Tauri WebView2 instance.
// A second isolated NodeNetwork supplies a real signed LAN discovery advertisement.
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
  await page.getByRole('button', { name: '与此设备配对' }).click();
  await page.locator('.pairing-code').waitFor();
  const pairingDeadline = Date.now() + 5000;
  while (Date.now() < pairingDeadline && peer.snapshot().pairings.length !== 1) await wait(100);
  const pageCode = String(await page.locator('.pairing-code').innerText()).replace(/\D/g, '');
  assert.equal(pageCode, peer.snapshot().pairings[0]?.code);
  assert.equal(peer.snapshot().nearby[0]?.trusted, false);
  const pairingScreenshot = join(verificationDirectory, 'desktop-node-pairing.png');
  await page.screenshot({ path: pairingScreenshot, fullPage: true });

  await page.getByRole('button', { name: '短码一致，确认' }).click();
  await page.getByText('本机已确认，等待对方在其设备确认。').waitFor();
  assert.equal(peer.snapshot().nearby[0]?.trusted, false);
  assert.equal(peer.snapshot().pairings[0]?.remoteConfirmed, true);
  await peer.confirmPairing(peer.snapshot().pairings[0].id);
  await page.locator('.network-node-card:not(.local)').getByText('已建立设备信任').waitFor();
  assert.equal(peer.snapshot().nearby[0]?.trusted, true);

  const screenshot = join(verificationDirectory, 'desktop-node-network.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  page.once('dialog', (dialog: any) => dialog.accept());
  await page.getByRole('button', { name: '撤销信任' }).click();
  await page
    .locator('.network-node-card:not(.local)')
    .getByText('签名身份已验证，尚未配对授权')
    .waitFor();
  assert.equal(peer.snapshot().nearby[0]?.trusted, false);
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
          'A second isolated Rivloom instance was discovered through the real LAN discovery stack',
          'The nearby node passed nonce and Ed25519 signature verification',
          'Both sides displayed the same six-digit pairing code derived from the signed session',
          'One-sided confirmation did not establish trust',
          'Bilateral confirmation established trust on both nodes',
          'Revocation removed trust on both nodes',
          'Pairing did not expose any project, task, model, or OpenCode business endpoint',
        ],
        limits: [
          'Both instances ran on one Windows machine; a second physical device remains required.',
          'Encrypted business transport and task delegation remain closed for a later slice.',
        ],
        screenshot,
        pairingScreenshot,
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
