import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import {
  Check,
  File,
  FileCode2,
  FileDiff,
  GitBranch,
  ListOrdered,
  LoaderCircle,
  Maximize2,
  Network,
  RefreshCw,
  X,
} from 'lucide-react';
import { t } from '../shared/i18n.ts';
import type { ProjectChanges, ProjectDiff } from '../shared/project-changes.ts';
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
import { primaryShortcut } from './keyboard-platform';
import { legacyFileRevision } from './legacy-conversation-activity';
import { nodeDisplayName } from './node-mentions';
import { PairedMachines } from './paired-machines';
import { TaskFileRecovery, TaskFilesPanel } from './task-files';
import { TaskKnowledgeUsageSection } from './task-knowledge-usage';
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

function LiveTopologyCanvas({
  local,
  peers,
  journey,
  connected,
  hasConversation,
  owner,
  disabled,
  targetNodeID,
  targetMode,
  filterNodeID,
  nodeName,
  onRouteNode,
  onFilterNode,
}: {
  local: RivloomNode | null;
  peers: readonly RivloomNode[];
  journey: ConversationJourney | null;
  connected: boolean;
  hasConversation: boolean;
  owner: boolean;
  disabled: boolean;
  targetNodeID: string | null;
  targetMode: 'preferred' | 'locked';
  filterNodeID: string | null;
  nodeName: (id: string | null) => string;
  onRouteNode: (node: RivloomNode) => void;
  onFilterNode: (nodeID: string) => void;
}) {
  const gradientPrefix = `rv-topo-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const localID = local?.id || 'local';
  const localLabel = local ? nodeDisplayName(local) : t('本机');
  const localExecuting = !!journey?.devices.some((d) => d.id === localID && d.executing);

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
    remoteIDs.length === 1 ? [68] : remoteIDs.length === 2 ? [38, 98] : [26, 68, 110];
  const localX = remoteIDs.length ? 42 : 132;
  const localY = 68;
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
            d: bezierPath(localX + 34, localY, peerX - 34, py, dual ? -14 : 0),
            state: sendEdge.state === 'failed' ? 'failed' : active ? 'active' : sendEdge.state === 'complete' ? 'complete' : 'waiting',
            pulse: active,
          });
        }
        if (recvEdge) {
          const active = recvEdge.fresh && recvEdge.counts.active > 0 && connected;
          list.push({
            key: `recv:${peerID}`,
            peerID,
            d: bezierPath(peerX - 34, py, localX + 34, localY, dual ? 14 : 0),
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
          d: bezierPath(localX + 34, localY, peerX - 34, py, 0),
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
        d: bezierPath(localX + 34, localY, peerX - 34, py, 0),
        state: targeted ? 'target' : 'idle',
        pulse: false,
        dashed: targeted ? targetMode === 'preferred' : !online,
      });
    });

    return list;
  }, [remoteIDs, peerYPositions, journey, localID, connected, peers, hasConversation, targetNodeID, targetMode, localX]);

  const activeRouteCount = edges.filter((edge) => edge.pulse || edge.state === 'active').length;
  const onlinePeerCount = peers.filter((node) => node.online && node.channelReady).length;

  return (
    <div className="live-topology-card">
      <div className="live-topology-head">
        <span>{t('多设备实时拓扑')}</span>
        <small>
          {activeRouteCount > 0
            ? t('{{count}} 项传输', { count: journey?.connections.length || activeRouteCount })
            : t('{{count}} 台在线', { count: (connected ? 1 : 0) + onlinePeerCount })}
        </small>
      </div>
      <div className="live-topology-stage">
        <svg viewBox="0 0 264 136" className="live-topology-svg" role="img" aria-label={t('多设备实时拓扑')}>
          <defs>
            <linearGradient id={`${gradientPrefix}-pulse`} x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.1" />
              <stop offset="65%" stopColor="var(--accent)" stopOpacity="0.95" />
              <stop offset="100%" stopColor="#ffffff" stopOpacity="0.95" />
            </linearGradient>
          </defs>

          {edges.map((edge) => {
            const dimmed = !!filterNodeID && filterNodeID !== localID && filterNodeID !== edge.peerID;
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
            className={`topology-node is-local${localExecuting ? ' is-executing' : ''}${!hasConversation && targetNodeID === localID ? ' is-targeted' : ''}${hasConversation && filterNodeID === localID ? ' is-filtered' : ''}${hasConversation ? ' is-clickable' : ''}`}
            transform={`translate(${localX}, ${localY})`}
            role={hasConversation ? 'button' : undefined}
            tabIndex={hasConversation ? 0 : undefined}
            aria-pressed={hasConversation ? filterNodeID === localID : undefined}
            aria-label={hasConversation ? `${localLabel} · ${t('点击按此设备筛选轨迹')}` : localLabel}
            onClick={() => {
              if (hasConversation) onFilterNode(localID);
            }}
            onKeyDown={(event) => {
              if (!hasConversation) return;
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onFilterNode(localID);
              }
            }}
          >
            {localExecuting && <circle className="topology-node-halo" r="26" />}
            <rect x="-34" y="-16" width="68" height="32" rx="8" className="topology-node-box" />
            <circle
              cx={localLabel === t('本机') ? -22 : -25}
              cy={localLabel === t('本机') ? 0 : -5.5}
              r="2.5"
              className={`topology-node-dot${connected ? ' is-online' : ''}`}
            />
            {localLabel !== t('本机') && (
              <text x="-19" y="-2.5" textAnchor="start" className="topology-node-role">
                {t('本机')}
              </text>
            )}
            <text
              x={localLabel === t('本机') ? 4 : 0}
              y={localLabel === t('本机') ? 3.5 : 9.5}
              textAnchor="middle"
              className="topology-node-name"
            >
              {shortLabel(localLabel, 11)}
            </text>
          </g>

          {remoteIDs.map((peerID, index) => {
            const py = peerYPositions[index];
            const peer = peers.find((node) => node.id === peerID) || null;
            const online = !!peer && peer.online && peer.channelReady && connected;
            const executing = !!journey?.devices.some((d) => d.id === peerID && d.executing);
            const targeted = !hasConversation && targetNodeID === peerID;
            const filtered = hasConversation && filterNodeID === peerID;
            const interactive = hasConversation || (owner && !disabled && !!peer);
            const name = peer ? nodeDisplayName(peer) : nodeName(peerID);
            return (
              <g
                key={peerID}
                data-topology-node={peerID}
                className={`topology-node is-peer${executing ? ' is-executing' : ''}${targeted ? ' is-targeted' : ''}${filtered ? ' is-filtered' : ''}${!online ? ' is-offline' : ''}${interactive ? ' is-clickable' : ''}`}
                transform={`translate(${peerX}, ${py})`}
                role={interactive ? 'button' : undefined}
                tabIndex={interactive ? 0 : undefined}
                aria-pressed={hasConversation ? filtered : undefined}
                aria-label={
                  hasConversation
                    ? `${name} · ${t('点击按此设备筛选轨迹')}`
                    : interactive
                      ? `${name} · ${t('点击设为目标')}`
                      : name
                }
                onClick={() => {
                  if (hasConversation) onFilterNode(peerID);
                  else if (interactive && peer) onRouteNode(peer);
                }}
                onKeyDown={(event) => {
                  if (!interactive) return;
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    if (hasConversation) onFilterNode(peerID);
                    else if (peer) onRouteNode(peer);
                  }
                }}
              >
                {executing && <circle className="topology-node-halo" r="24" />}
                <rect x="-34" y="-14" width="68" height="28" rx="8" className="topology-node-box" />
                <circle
                  cx="-25"
                  cy="0"
                  r="2.5"
                  className={`topology-node-dot${online ? ' is-online' : ''}`}
                />
                <text x="-19" y="3.5" textAnchor="start" className="topology-node-name">
                  {shortLabel(name, 10)}
                </text>
              </g>
            );
          })}
        </svg>
        {!remoteIDs.length && (
          <p className="live-topology-caption">{t('本机中心')}</p>
        )}
      </div>
    </div>
  );
}

function InlineProjectChanges({
  project,
  onOpenFullChanges,
}: {
  project: Project;
  onOpenFullChanges: (project: Project) => void;
}) {
  const [snapshot, setSnapshot] = useState<ProjectChanges | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [area, setArea] = useState<ProjectDiff['area']>('working');
  const [diff, setDiff] = useState<ProjectDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    setDiff(null);
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

  const file = snapshot?.files.find((entry) => entry.path === selected);
  const staged = !!file && !file.untracked && file.index !== ' ';
  const working = !!file && (file.untracked || file.worktree !== ' ');
  const effectiveArea = area === 'staged' && staged ? 'staged' : working ? 'working' : 'staged';

  useEffect(() => {
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
          <ul className="inspector-change-files" aria-label={t('改动文件')}>
            {snapshot.files.slice(0, 30).map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  className={selected === entry.path ? 'active' : ''}
                  aria-current={selected === entry.path ? 'true' : undefined}
                  title={entry.path}
                  onClick={() => setSelected(entry.path)}
                >
                  <File size={12} aria-hidden="true" />
                  <span>{entry.path}</span>
                  <code>{`${entry.index}${entry.worktree}`.trim() || '?'}</code>
                </button>
              </li>
            ))}
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
              {diffLoading ? (
                <p className="inspector-note" role="status">
                  {t('正在读取差异…')}
                </p>
              ) : diffError ? (
                <p className="inspector-note is-error" role="alert">
                  {t('读取差异失败，请刷新后重试。')}
                </p>
              ) : diff?.state === 'ready' && diff.text ? (
                <pre className="inspector-diff-pre" tabIndex={0}>
                  <code>
                    {diff.text
                      .split('\n')
                      .slice(0, 140)
                      .map((line, index) => (
                        <span
                          key={index}
                          className={
                            diff.kind === 'patch'
                              ? line.startsWith('+') && !line.startsWith('+++')
                                ? 'added'
                                : line.startsWith('-') && !line.startsWith('---')
                                  ? 'removed'
                                  : line.startsWith('@@')
                                    ? 'hunk'
                                    : undefined
                              : undefined
                          }
                        >
                          {line || ' '}
                        </span>
                      ))}
                  </code>
                </pre>
              ) : (
                <p className="inspector-note">
                  {t('此范围没有文本差异，可能只有文件属性发生变化。')}
                </p>
              )}
            </div>
          )}
        </>
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
  queueCount,
  queuePanel,
  reviewProject,
  targetNodeID,
  targetMode,
  targetName,
  disabled,
  nodeName,
  onRemarkNode,
  onRemoveNode,
  onRouteNode,
  onOpenFullChanges,
  onOpenNetwork,
  onOpenKnowledgeReads,
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
  queueCount: number;
  queuePanel: ReactNode;
  reviewProject: Project | undefined;
  targetNodeID: string | null;
  targetMode: 'preferred' | 'locked';
  targetName: string;
  disabled: boolean;
  nodeName: (id: string | null) => string;
  onRemarkNode: (id: string) => void;
  onRemoveNode: (id: string) => void;
  onRouteNode: (node: RivloomNode) => void;
  onOpenFullChanges: (project: Project) => void;
  onOpenNetwork: () => void;
  onOpenKnowledgeReads?: () => void;
  inert?: boolean;
}) {
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

  const workflowDeliveryGroups = useMemo(() => {
    if (!current?.workflow) return [];
    const roundSteps = (current.workflow.rounds || []).flatMap((round) =>
      round.planVersion ? round.steps : [round.planner],
    );
    const currentSteps = current.workflow.planVersion
      ? current.workflow.steps
      : [current.workflow.planner];
    const seen = new Set<string>();
    return [...currentSteps, ...roundSteps].flatMap((step) => {
      const attempt = step.attempts.at(-1);
      if (!attempt?.outputFiles.length) return [];
      const key = `${attempt.kind}:${attempt.executionID}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [
        {
          key,
          stepTitle: step.title,
          scope: attempt.kind,
          taskID: attempt.executionID,
          outputFiles: attempt.outputFiles,
        },
      ];
    });
  }, [current?.workflow]);

  const legacyArtifacts = current?.localTask?.artifacts || current?.remote?.remoteArtifacts || [];
  const deliverableCount =
    workflowDeliveryGroups.reduce((sum, group) => sum + group.outputFiles.length, 0) +
    legacyArtifacts.length;
  const activeTabIndex = activeTab === 'topology' ? 0 : activeTab === 'artifacts' ? 1 : 2;
  const [filterNodeID, setFilterNodeID] = useState<string | null>(null);
  useEffect(() => {
    setFilterNodeID(null);
  }, [current?.key]);

  const localID = local?.id || 'local';
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
              owner={data.user.owner}
              disabled={disabled}
              targetNodeID={targetNodeID}
              targetMode={targetMode}
              filterNodeID={filterNodeID}
              nodeName={nodeName}
              onRouteNode={onRouteNode}
              onFilterNode={(nodeID) => setFilterNodeID((prev) => (prev === nodeID ? null : nodeID))}
            />

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

                {workflowDeliveryGroups.length > 0 && (
                  <div className="inspector-deliverable-groups">
                    {workflowDeliveryGroups.map((group) => (
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
                onOpenFullChanges={onOpenFullChanges}
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
