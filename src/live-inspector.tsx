import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  AtSign,
  Check,
  Eye,
  File,
  FileCode2,
  FileDiff,
  Filter,
  FolderOpen,
  GitBranch,
  Layers,
  ListOrdered,
  LoaderCircle,
  Lock,
  Maximize2,
  Network,
  Pause,
  Play,
  Quote,
  RefreshCw,
  Stethoscope,
  X,
} from 'lucide-react';
import { t } from '../shared/i18n.ts';
import type { NodeQueueSnapshot } from '../shared/node-queue.ts';
import type { ProjectChanges, ProjectDiff } from '../shared/project-changes.ts';
import type { TaskFileDescriptor } from '../shared/task-files.ts';
import type { Bootstrap, Project, RivloomNode } from '../shared/types';
import { api } from './api';
import {
  conversationActivitySummary,
  workflowActivityFileRoutes,
  type ActivityTone,
} from './conversation-activity';
import { ConversationJourneyTrail } from './conversation-activity-view';
import { conversationJourney, type ConversationJourney, type JourneyConnection } from './conversation-journey';
import { conversationIsFailed, conversationIsRunning, conversationState, type Conversation } from './conversations';
import { desktop, revealTaskFile } from './desktop';
import { FilePreview } from './file-preview';
import {
  buildDiffQuoteText,
  canInspectChangedFile,
  changeFileStatusBadge,
  collectWorkflowDeliverableRounds,
  defaultDiffAreaForFile,
  parseDiffHunks,
  partitionProjectChanges,
  type ChangeScopeFilter,
} from './inspector-review';
import { primaryShortcut } from './keyboard-platform';
import { legacyFileRevision } from './legacy-conversation-activity';
import { NodeAvatar } from './node-avatar';
import type { NodeActivityState } from './node-activity';
import { nodeDisplayName } from './node-mentions';
import { PairedMachines } from './paired-machines';
import { TaskFileRecovery, TaskFilesPanel } from './task-files';
import { TaskKnowledgeUsageSection } from './task-knowledge-usage';
import { buildTopologyNodeTelemetry, type TopologyNodeTelemetry } from './topology-telemetry';
import { useTaskFileRequests, useTaskFileStates, type TaskFileQuery } from './use-task-file-state';
import { workflowAllSteps } from '../shared/workflows';
import { workflowLatestExecutions } from './workflow-recent';

export type LiveInspectorTab = 'topology' | 'artifacts' | 'cluster';

type TopologyEdge = {
  key: string;
  peerID: string;
  d: string;
  state: 'active' | 'complete' | 'failed' | 'waiting' | 'target' | 'idle';
  pulse: boolean;
  dashed?: boolean;
};

function shortLabel(text: string, max = 11) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function bezierPath(x1: number, y1: number, x2: number, y2: number, bow = 0) {
  const mx = (x1 + x2) / 2;
  const cy1 = y1 + bow;
  const cy2 = y2 + bow;
  return `M ${x1} ${y1} C ${mx} ${cy1}, ${mx} ${cy2}, ${x2} ${y2}`;
}

function TopologyNodeControlCard({
  node,
  telemetry,
  nodeLabel,
  hasConversation,
  owner,
  disabled,
  targetNodeID,
  targetMode,
  filterNodeID,
  queueSnapshot,
  queueBusy,
  queueError,
  onClose,
  onRouteNode,
  onFilterNode,
  onInspectCluster,
  onPauseQueue,
  onOpenDiagnostics,
}: {
  node: RivloomNode | null;
  telemetry: TopologyNodeTelemetry;
  nodeLabel: string;
  hasConversation: boolean;
  owner: boolean;
  disabled: boolean;
  targetNodeID: string | null;
  targetMode: 'preferred' | 'locked';
  filterNodeID: string | null;
  queueSnapshot: NodeQueueSnapshot | null;
  queueBusy: boolean;
  queueError: string;
  onClose: () => void;
  onRouteNode: (node: RivloomNode | null, forcedMode?: 'preferred' | 'locked' | null) => void;
  onFilterNode: (nodeID: string) => void;
  onInspectCluster: () => void;
  onPauseQueue: (paused: boolean) => void;
  onOpenDiagnostics: (nodeID: string) => void;
}) {
  const isTargeted = !hasConversation && targetNodeID === telemetry.id;
  const isFiltered = hasConversation && filterNodeID === telemetry.id;
  const canRoute = !hasConversation && owner && !disabled && !!node;
  const canPauseLocal = telemetry.isLocal && owner && !!queueSnapshot && !queueError && !queueBusy;

  return (
    <section
      className="topology-control-card"
      data-selected-node={telemetry.id}
      aria-label={t('节点控制面：{{node}}', { node: nodeLabel })}
    >
      <header className="topology-control-head">
        <div className="topology-control-identity">
          <NodeAvatar small icon={node?.icon} name={node?.name || nodeLabel} />
          <div className="topology-control-title">
            <strong title={nodeLabel}>{nodeLabel}</strong>
            <span className={`topology-health-pill is-${telemetry.tone}`}>
              <i aria-hidden="true" />
              {telemetry.statusLabel}
              {telemetry.healthLabel !== '—' && telemetry.healthLabel !== telemetry.statusLabel
                ? ` · ${telemetry.healthLabel}`
                : ''}
            </span>
          </div>
        </div>
        <button
          type="button"
          className="inspector-icon-btn"
          aria-label={t('收起节点详情')}
          title={t('收起节点详情')}
          onClick={onClose}
        >
          <X size={13} aria-hidden="true" />
        </button>
      </header>

      <dl className="topology-metrics-grid">
        <div>
          <dt>CPU</dt>
          <dd>
            <strong>{telemetry.cpuText}</strong>
            <small>{telemetry.coresText}</small>
          </dd>
        </div>
        <div>
          <dt>{t('内存')}</dt>
          <dd>
            <strong>{telemetry.memoryText}</strong>
            <small>{telemetry.memoryTotalText}</small>
          </dd>
        </div>
        <div>
          <dt>{t('执行槽位')}</dt>
          <dd>
            <strong>{telemetry.slotsText}</strong>
            {telemetry.waitingCount !== null && (
              <small>{t('等待 {{count}}', { count: telemetry.waitingText })}</small>
            )}
          </dd>
        </div>
        {telemetry.localActivity ? (
          <div>
            <dt>{t('实时流速')}</dt>
            <dd>
              <strong>{telemetry.localActivity.outputText}</strong>
              <small>
                {t('入均 {{rate}}', { rate: telemetry.localActivity.inputText })}
              </small>
            </dd>
          </div>
        ) : (
          <div>
            <dt>{t('队列等待')}</dt>
            <dd>
              <strong>{telemetry.waitingText}</strong>
              <small>{telemetry.healthLabel}</small>
            </dd>
          </div>
        )}
      </dl>

      {telemetry.healthCode !== 'normal' && telemetry.healthCode !== 'unknown' && (
        <p className="topology-control-alert" role="status">
          {telemetry.healthCode === 'congested'
            ? t('队列拥堵提醒')
            : telemetry.healthCode === 'resource_anomaly'
              ? t('持续资源异常提醒')
              : t('等待队列可能停滞')}
        </p>
      )}

      <div className="topology-control-actions">
        {canRoute && !telemetry.isLocal && (
          <>
            <button
              type="button"
              className={`topology-ctrl-btn${isTargeted && targetMode === 'preferred' ? ' is-active' : ''}`}
              aria-pressed={isTargeted && targetMode === 'preferred'}
              onClick={() =>
                onRouteNode(
                  isTargeted && targetMode === 'preferred' ? null : node,
                  isTargeted && targetMode === 'preferred' ? null : 'preferred',
                )
              }
            >
              <AtSign size={12} aria-hidden="true" />
              <span>{t('设为首选')}</span>
            </button>
            <button
              type="button"
              className={`topology-ctrl-btn${isTargeted && targetMode === 'locked' ? ' is-active' : ''}`}
              aria-pressed={isTargeted && targetMode === 'locked'}
              onClick={() =>
                onRouteNode(
                  isTargeted && targetMode === 'locked' ? null : node,
                  isTargeted && targetMode === 'locked' ? null : 'locked',
                )
              }
            >
              <Lock size={12} aria-hidden="true" />
              <span>{t('锁定路由')}</span>
            </button>
          </>
        )}
        {canRoute && telemetry.isLocal && (
          <button
            type="button"
            className={`topology-ctrl-btn${isTargeted ? ' is-active' : ''}`}
            aria-pressed={isTargeted}
            onClick={() => onRouteNode(isTargeted ? null : node, isTargeted ? null : 'locked')}
          >
            <Lock size={12} aria-hidden="true" />
            <span>{isTargeted ? t('恢复自动调度') : t('锁定本机')}</span>
          </button>
        )}
        {hasConversation && (
          <button
            type="button"
            className={`topology-ctrl-btn${isFiltered ? ' is-active' : ''}`}
            aria-pressed={isFiltered}
            onClick={() => onFilterNode(telemetry.id)}
          >
            <Filter size={12} aria-hidden="true" />
            <span>{isFiltered ? t('取消轨迹筛选') : t('按节点筛选轨迹')}</span>
          </button>
        )}
        {owner && (
          <button
            type="button"
            className="topology-ctrl-btn"
            onClick={onInspectCluster}
          >
            <ListOrdered size={12} aria-hidden="true" />
            <span>{t('查看队列')}</span>
          </button>
        )}
        {telemetry.isLocal && owner && (
          <button
            type="button"
            className={`topology-ctrl-btn${telemetry.paused ? ' is-active' : ''}`}
            disabled={!canPauseLocal}
            title={queueError ? t('正在确认队列状态') : undefined}
            onClick={() => queueSnapshot && onPauseQueue(!queueSnapshot.paused)}
          >
            {telemetry.paused ? <Play size={12} aria-hidden="true" /> : <Pause size={12} aria-hidden="true" />}
            <span>{telemetry.paused ? t('恢复队列') : t('暂停队列')}</span>
          </button>
        )}
        {!telemetry.isLocal && owner && node && (
          <button
            type="button"
            className="topology-ctrl-btn"
            onClick={() => onOpenDiagnostics(node.id)}
          >
            <Stethoscope size={12} aria-hidden="true" />
            <span>{t('连接诊断')}</span>
          </button>
        )}
      </div>

      <footer className="topology-control-foot">
        <span>
          {telemetry.sampleAgeSeconds !== null
            ? t('{{value1}} 秒前更新', { value1: telemetry.sampleAgeSeconds })
            : telemetry.online
              ? t('负载报告缺失或已过期')
              : t('离线')}
        </span>
        {telemetry.isLocal && (
          <span title={t('只统计本机执行的模型调用，其他设备的执行不计入。')}>
            <Activity size={10} aria-hidden="true" />
            {t('仅本机速率')}
          </span>
        )}
      </footer>
    </section>
  );
}

function LiveTopologyCanvas({
  local,
  peers,
  journey,
  connected,
  hasConversation,
  targetNodeID,
  targetMode,
  filterNodeID,
  selectedNodeID,
  telemetryMap,
  nodeName,
  onSelectNode,
}: {
  local: RivloomNode | null;
  peers: readonly RivloomNode[];
  journey: ConversationJourney | null;
  connected: boolean;
  hasConversation: boolean;
  targetNodeID: string | null;
  targetMode: 'preferred' | 'locked';
  filterNodeID: string | null;
  selectedNodeID: string | null;
  telemetryMap: ReadonlyMap<string, TopologyNodeTelemetry>;
  nodeName: (id: string | null) => string;
  onSelectNode: (nodeID: string) => void;
}) {
  const gradientPrefix = `rv-topo-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const localID = local?.id || 'local';
  const localLabel = local ? nodeDisplayName(local) : t('本机');
  const localTelemetry = telemetryMap.get(localID);
  const localExecuting =
    !!journey?.devices.some((d) => d.id === localID && d.executing) ||
    localTelemetry?.tone === 'active';

  const remoteIDs = useMemo(() => {
    const ids: string[] = [];
    const push = (id: string | null | undefined) => {
      if (!id || id === localID || ids.includes(id)) return;
      ids.push(id);
    };
    if (journey) {
      for (const device of journey.devices) push(device.id);
    }
    if (!hasConversation && targetNodeID) push(targetNodeID);
    for (const peer of peers) {
      if (peer.online && peer.channelReady) push(peer.id);
    }
    for (const peer of peers) push(peer.id);
    return ids.slice(0, 3);
  }, [journey, localID, hasConversation, targetNodeID, peers]);

  const peerYPositions =
    remoteIDs.length === 1 ? [78] : remoteIDs.length === 2 ? [44, 112] : [28, 78, 128];
  const localX = remoteIDs.length ? 46 : 134;
  const localY = 78;
  const peerX = 222;

  const edges = useMemo<TopologyEdge[]>(() => {
    const list: TopologyEdge[] = [];
    const connections = journey?.connections || [];
    const stages = journey?.stages || [];

    remoteIDs.forEach((peerID, index) => {
      const py = peerYPositions[index];
      const sendEdge: JourneyConnection | undefined = connections.find(
        (c) => c.fromNodeID === localID && c.toNodeID === peerID,
      );
      const recvEdge: JourneyConnection | undefined = connections.find(
        (c) => c.fromNodeID === peerID && c.toNodeID === localID,
      );

      if (sendEdge || recvEdge) {
        const dual = Boolean(sendEdge && recvEdge);
        if (sendEdge) {
          const active = sendEdge.fresh && sendEdge.counts.active > 0 && connected;
          list.push({
            key: `send:${peerID}`,
            peerID,
            d: bezierPath(localX + 39, localY, peerX - 39, py, dual ? -14 : 0),
            state: sendEdge.state === 'failed' ? 'failed' : active ? 'active' : sendEdge.state === 'complete' ? 'complete' : 'waiting',
            pulse: active,
          });
        }
        if (recvEdge) {
          const active = recvEdge.fresh && recvEdge.counts.active > 0 && connected;
          list.push({
            key: `recv:${peerID}`,
            peerID,
            d: bezierPath(peerX - 39, py, localX + 39, localY, dual ? 14 : 0),
            state: recvEdge.state === 'failed' ? 'failed' : active ? 'active' : recvEdge.state === 'complete' ? 'complete' : 'waiting',
            pulse: active,
          });
        }
        return;
      }

      const stage = stages.find(
        (s) =>
          (s.nodeID === peerID || s.toNodeID === peerID || s.fromNodeID === peerID) &&
          s.kind !== 'transfer',
      );
      if (stage) {
        const active = stage.state === 'active' && connected && !journey?.historical;
        list.push({
          key: `stage:${peerID}`,
          peerID,
          d: bezierPath(localX + 39, localY, peerX - 39, py, 0),
          state: stage.state === 'failed' ? 'failed' : active ? 'active' : stage.state === 'complete' ? 'complete' : 'waiting',
          pulse: active,
        });
        return;
      }

      const peer = peers.find((node) => node.id === peerID);
      const online = !!peer && peer.online && peer.channelReady && connected;
      const targeted = !hasConversation && targetNodeID === peerID;
      list.push({
        key: `mesh:${peerID}`,
        peerID,
        d: bezierPath(localX + 39, localY, peerX - 39, py, 0),
        state: targeted ? 'target' : 'idle',
        pulse: false,
        dashed: targeted ? targetMode === 'preferred' : !online,
      });
    });

    return list;
  }, [remoteIDs, peerYPositions, journey, localID, connected, peers, hasConversation, targetNodeID, targetMode, localX]);

  const activeRouteCount = edges.filter((edge) => edge.pulse || edge.state === 'active').length;
  const onlinePeerCount = peers.filter((node) => node.online && node.channelReady).length;
  const localRateBadge =
    localTelemetry?.localActivity && localTelemetry.localActivity.outputRate !== null
      ? localTelemetry.localActivity.outputText
      : null;

  return (
    <div className="live-topology-card">
      <div className="live-topology-head">
        <span>{t('多设备实时拓扑')}</span>
        <small>
          {localRateBadge && <b className="topology-head-rate">{localRateBadge}</b>}
          {activeRouteCount > 0
            ? t('{{count}} 项传输', { count: journey?.connections.length || activeRouteCount })
            : t('{{count}} 台在线', { count: (connected ? 1 : 0) + onlinePeerCount })}
        </small>
      </div>
      <div className="live-topology-stage">
        <svg viewBox="0 0 268 156" className="live-topology-svg" role="img" aria-label={t('多设备实时拓扑')}>
          <defs>
            <linearGradient id={`${gradientPrefix}-pulse`} x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.1" />
              <stop offset="65%" stopColor="var(--accent)" stopOpacity="0.95" />
              <stop offset="100%" stopColor="#ffffff" stopOpacity="0.95" />
            </linearGradient>
          </defs>

          {edges.map((edge) => {
            const focusID = filterNodeID || selectedNodeID;
            const dimmed = !!focusID && focusID !== localID && focusID !== edge.peerID;
            return (
              <g key={edge.key} className={`topology-edge is-${edge.state}${dimmed ? ' is-dimmed' : ''}`}>
                <path
                  className={`topology-wire${edge.dashed ? ' is-dashed' : ''}`}
                  d={edge.d}
                />
                {edge.pulse && !dimmed && (
                  <path
                    className="topology-filament-packet"
                    d={edge.d}
                    pathLength="100"
                    stroke={`url(#${gradientPrefix}-pulse)`}
                  />
                )}
              </g>
            );
          })}

          <g
            data-topology-node={localID}
            className={`topology-node is-local is-clickable is-tone-${localTelemetry?.tone || 'unknown'}${localExecuting ? ' is-executing' : ''}${!hasConversation && targetNodeID === localID ? ' is-targeted' : ''}${selectedNodeID === localID ? ' is-selected' : ''}${hasConversation && filterNodeID === localID ? ' is-filtered' : ''}`}
            transform={`translate(${localX}, ${localY})`}
            role="button"
            tabIndex={0}
            aria-pressed={selectedNodeID === localID}
            aria-label={`${localLabel} · ${localTelemetry?.statusLabel || t('本机')} · ${t('点击查看节点状态与控制')}`}
            onClick={() => onSelectNode(localID)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelectNode(localID);
              }
            }}
          >
            {localExecuting && <circle className="topology-node-halo" r="27" />}
            <rect x="-39" y="-19" width="78" height="38" rx="8" className="topology-node-box" />
            <circle
              cx="-30"
              cy="-6.5"
              r="2.6"
              className={`topology-node-dot is-${localTelemetry?.tone || 'unknown'}`}
            />
            <text x="-23.5" y="-3.5" textAnchor="start" className="topology-node-name">
              {shortLabel(localLabel, 9)}
            </text>
            <text x="0" y="9.5" textAnchor="middle" className="topology-node-metric">
              {shortLabel(localTelemetry?.svgMetricText || '—', 14)}
            </text>
            {localTelemetry && localTelemetry.svgLoadPercent !== null && (
              <>
                <rect x="-33" y="14.5" width="66" height="2" rx="1" className="topology-node-meter-track" />
                <rect
                  x="-33"
                  y="14.5"
                  width={Math.max(2, Math.round((66 * Math.min(100, Math.max(0, localTelemetry.svgLoadPercent))) / 100))}
                  height="2"
                  rx="1"
                  className={`topology-node-meter-fill${localTelemetry.svgLoadPercent >= 85 ? ' is-high' : ''}`}
                />
              </>
            )}
          </g>

          {remoteIDs.map((peerID, index) => {
            const py = peerYPositions[index];
            const peer = peers.find((node) => node.id === peerID) || null;
            const telemetry = telemetryMap.get(peerID);
            const online = telemetry?.online ?? false;
            const executing =
              !!journey?.devices.some((d) => d.id === peerID && d.executing) ||
              telemetry?.tone === 'active';
            const targeted = !hasConversation && targetNodeID === peerID;
            const filtered = hasConversation && filterNodeID === peerID;
            const selected = selectedNodeID === peerID;
            const name = peer ? nodeDisplayName(peer) : nodeName(peerID);
            return (
              <g
                key={peerID}
                data-topology-node={peerID}
                className={`topology-node is-peer is-clickable is-tone-${telemetry?.tone || 'unknown'}${executing ? ' is-executing' : ''}${targeted ? ' is-targeted' : ''}${selected ? ' is-selected' : ''}${filtered ? ' is-filtered' : ''}${!online ? ' is-offline' : ''}`}
                transform={`translate(${peerX}, ${py})`}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                aria-label={`${name} · ${telemetry?.statusLabel || t('离线')} · ${t('点击查看节点状态与控制')}`}
                onClick={() => onSelectNode(peerID)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelectNode(peerID);
                  }
                }}
              >
                {executing && <circle className="topology-node-halo" r="25" />}
                <rect x="-39" y="-17" width="78" height="34" rx="8" className="topology-node-box" />
                <circle
                  cx="-30"
                  cy="-5.5"
                  r="2.6"
                  className={`topology-node-dot is-${telemetry?.tone || 'unknown'}`}
                />
                <text x="-23.5" y="-2.5" textAnchor="start" className="topology-node-name">
                  {shortLabel(name, 9)}
                </text>
                <text x="0" y="9" textAnchor="middle" className="topology-node-metric">
                  {shortLabel(telemetry?.svgMetricText || '—', 14)}
                </text>
                {telemetry && telemetry.svgLoadPercent !== null && (
                  <>
                    <rect x="-33" y="13" width="66" height="1.8" rx="0.9" className="topology-node-meter-track" />
                    <rect
                      x="-33"
                      y="13"
                      width={Math.max(2, Math.round((66 * Math.min(100, Math.max(0, telemetry.svgLoadPercent))) / 100))}
                      height="1.8"
                      rx="0.9"
                      className={`topology-node-meter-fill${telemetry.svgLoadPercent >= 85 ? ' is-high' : ''}`}
                    />
                  </>
                )}
              </g>
            );
          })}
        </svg>
        <p className="live-topology-caption">
          {!remoteIDs.length
            ? t('本机中心 · 点击节点查看实时负载与控制')
            : t('点击拓扑节点查看实时负载与快捷控制')}
        </p>
      </div>
    </div>
  );
}

function InlineProjectChanges({
  project,
  canWrite,
  disabled,
  onOpenFullChanges,
  onQuoteDiff,
  onAttachFileReference,
}: {
  project: Project;
  canWrite: boolean;
  disabled: boolean;
  onOpenFullChanges: (project: Project) => void;
  onQuoteDiff: (quoteText: string) => void;
  onAttachFileReference: (project: Project, path: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<ProjectChanges | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [scopeFilter, setScopeFilter] = useState<ChangeScopeFilter>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [area, setArea] = useState<ProjectDiff['area']>('working');
  const [diff, setDiff] = useState<ProjectDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState(false);
  const [selectedDiffText, setSelectedDiffText] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [actionNote, setActionNote] = useState('');
  const [previewFile, setPreviewFile] = useState<{
    file: Pick<TaskFileDescriptor, 'name' | 'bytes'>;
    path: string;
  } | null>(null);
  const diffContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    setDiff(null);
    setActionNote('');
    void api<ProjectChanges>(`/projects/${encodeURIComponent(project.id)}/changes`, undefined, {
      signal: controller.signal,
      timeoutMilliseconds: 30_000,
    })
      .then((value) => {
        if (controller.signal.aborted) return;
        setSnapshot(value);
        setSelected((previous) =>
          value.files.some((file) => file.path === previous) ? previous : value.files[0]?.path || null,
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [project.id, revision]);

  const partitioned = useMemo(
    () => partitionProjectChanges(snapshot?.files || []),
    [snapshot?.files],
  );
  const visibleFiles =
    scopeFilter === 'staged'
      ? partitioned.staged
      : scopeFilter === 'working'
        ? partitioned.working
        : partitioned.all;

  useEffect(() => {
    if (!visibleFiles.length) return;
    if (!selected || !visibleFiles.some((entry) => entry.path === selected)) {
      setSelected(visibleFiles[0].path);
    }
  }, [visibleFiles, selected]);

  const file = snapshot?.files.find((entry) => entry.path === selected);
  const staged = !!file && !file.untracked && file.index !== ' ';
  const working = !!file && (file.untracked || file.worktree !== ' ');
  const effectiveArea = defaultDiffAreaForFile(file, area, scopeFilter);

  useEffect(() => {
    setSelectedDiffText('');
    setActionNote('');
    if (!selected || loading || error || snapshot?.state !== 'ready') return;
    const controller = new AbortController();
    setDiff(null);
    setDiffLoading(true);
    setDiffError(false);
    void api<ProjectDiff>(
      `/projects/${encodeURIComponent(project.id)}/changes/diff`,
      { path: selected, area: effectiveArea },
      { signal: controller.signal, timeoutMilliseconds: 30_000 },
    )
      .then((value) => {
        if (!controller.signal.aborted) setDiff(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setDiffError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setDiffLoading(false);
      });
    return () => controller.abort();
  }, [project.id, selected, effectiveArea, loading, error, revision, snapshot]);

  useEffect(() => {
    const onSelectionChange = () => {
      const container = diffContainerRef.current;
      const selection = window.getSelection();
      if (
        !container ||
        !selection ||
        selection.isCollapsed ||
        !selection.anchorNode ||
        !selection.focusNode ||
        !container.contains(selection.anchorNode) ||
        !container.contains(selection.focusNode)
      ) {
        setSelectedDiffText('');
        return;
      }
      setSelectedDiffText(selection.toString().slice(0, 3600));
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, []);

  const hunks = useMemo(
    () => (diff?.state === 'ready' && diff.text ? parseDiffHunks(diff.text, diff.kind) : []),
    [diff],
  );
  const inspectability = canInspectChangedFile(file, diff);

  async function openQuickPreview() {
    if (!selected || actionBusy || !inspectability.canPreview) return;
    setActionBusy(true);
    setActionNote('');
    try {
      const entryPath = `/projects/${encodeURIComponent(project.id)}/file/${encodeURIComponent(selected)}`;
      const meta = await api<Pick<TaskFileDescriptor, 'name' | 'bytes'>>(entryPath);
      setPreviewFile({ file: meta, path: entryPath });
    } catch {
      setActionNote(t('当前无法预览此文件。'));
    } finally {
      setActionBusy(false);
    }
  }

  async function revealInFolder() {
    if (!selected || actionBusy || !inspectability.canReveal || !desktop) return;
    setActionBusy(true);
    setActionNote('');
    try {
      const entryPath = `/projects/${encodeURIComponent(project.id)}/file/${encodeURIComponent(selected)}`;
      const location = await api<{ path: string }>(`${entryPath}/location`, {});
      await revealTaskFile(location.path);
    } catch {
      setActionNote(t('无法在文件夹中定位此文件。'));
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <section className="inspector-section inspector-git-section" aria-label={t('项目改动')}>
      <div className="inspector-section-head">
        <span className="inspector-section-title">
          <GitBranch size={13} aria-hidden="true" />
          <strong>{snapshot?.branch || project.name}</strong>
          {snapshot?.state === 'ready' && snapshot.files.length > 0 && (
            <small>{snapshot.files.length}</small>
          )}
        </span>
        <span className="inspector-section-actions">
          <button
            type="button"
            className="inspector-icon-btn"
            disabled={loading}
            aria-label={t('刷新')}
            title={t('刷新')}
            onClick={() => setRevision((v) => v + 1)}
          >
            {loading ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}
          </button>
          <button
            type="button"
            className="inspector-icon-btn"
            aria-label={t('展开全屏查看')}
            title={t('展开全屏查看')}
            onClick={() => onOpenFullChanges(project)}
          >
            <Maximize2 size={13} />
          </button>
        </span>
      </div>

      {loading ? (
        <p className="inspector-note" role="status">
          {t('正在读取项目改动…')}
        </p>
      ) : error ? (
        <p className="inspector-note is-error" role="alert">
          {t('读取项目改动失败，请重试。')}
        </p>
      ) : snapshot?.state !== 'ready' ? (
        <p className="inspector-note" role="status">
          {snapshot?.state === 'not-repository'
            ? t('此目录没有 Git 仓库。')
            : t('工作区没有待查看的改动。')}
        </p>
      ) : !snapshot.files.length ? (
        <div className="inspector-empty-inline">
          <FileDiff size={16} aria-hidden="true" />
          <span>{t('工作区没有待查看的改动。')}</span>
        </div>
      ) : (
        <>
          <div className="inspector-scope-pills" role="group" aria-label={t('按暂存状态筛选改动')}>
            {(
              [
                ['all', t('全部'), partitioned.counts.all],
                ['working', t('未暂存'), partitioned.counts.working],
                ['staged', t('已暂存'), partitioned.counts.staged],
              ] as const
            ).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                aria-pressed={scopeFilter === key}
                disabled={key !== 'all' && count === 0}
                onClick={() => {
                  setScopeFilter(key);
                  if (key === 'staged') setArea('staged');
                  else if (key === 'working') setArea('working');
                }}
              >
                <span>{label}</span>
                <b>{count}</b>
              </button>
            ))}
          </div>

          <ul className="inspector-change-files" aria-label={t('改动文件')}>
            {visibleFiles.slice(0, 30).map((entry) => {
              const badge = changeFileStatusBadge(entry);
              return (
                <li key={entry.path}>
                  <button
                    type="button"
                    className={selected === entry.path ? 'active' : ''}
                    aria-current={selected === entry.path ? 'true' : undefined}
                    title={`${entry.path} · ${badge.label}`}
                    onClick={() => setSelected(entry.path)}
                  >
                    <File size={12} aria-hidden="true" />
                    <span>{entry.path}</span>
                    <em className={`inspector-change-badge is-${badge.tone}`} title={badge.label}>
                      {badge.label}
                    </em>
                  </button>
                </li>
              );
            })}
          </ul>

          {selected && (
            <div className="inspector-diff-viewer" aria-label={t('文件差异')}>
              <div className="inspector-diff-bar">
                <strong title={selected}>{selected.split('/').at(-1)}</strong>
                {(working || staged) && (
                  <div className="inspector-diff-tabs" role="group" aria-label={t('差异范围')}>
                    <button
                      type="button"
                      aria-pressed={effectiveArea === 'working'}
                      disabled={!working}
                      onClick={() => setArea('working')}
                    >
                      {t('未暂存')}
                    </button>
                    <button
                      type="button"
                      aria-pressed={effectiveArea === 'staged'}
                      disabled={!staged}
                      onClick={() => setArea('staged')}
                    >
                      {t('已暂存')}
                    </button>
                  </div>
                )}
              </div>

              <div className="inspector-diff-actions" role="toolbar" aria-label={t('差异审核操作')}>
                <button
                  type="button"
                  className="inspector-action-chip"
                  disabled={!canWrite || disabled}
                  title={t('作为工作区文件引用附入输入框')}
                  onClick={() => onAttachFileReference(project, selected)}
                >
                  <AtSign size={11.5} aria-hidden="true" />
                  <span>{t('引用文件')}</span>
                </button>
                <button
                  type="button"
                  className="inspector-action-chip is-accent"
                  disabled={!canWrite || disabled || diff?.state !== 'ready' || !diff.text}
                  onMouseDown={(event) => event.preventDefault()}
                  title={
                    selectedDiffText.trim()
                      ? t('将当前划选的差异片段引用到输入框')
                      : t('将此文件差异引用到输入框以便追问')
                  }
                  onClick={() => {
                    if (!diff?.text) return;
                    const snippet = selectedDiffText.trim() || diff.text;
                    onQuoteDiff(
                      buildDiffQuoteText({
                        path: selected,
                        area: effectiveArea,
                        snippet,
                      }),
                    );
                  }}
                >
                  <Quote size={11.5} aria-hidden="true" />
                  <span>{selectedDiffText.trim() ? t('引用选区') : t('引用到输入框')}</span>
                </button>
                <button
                  type="button"
                  className="inspector-icon-btn"
                  disabled={actionBusy || !inspectability.canPreview}
                  aria-label={t('快速预览')}
                  title={t('快速预览')}
                  onClick={() => void openQuickPreview()}
                >
                  <Eye size={13} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="inspector-icon-btn"
                  disabled={actionBusy || !inspectability.canReveal || !desktop}
                  aria-label={t('在文件夹中定位')}
                  title={desktop ? t('在文件夹中定位') : t('请在桌面端操作本机文件。')}
                  onClick={() => void revealInFolder()}
                >
                  <FolderOpen size={13} aria-hidden="true" />
                </button>
              </div>

              {actionNote && (
                <p className="inspector-note is-error" role="status">
                  {actionNote}
                </p>
              )}

              {diffLoading ? (
                <p className="inspector-note" role="status">
                  {t('正在读取差异…')}
                </p>
              ) : diffError ? (
                <p className="inspector-note is-error" role="alert">
                  {t('读取差异失败，请刷新后重试。')}
                </p>
              ) : diff?.state === 'ready' && diff.text ? (
                <div ref={diffContainerRef} className="inspector-diff-body">
                  {diff.kind === 'patch' && hunks.length > 0 ? (
                    <div className="inspector-hunk-list">
                      {hunks.slice(0, 16).map((hunk) => (
                        <div className="inspector-diff-hunk" key={hunk.id}>
                          <div className="inspector-hunk-head">
                            <code title={hunk.header}>{hunk.header}</code>
                            <span className="inspector-hunk-stats">
                              <b className="is-add">+{hunk.additions}</b>
                              <b className="is-del">−{hunk.deletions}</b>
                            </span>
                            <button
                              type="button"
                              className="inspector-hunk-quote"
                              disabled={!canWrite || disabled}
                              title={t('引用此差异片段到输入框')}
                              onClick={() =>
                                onQuoteDiff(
                                  buildDiffQuoteText({
                                    path: selected,
                                    area: effectiveArea,
                                    header: hunk.header,
                                    snippet: hunk.raw,
                                  }),
                                )
                              }
                            >
                              <Quote size={11} aria-hidden="true" />
                              <span>{t('引用片段')}</span>
                            </button>
                          </div>
                          <pre className="inspector-diff-pre" tabIndex={0}>
                            <code>
                              {hunk.lines.slice(0, 60).map((line, index) => (
                                <span
                                  key={index}
                                  className={
                                    line.startsWith('+') && !line.startsWith('+++')
                                      ? 'added'
                                      : line.startsWith('-') && !line.startsWith('---')
                                        ? 'removed'
                                        : undefined
                                  }
                                >
                                  {line || ' '}
                                </span>
                              ))}
                            </code>
                          </pre>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <pre className="inspector-diff-pre" tabIndex={0}>
                      <code>
                        {diff.text
                          .split('\n')
                          .slice(0, 140)
                          .map((line, index) => (
                            <span key={index}>{line || ' '}</span>
                          ))}
                      </code>
                    </pre>
                  )}
                </div>
              ) : (
                <p className="inspector-note">
                  {diff?.state === 'sensitive'
                    ? t('此文件可能包含凭据，内容不在这里展示。')
                    : diff?.state === 'binary'
                      ? t('二进制或非 UTF-8 文件，请使用本机工具查看。')
                      : t('此范围没有文本差异，可能只有文件属性发生变化。')}
                </p>
              )}
            </div>
          )}
        </>
      )}
      {previewFile && (
        <FilePreview
          file={previewFile.file}
          path={previewFile.path}
          source={project.name}
          close={() => {
            setPreviewFile(null);
            setRevision((v) => v + 1);
          }}
        />
      )}
    </section>
  );
}

export function LiveInspector({
  activeTab,
  onTabChange,
  onClose,
  data,
  current,
  all,
  local,
  peers,
  connected,
  connectionError,
  activity,
  queueCount,
  queueSnapshot,
  queueBusy,
  queueError,
  queuePanel,
  reviewProject,
  targetNodeID,
  targetMode,
  targetName,
  canWrite,
  disabled,
  nodeName,
  onRemarkNode,
  onRemoveNode,
  onRouteNode,
  onPauseQueue,
  onOpenDiagnostics,
  onOpenFullChanges,
  onOpenNetwork,
  onOpenKnowledgeReads,
  onQuoteDiff,
  onAttachFileReference,
  inert,
}: {
  activeTab: LiveInspectorTab;
  onTabChange: (tab: LiveInspectorTab) => void;
  onClose: () => void;
  data: Bootstrap;
  current: Conversation | undefined;
  all: readonly Conversation[];
  local: RivloomNode | null;
  peers: readonly RivloomNode[];
  connected: boolean;
  connectionError: string;
  activity: NodeActivityState;
  queueCount: number;
  queueSnapshot: NodeQueueSnapshot | null;
  queueBusy: boolean;
  queueError: string;
  queuePanel: ReactNode;
  reviewProject: Project | undefined;
  targetNodeID: string | null;
  targetMode: 'preferred' | 'locked';
  targetName: string;
  canWrite: boolean;
  disabled: boolean;
  nodeName: (id: string | null) => string;
  onRemarkNode: (id: string) => void;
  onRemoveNode: (id: string) => void;
  onRouteNode: (node: RivloomNode | null, forcedMode?: 'preferred' | 'locked' | null) => void;
  onPauseQueue: (paused: boolean) => void;
  onOpenDiagnostics: (nodeID: string) => void;
  onOpenFullChanges: (project: Project) => void;
  onOpenNetwork: () => void;
  onOpenKnowledgeReads?: () => void;
  onQuoteDiff: (quoteText: string) => void;
  onAttachFileReference: (project: Project, path: string) => void;
  inert?: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const observedAt = Math.max(now, activity.now);

  const requests = useTaskFileRequests();
  const routes = useMemo<TaskFileQuery[]>(() => {
    if (!current) return [];
    if (current.workflow) return workflowActivityFileRoutes(current.workflow, requests);
    const scope = current.brainTask ? 'brain' : current.remote ? 'remote' : 'local';
    const taskID = current.brainTask?.id || current.remote?.id || current.localTask?.id;
    return taskID ? [{ scope, taskID }] : [];
  }, [current, requests]);

  const fileRevision = useMemo(() => {
    if (!current) return '';
    if (current.workflow) {
      const value = current.workflow;
      return JSON.stringify([
        value.roundRequestID,
        value.state,
        [value.planner, ...value.steps].map((step) => {
          const attempt = step.attempts.at(-1);
          return (
            attempt && [
              attempt.executionID,
              attempt.phase,
              attempt.inputFiles.map((f) => f.id),
              attempt.outputFiles.map((f) => f.id),
            ]
          );
        }),
      ]);
    }
    return legacyFileRevision(current);
  }, [current]);

  const fileStates = useTaskFileStates(routes, fileRevision);
  const liveConnected = connected && !connectionError;

  const { summary, journey } = useMemo(() => {
    if (!current) return { summary: null, journey: null };
    if (current.workflow) {
      const workflow = current.workflow;
      const terminal = ['completed', 'failed', 'stopped'].includes(workflow.state);
      const latestExecutions = workflowLatestExecutions(workflow, data, false);
      const running = latestExecutions.filter((entry) => entry.attempt.phase === 'running');
      const tone: ActivityTone =
        workflow.state === 'failed'
          ? 'attention'
          : !liveConnected && !terminal
            ? 'unavailable'
            : terminal
              ? 'settled'
              : running.length && workflow.state !== 'stopping'
                ? 'active'
                : 'waiting';
      const nextSummary = conversationActivitySummary({
        label: !liveConnected && !terminal ? t('状态待更新') : conversationState(current),
        tone,
        files: fileStates,
        executionCount: running.length,
      });
      const nextJourney = conversationJourney({
        conversationKey: `workflow:${workflow.id}`,
        localNodeID: local?.id || null,
        workflow,
        transfers: nextSummary.transfers,
        requestedRoutes: requests,
        fresh: liveConnected,
      });
      return { summary: nextSummary, journey: nextJourney };
    }
    const task = current.localTask;
    const remote = current.remote;
    const state = task?.state || remote?.executionState || current.brainTask?.status;
    const terminal =
      ['review', 'accepted', 'completed', 'stopped', 'cancelled', 'rejected', 'expired'].includes(
        state || '',
      ) ||
      (!!remote && ['cancelled', 'rejected', 'expired'].includes(remote.status));
    const attentionCount =
      (task?.approvals.length || remote?.remoteApprovals.length || 0) +
      (task?.questions.length || remote?.remoteQuestions.length || 0);
    const tone: ActivityTone =
      attentionCount || conversationIsFailed(current) || state === 'interrupted'
        ? 'attention'
        : !liveConnected && !terminal
          ? 'unavailable'
          : terminal
            ? 'settled'
            : conversationIsRunning(current)
              ? 'active'
              : 'waiting';
    const nextSummary = conversationActivitySummary({
      label: !liveConnected && !terminal ? t('状态待更新') : conversationState(current),
      tone,
      files: fileStates,
      attentionCount,
    });
    const nextJourney = conversationJourney({
      conversationKey: current.key,
      localNodeID: local?.id || null,
      conversation: current,
      transfers: nextSummary.transfers,
      fresh: liveConnected,
    });
    return { summary: nextSummary, journey: nextJourney };
  }, [current, data, fileStates, liveConnected, local?.id, requests]);

  const deliverableRounds = useMemo(
    () => (current?.workflow ? collectWorkflowDeliverableRounds(current.workflow) : []),
    [current?.workflow],
  );
  const [selectedRound, setSelectedRound] = useState<'all' | number>('all');
  useEffect(() => {
    setSelectedRound('all');
  }, [current?.key]);

  const visibleDeliverableRounds = useMemo(
    () =>
      selectedRound === 'all'
        ? deliverableRounds.filter((round) => round.groups.length > 0)
        : deliverableRounds.filter((round) => round.roundNumber === selectedRound),
    [deliverableRounds, selectedRound],
  );

  const legacyArtifacts = current?.localTask?.artifacts || current?.remote?.remoteArtifacts || [];
  const deliverableCount =
    deliverableRounds.reduce((sum, round) => sum + round.fileCount, 0) + legacyArtifacts.length;
  const activeTabIndex = activeTab === 'topology' ? 0 : activeTab === 'artifacts' ? 1 : 2;
  const [filterNodeID, setFilterNodeID] = useState<string | null>(null);
  const [selectedNodeID, setSelectedNodeID] = useState<string | null>(null);
  useEffect(() => {
    setFilterNodeID(null);
  }, [current?.key]);

  const localID = local?.id || 'local';
  const telemetryMap = useMemo(() => {
    const map = new Map<string, TopologyNodeTelemetry>();
    map.set(
      localID,
      buildTopologyNodeTelemetry({
        node: local,
        isLocal: true,
        now: observedAt,
        connected: liveConnected,
        activitySnapshot: activity.snapshot,
        activityLoading: activity.loading,
        queueSnapshot,
      }),
    );
    for (const peer of peers) {
      map.set(
        peer.id,
        buildTopologyNodeTelemetry({
          node: peer,
          isLocal: false,
          now: observedAt,
          connected: liveConnected,
        }),
      );
    }
    return map;
  }, [localID, local, peers, observedAt, liveConnected, activity.snapshot, activity.loading, queueSnapshot]);

  const selectedNode =
    selectedNodeID === localID
      ? local
      : peers.find((peer) => peer.id === selectedNodeID) || null;
  const selectedTelemetry = selectedNodeID
    ? telemetryMap.get(selectedNodeID) ||
      buildTopologyNodeTelemetry({
        node: null,
        isLocal: false,
        now: observedAt,
        connected: liveConnected,
      })
    : null;

  const filteredJourney = useMemo<ConversationJourney | null>(() => {
    if (!journey || !filterNodeID) return journey;
    const isLocalFilter = filterNodeID === localID;
    const stages = journey.stages.filter((stage) => {
      if (stage.kind === 'transfer') {
        return isLocalFilter || stage.fromNodeID === filterNodeID || stage.toNodeID === filterNodeID;
      }
      return (
        stage.nodeID === filterNodeID ||
        stage.toNodeID === filterNodeID ||
        (stage.kind === 'handoff' && stage.fromNodeID === filterNodeID)
      );
    });
    const groups = journey.groups.filter(
      (group) => isLocalFilter || group.peerNodeID === filterNodeID || group.fromNodeID === filterNodeID || group.toNodeID === filterNodeID,
    );
    const connections = journey.connections.filter(
      (edge) => isLocalFilter || edge.fromNodeID === filterNodeID || edge.toNodeID === filterNodeID,
    );
    return { ...journey, stages, groups, connections };
  }, [journey, filterNodeID, localID]);

  const filteredTransfers = useMemo(() => {
    if (!summary) return [];
    if (!filterNodeID || filterNodeID === localID) return summary.transfers;
    return summary.transfers.filter((file) => file.peerNodeID === filterNodeID);
  }, [summary, filterNodeID, localID]);

  const hasFilteredActivity =
    !!filteredJourney &&
    (filteredJourney.stages.some((stage) => stage.kind !== 'transfer') || filteredTransfers.length > 0);

  const knowledgeTaskIDs = useMemo(() => {
    if (!current) return [];
    if (current.workflow) {
      return workflowAllSteps(current.workflow).flatMap((step) =>
        step.attempts.filter((attempt) => attempt.kind === 'local').map((attempt) => attempt.executionID),
      );
    }
    return current.localTask?.id ? [current.localTask.id] : [];
  }, [current]);

  const hasRemoteKnowledgeScope = useMemo(() => {
    if (!current) return false;
    if (current.workflow) {
      return workflowAllSteps(current.workflow).some((step) =>
        step.attempts.some((attempt) => attempt.kind === 'remote'),
      );
    }
    return Boolean(current.remote || current.brainTask);
  }, [current]);

  const knowledgeUsageRevision = useMemo(() => {
    if (!current) return '';
    if (current.workflow) {
      return `${current.key}:${current.workflow.state}:${current.workflow.version}:${fileRevision}`;
    }
    return `${current.key}:${current.localTask?.state || ''}:${current.localTask?.messages.length || 0}`;
  }, [current, fileRevision]);

  return (
    <aside
      id="conversation-network-sidebar"
      className="network-rail live-inspector"
      aria-label={t('工作台检视')}
      inert={inert}
    >
      <header className="live-inspector-header">
        <div
          className="live-inspector-tabs"
          role="tablist"
          aria-label={t('工作台检视')}
          data-active-index={activeTabIndex}
        >
          <span className="live-inspector-pill" aria-hidden="true" />
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'topology'}
            onClick={() => onTabChange('topology')}
          >
            <Network size={12.5} aria-hidden="true" />
            <span>{t('拓扑')}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'artifacts'}
            onClick={() => onTabChange('artifacts')}
          >
            <FileCode2 size={12.5} aria-hidden="true" />
            <span>{t('产物')}</span>
            {deliverableCount > 0 && <b className="inspector-tab-count">{deliverableCount}</b>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'cluster'}
            onClick={() => onTabChange('cluster')}
          >
            <ListOrdered size={12.5} aria-hidden="true" />
            <span>{t('集群')}</span>
            {queueCount > 0 && <b className="inspector-tab-count">{queueCount}</b>}
          </button>
        </div>
        <button
          type="button"
          className="inspector-close-btn"
          aria-label={t('收起工作台检视')}
          title={`${t('收起工作台检视')} · ${primaryShortcut('J')}`}
          onClick={onClose}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </header>

      <div className="live-inspector-body" role="tabpanel">
        {activeTab === 'topology' && (
          <div className="inspector-pane inspector-pane-topology">
            <LiveTopologyCanvas
              local={local}
              peers={peers}
              journey={journey}
              connected={liveConnected}
              hasConversation={!!current}
              targetNodeID={targetNodeID}
              targetMode={targetMode}
              filterNodeID={filterNodeID}
              selectedNodeID={selectedNodeID}
              telemetryMap={telemetryMap}
              nodeName={nodeName}
              onSelectNode={(nodeID) =>
                setSelectedNodeID((previous) => (previous === nodeID ? null : nodeID))
              }
            />

            {selectedNodeID && selectedTelemetry && (
              <TopologyNodeControlCard
                node={selectedNode}
                telemetry={selectedTelemetry}
                nodeLabel={
                  selectedNode
                    ? nodeDisplayName(selectedNode)
                    : selectedNodeID === localID
                      ? t('本机')
                      : nodeName(selectedNodeID)
                }
                hasConversation={!!current}
                owner={data.user.owner}
                disabled={disabled}
                targetNodeID={targetNodeID}
                targetMode={targetMode}
                filterNodeID={filterNodeID}
                queueSnapshot={queueSnapshot}
                queueBusy={queueBusy}
                queueError={queueError}
                onClose={() => setSelectedNodeID(null)}
                onRouteNode={onRouteNode}
                onFilterNode={(nodeID) =>
                  setFilterNodeID((previous) => (previous === nodeID ? null : nodeID))
                }
                onInspectCluster={() => onTabChange('cluster')}
                onPauseQueue={onPauseQueue}
                onOpenDiagnostics={onOpenDiagnostics}
              />
            )}

            {current && filterNodeID && (
              <div className="inspector-filter-bar" role="status">
                <span>{t('已按设备筛选：{{node}}', { node: nodeName(filterNodeID) })}</span>
                <button
                  type="button"
                  aria-label={t('清除筛选')}
                  onClick={() => setFilterNodeID(null)}
                >
                  <X size={12} aria-hidden="true" />
                  {t('清除筛选')}
                </button>
              </div>
            )}

            {current && filteredJourney && summary ? (
              <section className="inspector-section inspector-trail-section">
                <div className="inspector-status-strip" data-tone={summary.tone}>
                  <span className="inspector-status-dot" aria-hidden="true" />
                  <strong>{summary.label}</strong>
                  {summary.detail && <small>{summary.detail}</small>}
                </div>
                <TaskFileRecovery states={fileStates} />
                {hasFilteredActivity ? (
                  <ConversationJourneyTrail
                    journey={filteredJourney}
                    nodeName={nodeName}
                    identityKey={current.key}
                    files={filteredTransfers}
                  />
                ) : (
                  <div className="inspector-filter-empty">
                    <p className="inspector-note">{t('此设备暂未参与当前会话的执行或传输')}</p>
                    <button
                      type="button"
                      className="mission-inline-link"
                      onClick={() => setFilterNodeID(null)}
                    >
                      {t('显示全部')}
                    </button>
                  </div>
                )}
              </section>
            ) : (
              <section className="inspector-section inspector-standby">
                <div className="inspector-standby-target">
                  <Check size={13} aria-hidden="true" />
                  <span>
                    {t('当前目标：{{target}}', {
                      target: targetNodeID
                        ? `${targetMode === 'locked' ? t('锁定') : t('首选')} · ${targetName}`
                        : t('自动调度'),
                    })}
                  </span>
                </div>
                <p className="inspector-note">
                  {t('发送任务后，这里会实时展示多设备拓扑与协作轨迹。')}
                </p>
              </section>
            )}

            {current && (knowledgeTaskIDs.length > 0 || hasRemoteKnowledgeScope) && (
              <TaskKnowledgeUsageSection
                compact
                taskIDs={knowledgeTaskIDs}
                revision={knowledgeUsageRevision}
                hasRemoteExecutions={hasRemoteKnowledgeScope}
                localNodeID={local?.id || null}
                nodeName={nodeName}
                brainName={(id) => data.network.brains.find((brain) => brain.id === id)?.name || null}
                onOpenContext={onOpenKnowledgeReads}
              />
            )}
          </div>
        )}

        {activeTab === 'artifacts' && (
          <div className="inspector-pane inspector-pane-artifacts">
            {current && (
              <section className="inspector-section" aria-label={t('会话交付物')}>
                <div className="inspector-section-head">
                  <span className="inspector-section-title">
                    <FileCode2 size={13} aria-hidden="true" />
                    <strong>{t('会话交付物')}</strong>
                    {deliverableCount > 0 && <small>{deliverableCount}</small>}
                  </span>
                </div>

                {deliverableRounds.length > 1 && (
                  <div className="inspector-round-pills" role="group" aria-label={t('按轮次筛选交付物')}>
                    <button
                      type="button"
                      aria-pressed={selectedRound === 'all'}
                      onClick={() => setSelectedRound('all')}
                    >
                      <Layers size={11} aria-hidden="true" />
                      <span>{t('全部轮次')}</span>
                      <b>{deliverableCount}</b>
                    </button>
                    {deliverableRounds.map((round) => (
                      <button
                        key={round.roundNumber}
                        type="button"
                        aria-pressed={selectedRound === round.roundNumber}
                        title={round.promptSnippet || round.label}
                        onClick={() => setSelectedRound(round.roundNumber)}
                      >
                        <span>{round.label}</span>
                        <b>{round.fileCount}</b>
                      </button>
                    ))}
                  </div>
                )}

                {visibleDeliverableRounds.length > 0 && (
                  <div className="inspector-deliverable-groups">
                    {visibleDeliverableRounds.map((round) => (
                      <div className="inspector-deliverable-round" key={`round-${round.roundNumber}`}>
                        {deliverableRounds.length > 1 && (
                          <div className="inspector-deliverable-round-head">
                            <strong>{round.label}</strong>
                            {round.promptSnippet && <small title={round.promptSnippet}>{round.promptSnippet}</small>}
                          </div>
                        )}
                        {round.groups.length > 0 ? (
                          round.groups.map((group) => (
                            <div className="inspector-deliverable-group" key={group.key}>
                              <small className="inspector-deliverable-step">{group.stepTitle}</small>
                              <TaskFilesPanel
                                scope={group.scope}
                                taskID={group.taskID}
                                revision={fileRevision}
                                nodeName={nodeName}
                                resultsOnly
                                lazy
                                manifest={group.outputFiles}
                              />
                            </div>
                          ))
                        ) : (
                          <p className="inspector-note">{t('该轮次暂未产生文件交付物。')}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {legacyArtifacts.length > 0 && (
                  <div className="inspector-artifact-diffs">
                    {legacyArtifacts.map((artifact) => (
                      <details className="inspector-artifact-card" key={artifact.file}>
                        <summary>
                          <FileCode2 size={13} aria-hidden="true" />
                          <span title={artifact.file}>{artifact.file}</span>
                          <small>
                            +{artifact.additions} −{artifact.deletions}
                          </small>
                          {canWrite && !disabled && (
                            <button
                              type="button"
                              className="inspector-hunk-quote"
                              title={t('将此文件差异引用到输入框以便追问')}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                onQuoteDiff(
                                  buildDiffQuoteText({
                                    path: artifact.file,
                                    snippet: artifact.patch,
                                  }),
                                );
                              }}
                            >
                              <Quote size={11} aria-hidden="true" />
                              <span>{t('引用')}</span>
                            </button>
                          )}
                        </summary>
                        <pre className="inspector-diff-pre">
                          <code>{artifact.patch}</code>
                        </pre>
                      </details>
                    ))}
                  </div>
                )}

                {!current.workflow && (current.brainTask || current.remote || current.localTask) && (
                  <TaskFilesPanel
                    key={`inspector:${current.key}`}
                    scope={current.brainTask ? 'brain' : current.remote ? 'remote' : 'local'}
                    taskID={current.brainTask?.id || current.remote?.id || current.localTask!.id}
                    revision={legacyFileRevision(current)}
                    nodeName={nodeName}
                    resultsOnly
                  />
                )}

                {deliverableCount === 0 && (
                  <p className="inspector-note">{t('暂无关联交付物或文件改动')}</p>
                )}
              </section>
            )}

            {reviewProject && data.user.owner ? (
              <InlineProjectChanges
                project={reviewProject}
                canWrite={canWrite}
                disabled={disabled}
                onOpenFullChanges={onOpenFullChanges}
                onQuoteDiff={onQuoteDiff}
                onAttachFileReference={onAttachFileReference}
              />
            ) : (
              <section className="inspector-section">
                <p className="inspector-note">{t('选择当前工作区后可原位预览 Git 改动。')}</p>
              </section>
            )}
          </div>
        )}

        {activeTab === 'cluster' && (
          <div className="inspector-pane inspector-pane-cluster">
            {data.user.owner ? (
              queuePanel
            ) : (
              <p className="muted">{t('本机队列由 Node 所有者管理。')}</p>
            )}
            {peers.length > 0 ? (
              <PairedMachines
                nodes={peers}
                items={all}
                connected={liveConnected}
                owner={data.user.owner}
                remark={onRemarkNode}
                remove={onRemoveNode}
              />
            ) : (
              <section className="inspector-section inspector-no-peers">
                <p className="inspector-note">{t('暂无已配对远端设备')}</p>
                {data.user.owner && (
                  <button type="button" className="mission-inline-link" onClick={onOpenNetwork}>
                    {t('管理设备')}
                  </button>
                )}
              </section>
            )}
          </div>
        )}
      </div>

      <footer className="rail-footer live-inspector-footer">
        <span className="live-inspector-sync">
          <i className={`status-dot ${connected ? 'online' : ''}`} />
          {connected ? t('状态实时同步') : t('正在恢复状态连接')}
        </span>
        <kbd>{primaryShortcut('J')}</kbd>
      </footer>
    </aside>
  );
}
