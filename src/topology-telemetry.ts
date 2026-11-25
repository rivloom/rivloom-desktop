import { t } from '../shared/i18n.ts';
import type { NodeActivitySnapshot } from '../shared/node-activity.ts';
import type { NodeQueueSnapshot } from '../shared/node-queue.ts';
import type { RivloomNode } from '../shared/types.ts';
import { machineBytes, machineStatus } from './machine-status.ts';
import {
  activityRateText,
  modelActivityState,
  visibleModelRates,
  type ModelActivityState,
} from './sidebar-activity.ts';

export type NodeHealthTone = 'healthy' | 'active' | 'warning' | 'danger' | 'paused' | 'offline' | 'unknown';

export type TopologyNodeTelemetry = {
  id: string;
  isLocal: boolean;
  online: boolean;
  paused: boolean;
  loadFresh: boolean;
  queueFresh: boolean;
  healthCode: 'normal' | 'congested' | 'resource_anomaly' | 'stalled' | 'unknown';
  healthLabel: string;
  tone: NodeHealthTone;
  statusLabel: string;
  cpuPercent: number | null;
  cpuText: string;
  logicalCores: number | null;
  coresText: string;
  memoryPercent: number | null;
  memoryText: string;
  memoryTotalText: string;
  runningCount: number | null;
  availableSlots: number | null;
  slotsText: string;
  waitingCount: number | null;
  waitingText: string;
  /** Strictly local-only real token rates from NodeActivitySnapshot. Always null for remote peers. */
  localActivity: {
    state: ModelActivityState;
    inputRate: number | null;
    outputRate: number | null;
    inputText: string;
    outputText: string;
    activeRuns: number | null;
  } | null;
  /** Ultra-compact truthful single line inside SVG node; never fabricates 0% or fake rates. */
  svgMetricText: string;
  /** 0..100 fill bar for SVG node bottom edge, or null to hide when telemetry is missing/stale. */
  svgLoadPercent: number | null;
  sampleAgeSeconds: number | null;
};

/**
 * Compute strictly truthful telemetry for a topology node.
 * Missing, stale, or unavailable metrics MUST stay null / '—' — never fabricated as 0%.
 */
export function buildTopologyNodeTelemetry({
  node,
  isLocal,
  now = Date.now(),
  connected,
  activitySnapshot = null,
  activityLoading = false,
  queueSnapshot = null,
}: {
  node: RivloomNode | null;
  isLocal: boolean;
  now?: number;
  connected: boolean;
  activitySnapshot?: NodeActivitySnapshot | null;
  activityLoading?: boolean;
  queueSnapshot?: NodeQueueSnapshot | null;
}): TopologyNodeTelemetry {
  const id = node?.id || 'local';
  const online = isLocal ? connected : Boolean(node && node.online && node.channelReady && connected);

  // Local node online status follows SSE/API connection; normalize so machineStatus applies identical freshness checks.
  const effectiveNode = node
    ? isLocal
      ? { ...node, online: connected, channelReady: connected }
      : node
    : null;
  const view = effectiveNode ? machineStatus(effectiveNode, now, connected) : null;
  const hardware = effectiveNode?.worker?.hardware || null;
  const loadFresh = Boolean(view?.loadFresh);
  const queueFresh = Boolean(view?.queueFresh);
  const paused = Boolean(
    (isLocal && queueSnapshot ? queueSnapshot.paused : false) || view?.paused,
  );

  const cpuPercent = view ? view.cpu : null;
  const memoryPercent = view ? view.memory : null;
  const logicalCores =
    hardware && Number.isFinite(hardware.logicalCores) && hardware.logicalCores > 0
      ? hardware.logicalCores
      : null;
  const memoryTotalText =
    hardware && Number.isFinite(hardware.memoryBytes) && hardware.memoryBytes > 0
      ? machineBytes(hardware.memoryBytes)
      : '—';

  const cpuText = cpuPercent !== null ? `${Math.round(cpuPercent)}%` : '—';
  const coresText = logicalCores !== null ? t('{{count}} 核', { count: logicalCores }) : '—';
  const memoryText = memoryPercent !== null ? `${Math.round(memoryPercent)}%` : '—';

  const runningCount =
    view?.executing !== null && view?.executing !== undefined
      ? view.executing
      : loadFresh && effectiveNode?.worker
        ? effectiveNode.worker.load.runningTasks
        : null;
  const availableSlots =
    loadFresh && effectiveNode?.worker?.accepting ? effectiveNode.worker.load.availableSlots : null;

  let slotsText = '—';
  if (paused) {
    slotsText = runningCount !== null
      ? t('运行 {{running}} · 已暂停', { running: runningCount })
      : t('已暂停');
  } else if (view?.concurrency) {
    slotsText = t('运行 {{running}} · 远端 {{used}}/{{limit}}', {
      running: runningCount ?? 0,
      used: view.concurrency.remoteOccupied,
      limit: view.concurrency.remoteLimit,
    });
  } else if (runningCount !== null && availableSlots !== null) {
    slotsText = t('运行 {{running}} · 空闲 {{free}}', {
      running: runningCount,
      free: availableSlots,
    });
  } else if (view?.occupied !== null && view?.occupied !== undefined && view.total !== null) {
    slotsText = `${view.occupied} / ${view.total}`;
  } else if (runningCount !== null) {
    slotsText = t('运行 {{running}}', { running: runningCount });
  }

  const waitingCount = isLocal && queueSnapshot
    ? queueSnapshot.entries.filter((entry) => entry.state === 'waiting' || entry.state === 'held').length
    : view?.waiting ?? null;
  const waitingText = waitingCount !== null ? String(waitingCount) : '—';

  const healthCode: TopologyNodeTelemetry['healthCode'] =
    queueFresh && effectiveNode?.nodeQueue ? effectiveNode.nodeQueue.health : 'unknown';

  const healthLabel = !online
    ? t('离线')
    : paused
      ? t('已暂停')
      : healthCode === 'congested'
        ? t('队列拥堵')
        : healthCode === 'resource_anomaly'
          ? t('资源异常')
          : healthCode === 'stalled'
            ? t('队列停滞')
            : healthCode === 'normal'
              ? t('健康')
              : loadFresh
                ? t('在线')
                : '—';

  let localActivity: TopologyNodeTelemetry['localActivity'] = null;
  if (isLocal) {
    const models = activitySnapshot?.models || null;
    const rates = visibleModelRates(models);
    const state = modelActivityState(models, activityLoading);
    const activeRuns = models && !models.limited && models.countsComplete ? models.counts.active : null;
    localActivity = {
      state,
      inputRate: rates.inputTokensPerSecond,
      outputRate: rates.outputTokensPerSecond,
      inputText: rates.inputTokensPerSecond !== null ? `${activityRateText(rates.inputTokensPerSecond)} t/s` : '—',
      outputText: rates.outputTokensPerSecond !== null ? `≈${activityRateText(rates.outputTokensPerSecond)} t/s` : '—',
      activeRuns,
    };
  }

  const tone: NodeHealthTone = !online
    ? 'offline'
    : healthCode === 'resource_anomaly'
      ? 'danger'
      : healthCode === 'congested' || healthCode === 'stalled'
        ? 'warning'
        : paused
          ? 'paused'
          : (runningCount !== null && runningCount > 0) ||
              (localActivity && (localActivity.state === 'active' || (localActivity.outputRate ?? 0) > 0))
            ? 'active'
            : loadFresh || healthCode === 'normal'
              ? 'healthy'
              : 'unknown';

  const statusLabel = !online
    ? t('离线')
    : paused
      ? t('执行已暂停')
      : view?.label || t('在线');

  // Compact SVG metric line: strictly truthful, prefers live token rate on local if actively generating,
  // otherwise fresh CPU % + slots, otherwise '—' or offline.
  let svgMetricText = !online ? t('离线') : '—';
  if (online) {
    if (isLocal && localActivity && localActivity.outputRate !== null && localActivity.outputRate > 0) {
      svgMetricText =
        cpuPercent !== null
          ? `${Math.round(cpuPercent)}% · ≈${activityRateText(localActivity.outputRate)}t/s`
          : `≈${activityRateText(localActivity.outputRate)} t/s`;
    } else if (paused) {
      svgMetricText = cpuPercent !== null ? `${Math.round(cpuPercent)}% · ${t('已暂停')}` : t('已暂停');
    } else if (cpuPercent !== null && availableSlots !== null && runningCount !== null) {
      svgMetricText = `CPU ${Math.round(cpuPercent)}% · ${runningCount}/${runningCount + availableSlots}`;
    } else if (cpuPercent !== null) {
      svgMetricText = `CPU ${Math.round(cpuPercent)}%`;
    } else if (runningCount !== null && availableSlots !== null) {
      svgMetricText = `${runningCount}/${runningCount + availableSlots}`;
    } else if (isLocal && localActivity && localActivity.outputRate !== null) {
      svgMetricText = `≈${activityRateText(localActivity.outputRate)} t/s`;
    }
  }

  const svgLoadPercent = online
    ? cpuPercent !== null
      ? cpuPercent
      : view?.hardware ?? null
    : null;

  const sampleAgeSeconds =
    loadFresh && effectiveNode?.worker?.load.sampledAt
      ? Math.max(0, Math.floor((now - Date.parse(effectiveNode.worker.load.sampledAt)) / 1000))
      : null;

  return {
    id,
    isLocal,
    online,
    paused,
    loadFresh,
    queueFresh,
    healthCode,
    healthLabel,
    tone,
    statusLabel,
    cpuPercent,
    cpuText,
    logicalCores,
    coresText,
    memoryPercent,
    memoryText,
    memoryTotalText,
    runningCount,
    availableSlots,
    slotsText,
    waitingCount,
    waitingText,
    localActivity,
    svgMetricText,
    svgLoadPercent,
    sampleAgeSeconds,
  };
}
