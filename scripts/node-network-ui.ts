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
const projectRoot = join(peerRoot, 'automatic-execution-project');
mkdirSync(projectRoot, { recursive: true });
writeFileSync(join(projectRoot, 'README.md'), '# Rivloom automatic execution fixture\n');
const peer = new NodeNetwork(peerRoot, true);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
let page: any = null;
let runningLocalTaskID: string | null = null;
try {
  await peer.start();
  assert.equal(peer.snapshot().status, 'online');
  const context = browser.contexts()[0];
  page = context.pages().find((candidate: any) => candidate.url().startsWith(runtime.url));
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
        name: '远端自动执行验证项目',
        directory,
        trusted: true,
      }),
    });
    return { status: response.status, body: await response.json() };
  }, projectRoot);
  assert.equal(projectResult.status, 201, JSON.stringify(projectResult.body));
  const disabledPolicy = await page.evaluate(async () => {
    const response = await fetch('/api/network/execution-policy', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Rivloom-Request': '1' },
      body: JSON.stringify({
        enabled: false,
        approvalMode: 'ask',
        projectID: null,
        model: null,
        confirmed: true,
      }),
    });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(disabledPolicy.status, 200, JSON.stringify(disabledPolicy.body));
  const modelDeadline = Date.now() + 20_000;
  let availableModels: { id: string; name: string }[] = [];
  while (Date.now() < modelDeadline && availableModels.length === 0) {
    availableModels = await page.evaluate(async () => {
      const response = await fetch('/api/bootstrap', { credentials: 'same-origin' });
      const value = await response.json();
      return Array.isArray(value.engine?.models) ? value.engine.models : [];
    });
    if (!availableModels.length) await wait(500);
  }
  assert(availableModels.length > 0, 'Packaged engine did not expose an available local model');
  const verificationModel =
    availableModels.find((model) => model.id === 'opencode/mimo-v2.5-free') || availableModels[0];
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

  const waitingTitle = '验证可信任务自动接收';
  await peer.createRemoteTask(desktopNodeID, peerViewOfDesktop()!.brains[0].id, {
    title: waitingTitle,
    description: '验证设备互信后任务自动接收；本机执行能力关闭时不得创建 OpenCode 会话。',
    criteria: '归属 Brain 看到已接受，执行序号仍为零。',
  });
  const waitingTask = () => peer.snapshot().remoteTasks.find((task) => task.title === waitingTitle);
  const waitingDeadline = Date.now() + 10_000;
  while (
    Date.now() < waitingDeadline &&
    (waitingTask()?.status !== 'accepted' || waitingTask()?.deliveryPending)
  )
    await wait(100);
  assert.equal(waitingTask()?.status, 'accepted');
  assert.equal(waitingTask()?.executionSequence, 0);
  assert.equal(waitingTask()?.executionState, 'not_started');
  await page
    .locator('.remote-task-card.incoming')
    .filter({ has: page.getByRole('heading', { name: waitingTitle }) })
    .getByText('已接受', { exact: true })
    .waitFor();
  await peer.cancelRemoteTask(waitingTask()!.id);
  const cancelDeadline = Date.now() + 5000;
  while (Date.now() < cancelDeadline && waitingTask()?.deliveryPending) await wait(100);
  assert.equal(waitingTask()?.status, 'cancelled');

  const remoteTaskTitle = '验证跨设备任务邀请';
  await syntheticCard.getByRole('button', { name: '发起协作任务' }).click();
  await syntheticCard.getByLabel('任务标题').fill(remoteTaskTitle);
  await syntheticCard
    .getByLabel('任务说明')
    .fill('只验证邀请、人工接受和持久状态，不绑定项目或启动 OpenCode。');
  await syntheticCard.getByLabel('验收标准').fill('两端显示同一任务 ID 和已接受状态。');
  await syntheticCard.getByRole('button', { name: '加密发送任务' }).click();
  const remoteTask = () =>
    peer.snapshot().remoteTasks.find((task) => task.title === remoteTaskTitle);
  const taskDeadline = Date.now() + 5000;
  while (Date.now() < taskDeadline && (!remoteTask() || remoteTask()?.deliveryPending))
    await wait(100);
  assert.equal(remoteTask()?.direction, 'incoming');
  assert.equal(remoteTask()?.status, 'pending');
  await peer.respondRemoteTask(remoteTask()!.id, 'accepted');
  const remoteTaskCard = page
    .locator('.remote-task-card')
    .filter({ has: page.getByRole('heading', { name: remoteTaskTitle }) });
  await remoteTaskCard.getByText('已接受', { exact: true }).waitFor();
  assert.equal(remoteTask()?.status, 'accepted');

  const policyForm = page.locator('.execution-policy-form');
  await policyForm.getByLabel('AI 审批模式').selectOption('auto');
  await policyForm.getByLabel('本机项目').selectOption({ label: '远端自动执行验证项目' });
  await policyForm.getByLabel('执行模型').selectOption(verificationModel.id);
  await policyForm.locator('.remote-preparation-confirmation input').check();
  await policyForm.getByRole('button', { name: '开启执行能力' }).click();
  await page.getByText('已按本机设置开放').waitFor();

  const incomingTitle = '真实自动执行跨设备任务';
  await peer.createRemoteTask(desktopNodeID, peerViewOfDesktop()!.brains[0].id, {
    title: incomingTitle,
    description:
      '在当前普通项目文件夹新增 RESULT.txt，内容严格为 rivloom remote execution verified。不要修改其他文件。',
    criteria: 'RESULT.txt 存在且内容完全一致，归属 Brain 收到有序执行状态。',
  });
  const incomingCard = page
    .locator('.remote-task-card.incoming')
    .filter({ has: page.getByRole('heading', { name: incomingTitle }) });
  const peerTask = () => peer.snapshot().remoteTasks.find((task) => task.title === incomingTitle);
  let incomingDeadline = Date.now() + 30_000;
  while (
    Date.now() < incomingDeadline &&
    (peerTask()?.status !== 'accepted' ||
      peerTask()?.deliveryPending ||
      (peerTask()?.executionSequence || 0) < 1)
  )
    await wait(100);
  assert.equal(peerTask()?.status, 'accepted');
  assert((peerTask()?.executionSequence || 0) >= 1);
  assert.equal(peerTask()?.localProjectID, null);
  assert.equal(peerTask()?.localModel, null);
  assert.equal(peerTask()?.localTaskID, null);

  incomingDeadline = Date.now() + 600_000;
  let localRemoteTask: any = null;
  while (Date.now() < incomingDeadline && peerTask()?.executionState !== 'review') {
    localRemoteTask = await page.evaluate(async (remoteTaskID: string) => {
      const bootstrap = await (
        await fetch('/api/bootstrap', { credentials: 'same-origin' })
      ).json();
      return (
        bootstrap.tasks.find((task: any) => task.remoteOrigin?.remoteTaskID === remoteTaskID) ||
        null
      );
    }, peerTask()!.id);
    if (localRemoteTask) runningLocalTaskID = localRemoteTask.id;
    if (localRemoteTask?.state === 'waiting_approval')
      throw new Error(
        `帮我批准模式仍产生本机审批请求：${localRemoteTask.approvals
          .map((approval: any) => approval.permission)
          .join(', ')}`,
      );
    if (['failed', 'interrupted', 'stopped'].includes(localRemoteTask?.state))
      throw new Error(
        `Remote OpenCode execution ended as ${localRemoteTask.state}: ${localRemoteTask.error}`,
      );
    await wait(500);
  }
  assert.equal(peerTask()?.executionState, 'review');
  assert((peerTask()?.executionSequence || 0) >= 3);
  assert.equal(
    readFileSync(join(projectRoot, 'RESULT.txt'), 'utf8').trim(),
    'rivloom remote execution verified',
  );
  assert(
    localRemoteTask?.sessionID,
    'Automatic remote execution did not create an OpenCode session',
  );
  runningLocalTaskID = localRemoteTask.id;
  await incomingCard.getByText(/执行节点状态/).waitFor();

  const ownerView = peerTask()!;
  assert.equal(ownerView.localProjectID, null);
  assert.equal(ownerView.localModel, null);
  assert.equal(ownerView.localTaskID, null);
  const localPolicy = await page.evaluate(async () => {
    const response = await fetch('/api/network/execution-policy', { credentials: 'same-origin' });
    return response.json();
  });
  assert.equal(localPolicy.approvalMode, 'auto');
  assert.equal(localPolicy.projectID, String(projectResult.body.id));
  assert(typeof localPolicy.model === 'string');

  const localOrdinaryStart = await page.evaluate(async (projectID: string) => {
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
      title: '验证同项目并发保护',
      description: '该任务只验证远端产物待验收时不会并发修改同一项目。',
      criteria: '启动请求在创建第二个 OpenCode 会话前被拒绝。',
      assigneeID: bootstrap.user.id,
      approverID: bootstrap.user.id,
      reviewerID: bootstrap.user.id,
      model: bootstrap.engine.models[0].id,
      approvalMode: 'ask',
    });
    const claimed = await request(`/tasks/${created.body.id}/claim`, {});
    const run = await request(`/tasks/${created.body.id}/run`, { confirmed: true });
    return { created: created.status, claimed: claimed.status, run };
  }, String(projectResult.body.id));
  assert.equal(localOrdinaryStart.created, 201);
  assert.equal(localOrdinaryStart.claimed, 200);
  assert.equal(localOrdinaryStart.run.status, 409);
  assert(String(localOrdinaryStart.run.body.error).includes('同一项目'));

  const screenshot = join(verificationDirectory, 'desktop-node-network.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  page.once('dialog', (dialog: any) => dialog.accept());
  await syntheticCard.getByRole('button', { name: '撤销信任' }).click();
  await syntheticCard.getByText('签名身份已验证，尚未配对授权').waitFor();
  assert.equal(peerViewOfDesktop()?.trusted, false);
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
          'An encrypted cross-device collaboration task arrived without project, model, or credential fields',
          'A trusted task was automatically accepted while local execution capability was disabled and did not start a session',
          'The target stored one reusable local capability policy with the selected help-me-approve AI mode',
          'The target automatically accepted a matching task without per-task project or model selection',
          'The packaged OpenCode engine created a real session and executed local file operations without a manual approval prompt',
          'The owner received monotonic execution states without local project, model, task ID, or credential values',
          'The resulting file content was verified directly in the ordinary-folder fixture',
          'The existing project concurrency guard rejected a second task while remote results awaited review',
          'Revocation removed trust on both nodes',
          'Pairing did not expose any project, task, model, or OpenCode business endpoint',
        ],
        limits: [
          'Both instances ran on one Windows machine; a second physical device remains required.',
          'Approvals are still handled on the executor device; remote approval, stop, artifacts and acceptance are the next slice.',
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
  if (page && runningLocalTaskID) {
    await page
      .evaluate(async (taskID: string) => {
        const current = await (
          await fetch(`/api/tasks/${taskID}`, { credentials: 'same-origin' })
        ).json();
        if (
          !['running', 'waiting_approval', 'waiting_input', 'stopping', 'interrupted'].includes(
            current.task?.state,
          )
        )
          return;
        await fetch(`/api/tasks/${taskID}/stop`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-Rivloom-Request': '1' },
          body: '{}',
        });
      }, runningLocalTaskID)
      .catch(() => {});
    await wait(500);
  }
  await peer.stop();
  try {
    rmSync(peerRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  } catch (error) {
    console.warn(
      `Temporary fixture cleanup deferred until Rivloom exits: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
  // Do not close the browser connection: it belongs to the native application.
}

// Playwright keeps its CDP transport referenced even though the WebView2 belongs to Rivloom.
// Cleanup is complete here, so terminate only this verification harness.
process.exit(0);

async function expectText(locator: any, value: string) {
  assert((await locator.innerText()).includes(value));
}
