// Verifies the node network page inside an already-running Tauri WebView2 instance.
// A second isolated NodeNetwork supplies a real signed LAN discovery advertisement.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
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
const projectRoot = join(peerRoot, 'prepared-project');
mkdirSync(projectRoot, { recursive: true });
writeFileSync(join(projectRoot, 'README.md'), '# Rivloom remote preparation fixture\n');
execFileSync('git', ['init', '--quiet'], { cwd: projectRoot, windowsHide: true });
execFileSync(
  'git',
  [
    '-c',
    'user.name=Rivloom Verification',
    '-c',
    'user.email=verification@rivloom.local',
    'add',
    'README.md',
  ],
  { cwd: projectRoot, windowsHide: true },
);
execFileSync(
  'git',
  [
    '-c',
    'user.name=Rivloom Verification',
    '-c',
    'user.email=verification@rivloom.local',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ],
  { cwd: projectRoot, windowsHide: true },
);
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
  const projectResult = await page.evaluate(async (directory: string) => {
    const response = await fetch('/api/projects', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Rivloom-Request': '1' },
      body: JSON.stringify({
        name: '远端准备验证项目',
        directory,
        trusted: true,
      }),
    });
    return { status: response.status, body: await response.json() };
  }, projectRoot);
  assert.equal(projectResult.status, 201, JSON.stringify(projectResult.body));
  const modelDeadline = Date.now() + 20_000;
  let availableModels = 0;
  while (Date.now() < modelDeadline && availableModels === 0) {
    availableModels = await page.evaluate(async () => {
      const response = await fetch('/api/bootstrap', { credentials: 'same-origin' });
      const value = await response.json();
      return Array.isArray(value.engine?.models) ? value.engine.models.length : 0;
    });
    if (!availableModels) await wait(500);
  }
  assert(availableModels > 0, 'Packaged engine did not expose an available local model');
  await page.reload({ waitUntil: 'domcontentloaded' });
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

  const incomingTitle = '准备本机执行资源';
  await peer.createRemoteTask(desktopNodeID, peerViewOfDesktop()!.brains[0].id, {
    title: incomingTitle,
    description: '由目标设备人工选择本机可信项目和模型，不向发起方发送路径或凭据。',
    criteria: '发起方只收到有期限的准备状态。',
  });
  const incomingCard = page
    .locator('.remote-task-card.incoming')
    .filter({ has: page.getByRole('heading', { name: incomingTitle }) });
  await incomingCard.getByRole('button', { name: '接受任务邀请' }).click();
  let incomingDeadline = Date.now() + 5000;
  const peerTask = () => peer.snapshot().remoteTasks.find((task) => task.title === incomingTitle);
  while (
    Date.now() < incomingDeadline &&
    (peerTask()?.status !== 'accepted' || peerTask()?.deliveryPending)
  )
    await wait(100);
  assert.equal(peerTask()?.status, 'accepted');
  await incomingCard.getByRole('button', { name: '选择本机项目与模型' }).click();
  await incomingCard.getByLabel('可信本机项目').selectOption({ label: '远端准备验证项目' });
  await incomingCard.getByLabel('本机执行模型').selectOption({ index: 0 });
  await incomingCard.locator('.remote-preparation-confirmation input').check();
  await incomingCard.getByRole('button', { name: '确认本机执行准备' }).click();
  incomingDeadline = Date.now() + 5000;
  while (
    Date.now() < incomingDeadline &&
    (peerTask()?.executionStatus !== 'ready' || peerTask()?.deliveryPending)
  )
    await wait(100);
  assert.equal(peerTask()?.executionStatus, 'ready');
  assert.equal(peerTask()?.localProjectID, null);
  assert.equal(peerTask()?.localModel, null);
  await incomingCard.getByText(/已在本机保留 远端准备验证项目/).waitFor();
  const localLeaseCheck = await page.evaluate(async (projectID: string) => {
    const request = async (path: string, body: unknown) => {
      const response = await fetch(`/api${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Rivloom-Request': '1' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const bootstrap = await (await fetch('/api/bootstrap', { credentials: 'same-origin' })).json();
    const created = await request('/tasks', {
      projectID,
      title: '验证远端项目保留',
      description: '这个本机任务只用于确认项目保留会阻止普通任务启动。',
      criteria: '启动请求在调用模型前被拒绝。',
      assigneeID: bootstrap.user.id,
      approverID: bootstrap.user.id,
      reviewerID: bootstrap.user.id,
      model: bootstrap.engine.models[0].id,
    });
    const claimed = await request(`/tasks/${created.body.id}/claim`, {});
    const run = await request(`/tasks/${created.body.id}/run`, { confirmed: true });
    return { created: created.status, claimed: claimed.status, run };
  }, String(projectResult.body.id));
  assert.equal(localLeaseCheck.created, 201);
  assert.equal(localLeaseCheck.claimed, 200);
  assert.equal(localLeaseCheck.run.status, 409);
  assert(String(localLeaseCheck.run.body.error).includes('跨设备任务'));
  page.once('dialog', (dialog: any) => dialog.accept());
  await incomingCard.getByRole('button', { name: '撤销执行准备' }).click();
  incomingDeadline = Date.now() + 5000;
  while (
    Date.now() < incomingDeadline &&
    (peerTask()?.executionStatus !== 'revoked' || peerTask()?.deliveryPending)
  )
    await wait(100);
  assert.equal(peerTask()?.executionStatus, 'revoked');

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
          'The target selected a trusted project and available model only on its own device',
          'The owner received a bounded execution-ready lease without project or model identifiers',
          'The local lease blocked an ordinary task before any model or OpenCode session could start',
          'The target revoked execution preparation and released the local project reservation',
          'Revocation removed trust on both nodes',
          'Pairing did not expose any project, task, model, or OpenCode business endpoint',
        ],
        limits: [
          'Both instances ran on one Windows machine; a second physical device remains required.',
          'The task slice prepares local resources but does not yet create an OpenCode session, execute AI, transmit approvals, or return artifacts.',
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
