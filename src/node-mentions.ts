import { t } from '../shared/i18n.ts';
import type { RivloomNode } from '../shared/types';

export type ActiveNodeMention = { start: number; end: number; query: string; mode?: 'preferred' | 'locked' };

export function nodeDisplayName(node: Pick<RivloomNode, 'name' | 'remark'>) {
  return node.remark ? `${node.name}（${node.remark}）` : node.name;
}

export function activeNodeMention(
  text: string,
  cursor: number,
  nodes: Pick<RivloomNode, 'name' | 'remark'>[] = [],
): ActiveNodeMention | null {
  const prefix = text.slice(0, cursor);
  if ((prefix.match(/```/g)?.length || 0) % 2 || (prefix.split('\n').at(-1)?.match(/`/g)?.length || 0) % 2) return null;
  const match = prefix.match(/(?:^|\s)(@@?)([^@\r\n]*)$/u);
  if (!match) return null;
  // Spaces can be part of a real Node name, but an ordinary sentence after a mention is not a query.
  if (/\s/u.test(match[2])) {
    const query = match[2].toLocaleLowerCase('zh-CN');
    if (!nodes.some((node) => nodeDisplayName(node).toLocaleLowerCase('zh-CN').includes(query)))
      return null;
  }
  const start = prefix.length - match[2].length - match[1].length;
  return { start, end: cursor, query: match[2], ...(match[1] === '@@' ? { mode: 'locked' as const } : {}) };
}
export const nodeMentionPrefix = (mode: 'preferred' | 'locked') => mode === 'locked' ? '@@' : '@';
export function boundNodeMentionMode(text: string, name: string): 'preferred' | 'locked' | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const match of text.matchAll(new RegExp(`(^|\\s)(@@?)${escaped}(?=\\s|$)`, 'gu'))) {
    const prefix = text.slice(0, match.index + match[1].length);
    if ((prefix.match(/```/g)?.length || 0) % 2 || (prefix.split('\n').at(-1)?.match(/`/g)?.length || 0) % 2) continue;
    return match[2] === '@@' ? 'locked' : 'preferred';
  }
  return null;
}
export function replaceBoundNodeMention(text: string, name: string, mode: 'preferred' | 'locked' | null) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(^|\\s)@@?${escaped}(?=\\s|$)`, 'u'), (_whole, before: string) =>
    mode ? `${before}${nodeMentionPrefix(mode)}${name}` : before);
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
    ? t('状态更新中')
    : !node.online
      ? t('离线')
      : !node.channelReady
        ? t('正在连接')
        : (queueFresh && node.nodeQueue!.paused) || (loadFresh && !node.worker!.accepting)
          ? t('执行已暂停')
          : slots === null
            ? t('在线 · 负载未知')
            : slots > 0
              ? t('空闲')
              : t('忙碌 · 可排队');
  const cpu = node.worker?.hardware.logicalCores
    ? t('CPU {{value1}} 线程', { value1: node.worker.hardware.logicalCores })
    : t('CPU 未提供');
  const gpus = node.worker?.hardware.gpus || [];
  const gpu = gpus.length ? t('GPU {{value1}} 张', { value1: gpus.length }) : t('GPU 未提供');
  const sampleAge = loadFresh
    ? Math.max(0, Math.floor((now - Date.parse(node.worker!.load.sampledAt)) / 1000))
    : null;
  const health = queueFresh
    ? {
        normal: '',
        unknown: t('健康信息未知'),
        congested: t('队列拥堵提醒'),
        resource_anomaly: t('持续资源异常提醒'),
        stalled: t('等待队列可能停滞'),
      }[node.nodeQueue!.health]
    : '';
  const summary = t('{{value1}} · 空闲槽 {{value2}} · 等待 {{value3}} · {{value4}} · {{value5}}', {
    value1: status,
    value2: slots ?? t('未知'),
    value3: waiting ?? t('未知'),
    value4: cpu,
    value5: gpu,
  });
  const hardware = node.worker?.hardware;
  const gpuDetails = gpus.length
    ? gpus
        .map(
          (item) =>
            `${item.name}${item.memoryBytes === null ? t('（显存未知）') : `（${Math.round(item.memoryBytes / 1024 ** 3)} GB）`}`,
        )
        .join('、')
    : t('未提供 GPU 信息');
  const detail = [
    `Node ID：${node.id}`,
    summary,
    hardware
      ? t('{{value1}} · 内存 {{value2}} GB', {
          value1: hardware.cpuModel,
          value2: Math.round(hardware.memoryBytes / 1024 ** 3),
        })
      : t('未提供硬件报告'),
    gpuDetails,
    loadFresh
      ? t('CPU 使用率 {{value1}} · GPU 使用率 {{value2}}', {
          value1:
            node.worker!.load.cpuPercent === null ? t('未知') : `${node.worker!.load.cpuPercent}%`,
          value2:
            node.worker!.load.gpuPercent === null ? t('未知') : `${node.worker!.load.gpuPercent}%`,
        })
      : t('负载报告缺失或已过期'),
    sampleAge === null ? t('等待最新报告') : t('{{value1}} 秒前更新', { value1: sampleAge }),
    !node.nodeQueue ? t('对端未提供队列信息') : !queueFresh ? t('队列信息等待更新') : health,
  ]
    .filter(Boolean)
    .join('\n');
  return { status, summary, detail, loadFresh, queueFresh, slots, waiting, health };
}
