// Synthetic, loopback-only production UI benchmark. No installed app, data or model.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, extname, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((v, i, all) => (v.startsWith('--') ? [v.slice(2), all[i + 1]] : []))
    .filter((v) => v.length),
);
assert(args.dist && args.output, 'Pass --dist and --output');
const moduleDirectory = process.env.RIVLOOM_PLAYWRIGHT_DIRECTORY;
assert(moduleDirectory, 'Pass the installed Playwright directory via RIVLOOM_PLAYWRIGHT_DIRECTORY');
const { chromium } = createRequire(import.meta.url)(moduleDirectory);
const dist = resolve(args.dist),
  output = resolve(args.output);
await mkdir(output, { recursive: true });
const when = '2026-09-07T14:00:00.000Z';
const user = { id: 'perf-owner', name: '性能验证', username: 'perf-fixture', owner: true };
const nodeDefaults = {
  protocolVersion: 1,
  addresses: [],
  port: 1,
  fingerprint: 'synthetic-only',
  brains: [],
  capabilities: [],
  worker: null,
  verified: true,
  lastSeen: when,
};
const peer = {
  ...nodeDefaults,
  id: 'perf-peer',
  name: 'Synthetic peer',
  icon: 'laptop',
  trusted: true,
  local: false,
  online: true,
  channelReady: true,
};
const tasks = Array.from({ length: Number(args.tasks || 300) }, (_, index) => {
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  return {
    id,
    number: index + 1,
    title: index === 0 ? 'Perf selected conversation' : `Perf history ${index}`,
    description: `合成需求 ${index}：仅用于性能验证。`,
    criteria: '',
    projectID: 'perf-project',
    creatorID: user.id,
    assigneeID: user.id,
    approverID: user.id,
    reviewerID: user.id,
    acceptedBy: index ? user.id : null,
    state: index ? 'accepted' : 'review',
    version: 1,
    createdAt: when,
    updatedAt: when,
    model: 'fixture/model',
    approvalMode: 'ask',
    sessionID: `synthetic-${index}`,
    runAfter: 0,
    messages: Array.from({ length: index ? 10 : 120 }, (_, message) => ({
      id: `${id}-${message}`,
      role: message ? 'assistant' : 'user',
      text: `合成消息 ${message}。${' Keep the existing content and scroll position. 中文性能验证。'.repeat(5)}`,
      tools: [],
    })),
    approvals: [],
    questions: [],
    artifacts: [],
    diffSource: '',
    error: null,
  };
});
const data = {
  user,
  users: [user],
  tasks,
  projects: [
    {
      id: 'perf-project',
      name: 'Synthetic project',
      directory: 'C:/synthetic/performance',
      createdAt: when,
    },
  ],
  engine: {
    ready: true,
    version: '1.18.25',
    models: [{ id: 'fixture/model', name: 'Fixture model' }],
    error: null,
  },
  defaultModel: 'fixture/model',
  executionPolicy: {
    enabled: false,
    projectID: null,
    model: null,
    approvalMode: 'ask',
    maxConcurrent: 1,
    updatedAt: when,
  },
  network: {
    status: 'online',
    serviceType: 'synthetic-only',
    local: {
      ...nodeDefaults,
      id: 'perf-local',
      name: 'Performance fixture',
      icon: 'monitor',
      local: true,
      trusted: true,
      online: true,
      channelReady: true,
    },
    nearby: [peer],
    paired: [peer],
    pairings: [],
    remoteTasks: [],
    brainTasks: [],
    brains: [],
    error: null,
  },
};
const queue = { version: 1, paused: false, updatedAt: when, entries: [] };
const attention = {
  items: [],
  notifications: [],
  preferences: { enabled: false, quietUntil: null },
};
const feeds = new Set(),
  requests = [],
  errors = [];
let scenario = 'setup';
const json = (res, value, status = 200) => {
  const body = JSON.stringify(value);
  requests.at(-1).bytes = Buffer.byteLength(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
};
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  requests.push({ scenario, path, bytes: 0 });
  if (path === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: connected\ndata: {}\n\n');
    feeds.add(res);
    req.on('close', () => feeds.delete(res));
    return;
  }
  if (path === '/api/bootstrap') return json(res, data);
  if (path === '/api/network') return json(res, data.network);
  if (path === '/api/node-queue') return json(res, queue);
  if (path === '/api/attention/check')
    return json(res, { checkedAt: new Date().toISOString(), ...attention });
  if (path.startsWith('/api/tasks/'))
    return json(res, { task: tasks.find((t) => t.id === path.split('/').at(-1)), activities: [] });
  if (path.startsWith('/api/task-files/'))
    return json(res, {
      inputs: [],
      results: [],
      canSave: false,
      canPublish: false,
      canRetry: false,
    });
  if (path.startsWith('/api/')) return json(res, { error: 'Unexpected synthetic endpoint' }, 404);
  const file = resolve(dist, '.' + (path === '/' ? '/index.html' : path));
  if (!file.startsWith(dist + sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type':
        {
          '.html': 'text/html',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.png': 'image/png',
          '.svg': 'image/svg+xml',
        }[extname(file)] || 'application/octet-stream',
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${server.address().port}`;
const event = (name = 'network') => {
  for (const feed of feeds) feed.write(`event: ${name}\ndata: {}\n\n`);
};
let browser, page;
try {
  browser = await chromium.launch({ channel: args.channel || 'msedge', headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 840 },
    locale: 'zh-CN',
    reducedMotion: 'reduce',
  });
  await context.route('**/*', (route) =>
    route
      .request()
      .url()
      .startsWith(origin + '/')
      ? route.continue()
      : route.abort(),
  );
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    window.__perf = { scrollReads: 0, scrollWrites: 0, commits: 0, inputPaint: [], longTasks: [] };
    const metrics = window.__perf;
    for (const name of ['scrollHeight', 'scrollTop']) {
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, name);
      if (!descriptor?.configurable) continue;
      Object.defineProperty(Element.prototype, name, {
        ...descriptor,
        get() {
          if (this.id === 'conversation-transcript') metrics.scrollReads++;
          return descriptor.get.call(this);
        },
        ...(descriptor.set
          ? {
              set(value) {
                if (this.id === 'conversation-transcript') metrics.scrollWrites++;
                descriptor.set.call(this, value);
              },
            }
          : {}),
      });
    }
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      inject: () => 1,
      onCommitFiberRoot: () => metrics.commits++,
      onCommitFiberUnmount() {},
    };
    new PerformanceObserver((list) =>
      metrics.longTasks.push(...list.getEntries().map((e) => e.duration)),
    ).observe({ type: 'longtask', buffered: true });
    document.addEventListener(
      'input',
      () => {
        const start = performance.now();
        requestAnimationFrame(() => metrics.inputPaint.push(performance.now() - start));
      },
      true,
    );
  });
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.locator('.conversation-item[title="Perf selected conversation"]').click();
  await page.locator('#conversation-transcript .chat-message').first().waitFor();
  await delay(750);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () =>
    Object.fromEntries(
      (await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]),
    );
  const report = {
    label: args.label || 'run',
    synthetic: true,
    nativeWindowDragMeasured: false,
    realModelRequests: 0,
    tasks: tasks.length,
    selectedMessages: tasks[0].messages.length,
    browserVersion: browser.version(),
    viewport: { width: 1280, height: 840 },
    scenarios: {},
    checks: {},
  };
  async function measure(name, action) {
    if (args['checks-only'] && ['idle', 'network', 'resize'].includes(name)) return;
    scenario = name;
    await page.evaluate(() => {
      Object.assign(window.__perf, {
        scrollReads: 0,
        scrollWrites: 0,
        commits: 0,
        inputPaint: [],
        longTasks: [],
      });
    });
    const start = await metrics();
    await action();
    const end = await metrics(),
      observed = await page.evaluate(() => window.__perf);
    const selected = requests.filter((r) => r.scenario === name && r.path.startsWith('/api/'));
    const percentile = (values, fraction) =>
      values.length
        ? [...values].sort((a, b) => a - b)[
            Math.min(values.length - 1, Math.floor(values.length * fraction))
          ]
        : 0;
    report.scenarios[name] = {
      ...Object.fromEntries(
        [
          'TaskDuration',
          'ScriptDuration',
          'LayoutDuration',
          'RecalcStyleDuration',
          'LayoutCount',
          'RecalcStyleCount',
        ].map((key) => [key, end[key] - start[key]]),
      ),
      apiRequests: selected.length,
      apiBytes: selected.reduce((sum, r) => sum + r.bytes, 0),
      paths: Object.fromEntries(
        [...new Set(selected.map((r) => r.path))].map((path) => [
          path,
          selected.filter((r) => r.path === path).length,
        ]),
      ),
      scrollReads: observed.scrollReads,
      scrollWrites: observed.scrollWrites,
      reactCommits: observed.commits,
      longTasks: observed.longTasks.length,
      maxLongTaskMs: Math.max(0, ...observed.longTasks),
      inputPaintP95Ms: percentile(observed.inputPaint, 0.95),
    };
  }
  function networkUpdates() {
    let sequence = 0;
    return setInterval(() => {
      peer.lastSeen = new Date(Date.parse(when) + ++sequence * 200).toISOString();
      event();
    }, 200);
  }
  await measure('idle', () => delay(6000));
  let ticks = networkUpdates();
  try {
    await measure('network', () => delay(8000));
  } finally {
    clearInterval(ticks);
  }
  ticks = networkUpdates();
  const draft =
    '性能验证：输入保持完整，不因节点刷新丢字。Typing stays responsive during network updates.';
  try {
    await measure('typing', async () => {
      await page.locator('textarea[aria-label="会话消息"]').pressSequentially(draft, { delay: 15 });
      await delay(1000);
    });
  } finally {
    clearInterval(ticks);
  }
  assert.equal(await page.locator('textarea[aria-label="会话消息"]').inputValue(), draft);
  report.checks.draftPreserved = true;
  await page.locator('#conversation-transcript').evaluate((el) => {
    el.scrollTop = 1000;
  });
  await delay(100);
  const beforeScroll = await page
    .locator('#conversation-transcript')
    .evaluate((el) => el.scrollTop);
  tasks[0].messages.push({
    id: 'appended',
    role: 'assistant',
    text: 'New synthetic message while reading older history.',
    tools: [],
  });
  tasks[0].version++;
  event('update');
  await page
    .getByText('New synthetic message while reading older history.', { exact: true })
    .waitFor();
  await delay(100);
  const afterScroll = await page.locator('#conversation-transcript').evaluate((el) => el.scrollTop);
  assert(
    Math.abs(beforeScroll - afterScroll) < 2,
    `Reading position moved: ${beforeScroll} -> ${afterScroll}`,
  );
  report.checks.readingPositionPreserved = true;
  await page.getByRole('button', { name: '回到最新消息' }).click();
  await delay(100);
  tasks[0].messages.push({
    id: 'followed',
    role: 'assistant',
    text: 'Follow latest synthetic message.',
    tools: [],
  });
  tasks[0].version++;
  event('update');
  await page.getByText('Follow latest synthetic message.', { exact: true }).waitFor();
  await delay(100);
  assert(
    await page
      .locator('#conversation-transcript')
      .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 3),
  );
  report.checks.newMessagesFollowed = true;
  ticks = networkUpdates();
  try {
    await measure('resize', async () => {
      for (let i = 0; i < 20; i++) {
        await page.setViewportSize({ width: i % 2 ? 1280 : 1080, height: 840 });
        await delay(60);
      }
    });
  } finally {
    clearInterval(ticks);
  }

  // Correctness checks follow the measured scenarios so they cannot alter the comparison.
  scenario = 'regression';
  tasks[0].messages.at(-1).text = 'Stream update without a task version change.';
  tasks[0].approvals = [
    {
      id: 'perf-approval',
      permission: 'Synthetic permission update',
      patterns: ['fixture-only.txt'],
      metadata: {},
    },
  ];
  event('network');
  event('delta');
  event('network');
  await page.getByText('Stream update without a task version change.', { exact: true }).waitFor();
  await page.getByText('Synthetic permission update', { exact: true }).waitFor();
  report.checks.streamAndApprovalWithoutVersionChange = true;
  tasks[0].approvals = [];
  event('update');
  await page
    .getByText('Synthetic permission update', { exact: true })
    .waitFor({ state: 'detached' });
  report.checks.removedApprovalDisappeared = true;

  await page.getByLabel('界面语言', { exact: true }).selectOption('en');
  await page.getByRole('button', { name: 'Copy this message', exact: true }).first().waitFor();
  assert((await page.locator('.conversation-item').first().innerText()).includes('Started by you'));
  await page.getByLabel('Interface language', { exact: true }).selectOption('zh-CN');
  await page.getByRole('button', { name: '复制这条消息', exact: true }).first().waitFor();
  assert((await page.locator('.conversation-item').first().innerText()).includes('自己发起'));
  report.checks.memoizedContentChangesLanguage = true;

  await page.locator('.conversation-item[title="Perf history 1"]').click();
  await page.waitForFunction(
    () => document.querySelectorAll('#conversation-transcript .chat-message').length === 10,
  );
  await page.locator('.conversation-item[title="Perf selected conversation"]').click();
  await page.getByText('Stream update without a task version change.', { exact: true }).waitFor();
  assert.equal(await page.locator('textarea[aria-label="会话消息"]').inputValue(), draft);
  report.checks.switchConversationPreservesDraft = true;

  tasks[1].remoteOrigin = {
    ownerNodeID: peer.id,
    remoteTaskID: 'synthetic-origin',
    ownerBrainID: null,
  };
  event('update');
  await page
    .locator('.conversation-item[title="Perf history 1"]')
    .getByText('Synthetic peer')
    .waitFor();
  peer.name = 'Renamed synthetic peer';
  event('network');
  await page
    .locator('.conversation-item[title="Perf history 1"]')
    .getByText('Renamed synthetic peer')
    .waitFor();
  report.checks.networkRenameUpdatesHistory = true;

  attention.items = [
    {
      key: 'perf-attention',
      conversationKey: `local:${tasks[0].id}`,
      kind: 'review',
      title: 'Synthetic attention route',
      detail: 'Fixture only',
      updatedAt: when,
      fingerprint: 'one',
    },
  ];
  await page.locator('.conversation-settings').getByRole('button', { name: /^待办/ }).click();
  attention.preferences.quietUntil = Date.now() + 1500;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByRole('button', { name: '结束免打扰', exact: true }).waitFor();
  await page.getByRole('button', { name: '免打扰 1 小时', exact: true }).waitFor({ timeout: 6500 });
  report.checks.quietHoursExpireWithoutDataChanges = true;
  await page.locator('.attention-card').getByText('Synthetic attention route').click();
  await page.getByText('Stream update without a task version change.', { exact: true }).waitFor();
  assert.equal(
    await page.locator('.conversation-item[aria-current="page"]').getAttribute('title'),
    tasks[0].title,
  );
  report.checks.attentionOpensOriginalConversation = true;

  data.network.brains = [
    {
      id: 'perf-brain',
      name: 'Synthetic Brain',
      masterNodeID: data.network.local.id,
      state: 'established',
      hosted: true,
      online: true,
      queueDepth: 0,
      workers: [
        {
          nodeID: peer.id,
          accepting: true,
          projects: [],
          hardware: {
            cpuModel: 'Synthetic CPU',
            logicalCores: 4,
            memoryBytes: 8 * 1024 ** 3,
            gpus: [],
          },
          load: {
            sampledAt: new Date(Date.now() - 27_000).toISOString(),
            availableSlots: 1,
            cpuPercent: 0,
            memoryUsedPercent: 25,
            diskAvailableBytes: 1024 ** 3,
          },
        },
      ],
    },
  ];
  event('network');
  await page
    .locator('.conversation-settings')
    .getByRole('button', { name: '节点与 Brain', exact: true })
    .click();
  await page.getByText('1 个可用槽位', { exact: true }).waitFor();
  await page.getByText('报告已过期', { exact: true }).waitFor({ timeout: 7000 });
  report.checks.workerReportExpiresWithoutDataChanges = true;
  await page.locator('.conversation-item[title="Perf selected conversation"]').click();
  await page.getByText('Stream update without a task version change.', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, 'workspace.png') });
  report.errors = errors;
  assert.deepEqual(errors, []);
  report.requests = requests;
  await writeFile(resolve(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({ label: report.label, checks: report.checks, scenarios: report.scenarios }),
  );
} catch (cause) {
  await writeFile(
    resolve(output, 'failure.json'),
    JSON.stringify(
      {
        error: String(cause),
        browserErrors: errors,
        body: await page
          ?.locator('body')
          .innerText()
          .catch(() => ''),
      },
      null,
      2,
    ) + '\n',
  );
  await page?.screenshot({ path: resolve(output, 'failure.png') }).catch(() => undefined);
  throw cause;
} finally {
  await browser?.close();
  for (const feed of feeds) feed.end();
  server.closeAllConnections();
  await new Promise((ok) => server.close(ok));
}
