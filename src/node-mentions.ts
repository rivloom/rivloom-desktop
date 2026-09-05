import type { RivloomNode } from '../shared/types';

export type ActiveNodeMention = { start: number; end: number; query: string };

export function nodeDisplayName(node: Pick<RivloomNode, 'name' | 'remark'>) {
  return node.remark ? `${node.name}（${node.remark}）` : node.name;
}

export function activeNodeMention(
  text: string,
  cursor: number,
  nodes: Pick<RivloomNode, 'name' | 'remark'>[] = [],
): ActiveNodeMention | null {
  const prefix = text.slice(0, cursor);
  const match = prefix.match(/(?:^|\s)@([^@\r\n]*)$/u);
  if (!match) return null;
  // Spaces can be part of a real Node name, but an ordinary sentence after a mention is not a query.
  if (/\s/u.test(match[1])) {
    const query = match[1].toLocaleLowerCase('zh-CN');
    if (!nodes.some((node) => nodeDisplayName(node).toLocaleLowerCase('zh-CN').includes(query)))
      return null;
  }
  const start = prefix.length - match[1].length - 1;
  return { start, end: cursor, query: match[1] };
}

export function isNodeMentionComposing(
  event: { isComposing?: boolean; keyCode?: number },
  composing = false,
): boolean {
  return composing || !!event.isComposing || event.keyCode === 229;
}

export function recentNodeMentions(nodes: RivloomNode[], query = '') {
  const normalized = query.trim().toLocaleLowerCase('zh-CN');
  return nodes
    .filter(
      (node) =>
        node.trusted &&
        !node.local &&
        (!normalized || nodeDisplayName(node).toLocaleLowerCase('zh-CN').includes(normalized)),
    )
    .sort((left, right) => {
      const leftRecent = left.lastUsedAt ? Date.parse(left.lastUsedAt) : 0;
      const rightRecent = right.lastUsedAt ? Date.parse(right.lastUsedAt) : 0;
      return (
        rightRecent - leftRecent ||
        Number(right.online && right.channelReady) - Number(left.online && left.channelReady) ||
        Date.parse(right.lastSeen) - Date.parse(left.lastSeen) ||
        nodeDisplayName(left).localeCompare(nodeDisplayName(right), 'zh-CN')
      );
    });
}

export function nodeCapabilitySummary(node: RivloomNode, now = Date.now(), connected = true) {
  const fresh = (at: string | undefined) => {
    const sampled = at ? Date.parse(at) : NaN;
    return Number.isFinite(sampled) && sampled <= now + 1000 && now - sampled < 30_000;
  };
  const reachable = connected && node.online && node.channelReady;
  const loadFresh = reachable && fresh(node.worker?.load.sampledAt);
  const queueFresh = reachable && fresh(node.nodeQueue?.sampledAt);
  const slots = loadFresh ? node.worker!.load.availableSlots : null;
  const waiting = queueFresh ? node.nodeQueue!.waitingCount : null;
  const status = !connected
    ? '状态更新中'
    : !node.online
      ? '离线'
      : !node.channelReady
        ? '正在连接'
        : (queueFresh && node.nodeQueue!.paused) || (loadFresh && !node.worker!.accepting)
          ? '执行已暂停'
          : slots === null
            ? '在线 · 负载未知'
            : slots > 0
              ? '空闲'
              : '忙碌 · 可排队';
  const cpu = node.worker?.hardware.logicalCores
    ? `CPU ${node.worker.hardware.logicalCores} 线程`
    : 'CPU 未提供';
  const gpus = node.worker?.hardware.gpus || [];
  const gpu = gpus.length ? `GPU ${gpus.length} 张` : 'GPU 未提供';
  const sampleAge = loadFresh
    ? Math.max(0, Math.floor((now - Date.parse(node.worker!.load.sampledAt)) / 1000))
    : null;
  const health = queueFresh
    ? {
        normal: '',
        unknown: '健康信息未知',
        congested: '队列拥堵提醒',
        resource_anomaly: '持续资源异常提醒',
        stalled: '等待队列可能停滞',
      }[node.nodeQueue!.health]
    : '';
  const summary = `${status} · 空闲槽 ${slots ?? '未知'} · 等待 ${waiting ?? '未知'} · ${cpu} · ${gpu}`;
  const hardware = node.worker?.hardware;
  const gpuDetails = gpus.length
    ? gpus
        .map(
          (item) =>
            `${item.name}${item.memoryBytes === null ? '（显存未知）' : `（${Math.round(item.memoryBytes / 1024 ** 3)} GB）`}`,
        )
        .join('、')
    : '未提供 GPU 信息';
  const detail = [
    `Node ID：${node.id}`,
    summary,
    hardware
      ? `${hardware.cpuModel} · 内存 ${Math.round(hardware.memoryBytes / 1024 ** 3)} GB`
      : '未提供硬件报告',
    gpuDetails,
    loadFresh
      ? `CPU 使用率 ${node.worker!.load.cpuPercent === null ? '未知' : `${node.worker!.load.cpuPercent}%`} · GPU 使用率 ${node.worker!.load.gpuPercent === null ? '未知' : `${node.worker!.load.gpuPercent}%`}`
      : '负载报告缺失或已过期',
    sampleAge === null ? '等待最新报告' : `${sampleAge} 秒前更新`,
    !node.nodeQueue ? '对端未提供队列信息' : !queueFresh ? '队列信息等待更新' : health,
  ]
    .filter(Boolean)
    .join('\n');
  return { status, summary, detail, loadFresh, queueFresh, slots, waiting, health };
}
