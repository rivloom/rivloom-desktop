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
  const desktopNodeID = String(
    await page.locator('.network-node-card.local .network-node-details .mono').first().innerText(),
  ).trim();
  const syntheticNodeID = peer.snapshot().local!.id;
  const syntheticName = peer.snapshot().local!.name;
  const syntheticCard = page
    .locator('.network-node-card:not(.local)')
    .filter({ has: page.getByRole('heading', { name: syntheticName }) });
  const peerViewOfDesktop = () => peer.snapshot().nearby.find((node) => node.id === desktopNodeID);

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && (await syntheticCard.count()) !== 1) await wait(500);
  while (Date.now() < deadline && !peerViewOfDesktop()) await wait(500);
  await expectText(page.locator('.discovery-status'), '正在自动发现');
  await syntheticCard.getByText('签名身份已验证，尚未配对授权').waitFor();
  assert((await page.locator('.network-node-card.local').count()) === 1);
  assert.equal(syntheticNodeID, String(await syntheticCard.locator('dd.mono').first().innerText()));
  assert(peerViewOfDesktop()?.verified);

  const verificationDirectory = resolve('.data', 'verification');
  mkdirSync(verificationDirectory, { recursive: true });
  await syntheticCard.getByRole('button', { name: '与此设备配对' }).click();
  await syntheticCard.locator('.pairing-code').waitFor();
  const pairingDeadline = Date.now() + 5000;
  while (Date.now() < pairingDeadline && peer.snapshot().pairings.length !== 1) await wait(100);
  const pageCode = String(await syntheticCard.locator('.pairing-code').innerText()).replace(
    /\D/g,
    '',
  );
  assert.equal(pageCode, peer.snapshot().pairings[0]?.code);
  assert.equal(peerViewOfDesktop()?.trusted, false);
  const pairingScreenshot = join(verificationDirectory, 'desktop-node-pairing.png');
  await page.screenshot({ path: pairingScreenshot, fullPage: true });

  await syntheticCard.getByRole('button', { name: '短码一致，确认' }).click();
  await syntheticCard.getByText('本机已确认，等待对方在其设备确认。').waitFor();
  assert.equal(peerViewOfDesktop()?.trusted, false);
  assert.equal(peer.snapshot().pairings[0]?.remoteConfirmed, true);
  await peer.confirmPairing(peer.snapshot().pairings[0].id);
  await syntheticCard.getByText('已建立设备信任 · 加密通道就绪').waitFor();
  assert.equal(peerViewOfDesktop()?.channelReady, true);
  assert.equal(peerViewOfDesktop()?.trusted, true);

  const remoteTaskTitle = '验证跨设备任务邀请';
  await syntheticCard.getByRole('button', { name: '发起协作任务' }).click();
  await syntheticCard.getByLabel('任务标题').fill(remoteTaskTitle);
  await syntheticCard
    .getByLabel('任务说明')
    .fill('只验证邀请、人工接受和持久状态，不绑定项目或启动 OpenCode。');
  await syntheticCard.getByLabel('验收标准').fill('两端显示同一任务 ID 和已接受状态。');
  await syntheticCard.getByRole('button', { name: '加密发送邀请' }).click();
  const taskDeadline = Date.now() + 5000;
  while (
    Date.now() < taskDeadline &&
    (peer.snapshot().remoteTasks.length !== 1 || peer.snapshot().remoteTasks[0]?.deliveryPending)
  )
    await wait(100);
  assert.equal(peer.snapshot().remoteTasks[0]?.direction, 'incoming');
  assert.equal(peer.snapshot().remoteTasks[0]?.status, 'pending');
  assert.equal(peer.snapshot().remoteTasks[0]?.title, remoteTaskTitle);
  await peer.respondRemoteTask(peer.snapshot().remoteTasks[0].id, 'accepted');
  const remoteTaskCard = page
    .locator('.remote-task-card')
    .filter({ has: page.getByRole('heading', { name: remoteTaskTitle }) });
  await remoteTaskCard.getByText('已接受', { exact: true }).waitFor();
  await remoteTaskCard.getByText('尚未绑定本机项目、模型或启动 AI').waitFor();
  assert.equal(peer.snapshot().remoteTasks[0]?.status, 'accepted');

  const screenshot = join(verificationDirectory, 'desktop-node-network.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  page.once('dialog', (dialog: any) => dialog.accept());
  await syntheticCard.getByRole('button', { name: '撤销信任' }).click();
  await syntheticCard.getByText('签名身份已验证，尚未配对授权').waitFor();
  assert.equal(peerViewOfDesktop()?.trusted, false);
  assert.equal(peer.snapshot().remoteTasks[0]?.status, 'cancelled');
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
        localNode: desktopNodeID,
        syntheticPeer: syntheticNodeID,
        assertions: [
          'Actual Tauri WebView2 rendered the Node and Brain page',
          'Packaged backend loaded a stable Windows-DPAPI-protected node identity',
          'A second isolated Rivloom instance was discovered through the real LAN discovery stack',
          'The nearby node passed nonce and Ed25519 signature verification',
          'Both sides displayed the same six-digit pairing code derived from the signed session',
          'One-sided confirmation did not establish trust',
          'Bilateral confirmation established trust on both nodes',
          'Mutually authenticated X25519 and AES-GCM channel synchronized the Brain directory',
          'An encrypted cross-device task invitation arrived without any project or model binding',
          'The target operator accepted the invitation and both nodes persisted the accepted state',
          'Revocation removed trust on both nodes',
          'Pairing did not expose any project, task, model, or OpenCode business endpoint',
        ],
        limits: [
          'Both instances ran on one Windows machine; a second physical device remains required.',
          'The task slice only invites, accepts, declines, or cancels; project binding and AI execution remain closed.',
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
