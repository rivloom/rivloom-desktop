// Isolated UI verification. Never opens installed Rivloom data or uses real model credentials.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { modelFixture, ServiceClient, pairServices, until } from './m34-fixtures.ts';
import { loadNodeIdentity } from '../server/node-identity.ts';
import { conversations, localQueue } from '../src/conversations.ts';

const root = resolve('.data', `ui-conversation-${randomUUID()}`);
mkdirSync(root, { recursive: true });
const socket = createSocket('udp4');
await new Promise<void>((ok) => socket.bind(0, '127.0.0.1', ok));
const port = socket.address().port;
await new Promise<void>((ok) => socket.close(ok));
const nativePreview = process.argv.includes('--desktop');
const nativeProfile = process.argv.includes('--release') ? 'release' : 'debug';
const discovery = { port, mdns: false };
const model = await modelFixture();
model.release();
class PreviewService extends ServiceClient {
  override async authenticate() {
    const state = await this.call<{ setupRequired: boolean }>('/auth/state');
    const credentials = { username: 'ui_preview', password: 'Rivloom-preview-only-2026' };
    if (state.setupRequired)
      await this.call('/auth/setup', {
        ...credentials,
        name: '界面验证',
        code: readFileSync(join(this.root, 'setup-code.txt'), 'utf8').trim(),
      });
    else await this.call('/auth/login', credentials);
  }
}
class NativePreviewService extends ServiceClient {
  override async start() {
    assert(!this.child || this.child.exitCode !== null);
    this.cookie = '';
    this.child = spawn(resolve(`src-tauri/target/${nativeProfile}/Rivloom.exe`), [], {
      windowsHide: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        RIVLOOM_DATA_DIR: this.root,
        RIVLOOM_DISCOVERY_PORT: String(port),
        RIVLOOM_MDNS_NETWORK: 'disabled',
        RIVLOOM_DISCOVERY_FALLBACK: 'enabled',
      },
    });
    const runtime = await until(
      async () => JSON.parse(readFileSync(join(this.root, 'desktop-runtime.json'), 'utf8')),
      (value) => value.desktopPID === this.child!.pid,
      'isolated native runtime',
    );
    this.base = runtime.url;
    await this.authenticate();
    await until(
      () => this.bootstrap(),
      (value) => value.engine.ready,
      'packaged engine ready',
    );
  }
  override async stop() {
    if (!this.child || this.child.exitCode !== null) return;
    // Only the fixture's still-live native child and its owned runtime are terminated.
    // Never address installed processes by image name or reuse a historical PID.
    const exited = new Promise<void>((ok) => this.child!.once('exit', () => ok()));
    execFileSync('taskkill.exe', ['/PID', String(this.child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    await exited;
  }
}
const local: ServiceClient = nativePreview
  ? new NativePreviewService(join(root, 'local'))
  : new PreviewService(join(root, 'local'));
const peer = new PreviewService(join(root, 'peer'));
for (const service of [local, peer]) {
  mkdirSync(service.root, { recursive: true });
  model.configure(service.root);
  loadNodeIdentity(service.root); // Independent established Brain before these test networks meet.
}
const report: Record<string, unknown> = {
  root,
  deterministicModel: true,
  officialEngine: '1.18.25',
  nativePreview,
  nativeProfile: nativePreview ? nativeProfile : null,
  milestone: 'M3.5 Node collaboration P0',
  discoveryPort: port,
  checks: [],
};
const check = (name: string, evidence: unknown) => {
  (report.checks as unknown[]).push({ name, evidence, at: new Date().toISOString() });
  writeFileSync(join(root, 'verification.json'), JSON.stringify(report, null, 2));
};
let projectID = '';
let peerProjectID = '';
async function status() {
  const data = await local.bootstrap();
  const evidence = {
    node: data.network.local?.id,
    name: data.network.local?.name,
    paired: data.network.paired?.map((node) => ({
      id: node.id,
      name: node.name,
      remark: node.remark,
      lastUsedAt: node.lastUsedAt,
      online: node.online,
      channelReady: node.channelReady,
    })),
    tasks: data.tasks.map((task) => ({
      id: task.id,
      state: task.state,
      session: task.sessionID,
      messages: task.messages.map((message) => message.role),
      remote: !!task.remoteOrigin,
    })),
    conversations: conversations(data).map((item) => ({
      key: item.key,
      incoming: item.incoming,
      title: item.title,
    })),
    queue: localQueue(conversations(data), data.network.local?.id).length,
    modelRequests: model.requests,
    authoritativeQueue: await local.call('/node-queue'),
    remoteTasks: data.network.remoteTasks?.map((task) => ({
      id: task.id,
      title: task.title,
      targetNodeID: task.targetNodeID,
      localTaskID: task.localTaskID,
      transmissionState: task.transmissionState,
      queueReceipt: task.queueReceipt,
      executionState: task.executionState,
    })),
  };
  check('status', evidence);
  console.log(JSON.stringify(evidence));
}
try {
  await local.start({ discovery });
  const folder = join(root, 'work');
  mkdirSync(folder);
  const project = await local.call(
    '/projects',
    { name: '界面验证文件夹', directory: folder, trusted: true },
    201,
  );
  projectID = project.id;
  await local.call('/network/profile', { name: '我的工作站', icon: 'monitor' });
  console.log(JSON.stringify({ ready: true, url: local.base, root, pid: local.child?.pid }));
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    try {
      if (line.trim() === 'connect') {
        await peer.start({ discovery });
        const peerFolder = join(root, 'peer-work');
        mkdirSync(peerFolder, { recursive: true });
        const peerProject = await peer.call(
          '/projects',
          { name: '设计节点文件夹', directory: peerFolder, trusted: true },
          201,
        );
        peerProjectID = peerProject.id;
        await peer.call('/network/profile', { name: '设计工作站', icon: 'laptop' });
        await pairServices(local, peer);
        await until(
          () => local.network(),
          (n) =>
            n.paired?.some(
              (p) => p.name === '设计工作站' && p.icon === 'laptop' && p.channelReady,
            ) || false,
          'profile synchronized',
        );
        const leftID = (await local.network()).local!.id;
        const rightID = (await peer.network()).local!.id;
        check('authenticated profile exchange', { leftID, rightID });
        await local.call('/network/execution-policy', {
          enabled: true,
          approvalMode: 'ask',
          projectID,
          model: 'fixture/m34',
          confirmed: true,
        });
        await until(
          () => peer.network(),
          (n) => n.nearby.some((p) => p.id === leftID && p.worker?.accepting),
          'worker ready',
        );
        await peer.call(
          `/network/nodes/${leftID}/tasks`,
          {
            title: '来自设计工作站的会话',
            description: '返回确定性验证文字，不调用工具，不修改文件。',
            criteria: '返回结果等待验收。',
            requirements: {},
            confirmed: true,
          },
          201,
        );
        await until(
          () => local.bootstrap(),
          (b) => b.tasks.some((t) => !!t.remoteOrigin && t.state === 'review'),
          'incoming session review',
        );
        await status();
        console.log('CONNECTED');
      } else if (line.trim() === 'mention') {
        assert(peerProjectID, 'connect the peer before testing @Node');
        const leftID = (await local.network()).local!.id;
        const rightID = (await peer.network()).local!.id;
        await peer.call('/network/execution-policy', {
          enabled: true,
          approvalMode: 'ask',
          projectID: peerProjectID,
          model: 'fixture/m34',
          confirmed: true,
        });
        await until(
          () => local.network(),
          (n) => n.nearby.some((p) => p.id === rightID && p.worker?.accepting),
          'peer worker ready',
        );
        await local.call(`/network/nodes/${rightID}/remark`, { remark: '小林的电脑' });
        const before = await peer.bootstrap();
        await local.call(
          `/network/nodes/${rightID}/tasks`,
          {
            title: '@设计工作站 整理交互说明',
            description: '返回确定性验证文字，不调用工具，不修改文件。',
            criteria: '返回结果等待验收。',
            requirements: {},
            confirmed: true,
          },
          201,
        );
        const peerAfter = await until(
          () => peer.bootstrap(),
          (b) =>
            b.tasks.some(
              (task) =>
                task.remoteOrigin?.ownerNodeID === leftID &&
                !before.tasks.some((existing) => existing.id === task.id) &&
                task.state === 'review',
            ),
          'direct @ node task review',
        );
        const received = peerAfter.tasks.find(
          (task) =>
            task.remoteOrigin?.ownerNodeID === leftID &&
            !before.tasks.some((existing) => existing.id === task.id),
        )!;
        const localNetwork = await local.network();
        const peerNetwork = await peer.network();
        const localView = localNetwork.paired!.find((node) => node.id === rightID)!;
        const remoteView = peerNetwork.paired!.find((node) => node.id === leftID)!;
        assert.equal(localView.remark, '小林的电脑');
        assert.match(localView.lastUsedAt!, /^\d{4}-\d{2}-\d{2}T/);
        assert.equal(remoteView.remark, undefined);
        check('direct @ node task and private local remark', {
          taskID: received.id,
          targetNodeID: rightID,
          localDisplay: `${localView.name}（${localView.remark}）`,
          lastUsedAt: localView.lastUsedAt,
          remoteRemark: remoteView.remark ?? null,
        });
        await status();
        console.log('MENTIONED');
      } else if (line.trim() === 'p0') {
        assert(peerProjectID, 'connect the isolated peer first');
        const localID = (await local.network()).local!.id;
        const peerID = (await peer.network()).local!.id;
        await local.call(`/network/nodes/${peerID}/remark`, { remark: '小林的电脑' });
        await peer.call('/network/execution-policy', {
          enabled: true,
          projectID: peerProjectID,
          model: 'fixture/m34',
          approvalMode: 'ask',
          confirmed: true,
        });
        const boot = await peer.bootstrap();
        const actor = boot.user.id;
        const blocker = await peer.call(
          '/tasks',
          {
            requestID: randomUUID(),
            runRequested: true,
            projectID: peerProjectID,
            title: '设计工作站现有任务',
            description: '只返回简短测试文字，不修改文件。',
            criteria: '等待验收并保留执行槽位',
            assigneeID: actor,
            approverID: actor,
            reviewerID: actor,
            model: 'fixture/m34',
            approvalMode: 'ask',
          },
          201,
        );
        await until(
          () => peer.bootstrap(),
          (b) => b.tasks.some((t) => t.id === blocker.id && t.state === 'review'),
          'peer review occupies slot',
        );
        for (const title of ['等候设计复核', '等候界面核对'])
          await peer.call(
            `/network/nodes/${localID}/tasks`,
            {
              requestID: randomUUID(),
              title,
              description: '只返回简短测试文字，不修改文件。',
              criteria: '等待队列核验',
              confirmed: true,
            },
            201,
          );
        await until(
          () => local.call('/node-queue'),
          (q) => q.entries.filter((e: { state: string }) => e.state === 'waiting').length >= 2,
          'native waiting queue',
        );
        check('P0 native fixture prepared', {
          localID,
          peerID,
          peerBlockerID: blocker.id,
          modelRequests: model.requests,
        });
        await status();
        console.log('P0_READY');
      } else if (line.trim() === 'profile-spacing') {
        assert(peerProjectID, 'connect the isolated peer first');
        const nodeID = (await peer.network()).local!.id;
        const name = '设计 工作站 · 团队 Node A';
        const remark = '小林的电脑 · 交互与交付验证设备';
        await peer.call('/network/profile', { name, icon: 'laptop' });
        await local.call(`/network/nodes/${nodeID}/remark`, { remark });
        await until(
          () => local.network(),
          (n) => n.paired?.some((p) => p.id === nodeID && p.name === name) || false,
          'spaced profile synchronization',
        );
        check('spaced name and long private remark prepared', { nodeID, name, remark });
        console.log('PROFILE_READY');
      } else if (line.trim() === 'accept-peer') {
        const review = (await peer.bootstrap()).tasks.find((t) => t.state === 'review');
        assert(review, 'no peer review task');
        await peer.call(`/tasks/${review.id}/accept`, {
          version: review.version,
          confirmed: true,
          note: '隔离夹具已核对：确定性文字，未调用工具或修改文件。',
        });
        check('peer review accepted in isolated fixture', { taskID: review.id });
        console.log('PEER_ACCEPTED');
      } else if (line.trim() === 'disconnect') {
        await peer.stop();
        await until(
          () => local.network(),
          (n) => !n.nearby.some((p) => p.online && p.trusted),
          'peer offline',
        );
        const paired = (await local.network()).paired!;
        assert(paired.some((p) => p.name === '设计工作站' && !p.online));
        check('offline paired profile retained', true);
        console.log('DISCONNECTED');
      } else if (line.trim() === 'restart') {
        const before = await local.bootstrap();
        await local.stop();
        await local.start({ discovery });
        const after = await local.bootstrap();
        assert.equal(after.network.local!.id, before.network.local!.id);
        assert.equal(after.network.local!.name, before.network.local!.name);
        assert.equal(after.network.local!.icon, before.network.local!.icon);
        assert.deepEqual(
          after.tasks.map((t) => t.id),
          before.tasks.map((t) => t.id),
        );
        check('restart preserves profile identity and conversations', true);
        console.log(JSON.stringify({ restarted: true, url: local.base }));
      } else if (line.trim() === 'status') await status();
      else if (line.trim() === 'stop') break;
    } catch (error) {
      check('failure', String(error));
      console.log(String(error));
    }
  }
} finally {
  await peer.stop();
  await local.stop();
  await model.close();
  check('own processes stopped', true);
  console.log('CLEANUP');
  process.stdin.pause();
}
