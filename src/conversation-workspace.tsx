import { t, systemText, language } from '../shared/i18n.ts';
import { executionSummaryText, executionStateText } from './system-display';
import { TaskFilePicker, TaskFilesPanel } from './task-files';
import { LanguageSwitcher } from './language-switcher';
import { draftFilesReady } from './task-file-upload';
import { CopyButton } from './copy-button';
import { AboutRivloom, AboutRivloomEntry, useRivloomVersion } from './about-rivloom';
import { ConversationFilterButton } from './conversation-filter-button';
import { ConversationTrash } from './conversation-trash';
import { conversationDirectory, groupConversationHistory, historyCanTrash } from '../shared/conversation-history';
import { directoryDisplayName } from '../shared/directory-aliases';
import { DirectoryAliasEditor } from './directory-alias-editor';
import { HistoryDirectoryHeading } from './history-directory-heading';
import { ConversationRenameEditor } from './conversation-rename-editor';
import { ContextMenu, useContextMenu } from './context-menu';
import { PairedMachines } from './paired-machines';
import { WorkflowView } from './workflow-view';
import { MessageMarkdown } from './message-markdown';
import { latestDrafts, encodeDrafts, draftStorageKey } from './draft-storage';
import { ResourceDiscovery } from './resource-discovery';
import type { Workflow } from '../shared/workflows';
import { ResizableWorkspace } from './resizable-workspace';
import {
  filterConversations,
  conversationStatusGroup,
  type ConversationStatusFilter,
  type ConversationSourceFilter,
} from './conversation-filters';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { reuseJson } from './desktop-refresh';
import {
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  Plus,
  Search,
  Settings2,
  Network,
  ChevronDown,
  MessageSquare,
  Square,
  Play,
  Check,
  FolderOpen,
  X,
  LoaderCircle,
  ListOrdered,
  PanelLeft,
  FileCode2,
  Bot,
  ShieldCheck,
  ChevronRight,
  AtSign,
  Pause,
  Inbox,
  Trash2,
  Pencil,
  Pin,
  PinOff,
  MoreHorizontal,
  Activity as DiagnosticIcon,
} from 'lucide-react';
import { api, ApiError } from './api';
import type { QueueConfirmation } from '../shared/queue-backlog';
import { desktop, chooseProjectDirectory } from './desktop';
import { NodeNetworkView, ExecutionPolicyCard } from './node-network';
import { ModelSettingsView } from './model-settings';
import { ExecutionConcurrencySettings } from './execution-concurrency-settings';
import { TaskAttentionView, useTaskAttention } from './task-attention-view';
import { NodeDiagnosticsView } from './node-diagnostics';
import { NodeAvatar, NodeProfileEditor, NodeRemarkEditor } from './node-avatar';
import {
  activeNodeMention,
  boundNodeMentionMode,
  isNodeMentionComposing,
  nodeCapabilitySummary,
  nodeDisplayName,
  recentNodeMentions,
  nodeMentionPrefix,
  replaceBoundNodeMention,
  type ActiveNodeMention,
} from './node-mentions';
import {
  clearSubmittedDraft,
  conversationCreationNeedsModel,
  conversationInputUsage,
  createWorkflowDraft,
  createdConversationKey,
  prepareConversationRequest,
  updateConversationDraft,
  type ConversationDraft,
  type ConversationRouting,
} from './conversation-drafts';
import { Button, Field, Modal, Wordmark } from './ui';
import {
  conversations,
  conversationState,
  conversationIsRunning,
  executionQueueEntries,
  pairedNodes,
  showNetworkRail,
  type Conversation,
} from './conversations';
import type { NodeQueueAction, NodeQueueItem, NodeQueueSnapshot } from '../shared/node-queue';
import { queueReasonLabel, taskReceiptView } from './task-receipts';
import {
  activeStates,
  approvalModeLabels,
  type Activity,
  type ApprovalMode,
  type Bootstrap,
  type Message,
  type Project,
  type RemoteTaskControlAction,
  type Task,
} from '../shared/types';

const dateLabel = (value: string) =>
  new Date(value).toLocaleString(language(), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

function queueConversation(entry: NodeQueueItem, items: Conversation[]) {
  const source = entry.source;
  return items.find((item) => item.workflow
    ? [item.workflow.planner, ...item.workflow.steps].some((step) => step.attempts.some((attempt) =>
      attempt.executionID === (source.kind === 'local' ? source.taskID : source.remoteTaskID))) : source.kind === 'local'
      ? item.localTask?.id === source.taskID
      : item.remote?.id === source.remoteTaskID ||
        item.attempts.some((attempt) => attempt.id === source.remoteTaskID),
  );
}

function QueuePanel({
  remoteConcurrency,
  configure,
  snapshot,
  tasks,
  items,
  nodeName,
  busy,
  error,
  open,
  control,
  pause,
  retry,
}: {
  remoteConcurrency: number;
  configure: () => void;
  snapshot: NodeQueueSnapshot | null;
  tasks: Task[];
  items: Conversation[];
  nodeName: (id: string | null) => string;
  busy: boolean;
  error: string;
  open: (item: Conversation) => void;
  control: (entry: NodeQueueItem, action: NodeQueueAction) => void;
  pause: (paused: boolean) => void;
  retry?: () => void;
}) {
  const entries = executionQueueEntries(snapshot?.entries || [], tasks);
  return (
    <section className="node-queue">
      <div className="rail-heading">
        <ListOrdered size={17} />
        <h2>{t('本机执行队列')}</h2>
        <span>{snapshot ? entries.length : '—'}</span>
      </div>
      <button type="button" className="queue-concurrency-control" onClick={configure}>
        <span><small>{t('当前并发')}</small><strong>{t('本机不限 · 其他机器 {{count}} 项', { count: remoteConcurrency })}</strong></span>
        <span className="queue-concurrency-edit"><Settings2 size={13} />{t('修改')}</span>
      </button>
      <div className="queue-toolbar">
        <small>
          {error
            ? t('正在确认队列状态')
            : snapshot?.paused
              ? t('后续启动已暂停')
              : t('按来源分别排队执行')}
        </small>
        <button
          type="button"
          disabled={busy || !snapshot || !!error}
          onClick={() => pause(!snapshot?.paused)}
        >
          {snapshot?.paused ? <Play size={12} /> : <Pause size={12} />}
          {snapshot?.paused ? t('恢复队列') : t('暂停队列')}
        </button>
      </div>
      {error && (
        <p className="queue-sync-error" role="status">
          {systemText(error)}
        </p>
      )}
      {retry && (
        <p className="queue-pending-operation" role="status">
          {t('上次队列操作结果未确认。')}
          <button type="button" onClick={retry}>
            {t('重试确认')}
          </button>
        </p>
      )}
      <div className="queue-list">
        {entries.map((entry) => {
          const executing = entry.state === 'admitted' || entry.state === 'ended';
          const item = queueConversation(entry, items);
          const incoming = item?.incoming ?? entry.source.kind === 'remote';
          const title = item?.title || t('正在同步会话');
          const reason = queueReasonLabel(entry.blockReason || entry.endReason);
          const state =
            entry.state === 'held'
              ? t('已暂缓')
              : executing
                ? item
                  ? conversationState(item)
                  : t('已获执行槽')
                : reason ||
                  (entry.position
                    ? t('当前候选第 {{value1}} 位', { value1: entry.position })
                    : t('等待执行条件'));
          return (
            <article className={`queue-card ${incoming ? 'incoming' : 'own'}`} key={entry.id}>
              <button
                className="queue-item"
                disabled={!item}
                onClick={() => item && open(item)}
                title={title}
              >
                <span className="queue-number">
                  {executing ? (
                    <ShieldCheck size={14} />
                  ) : entry.state === 'held' ? (
                    <Pause size={13} />
                  ) : (
                    (entry.position ?? '—')
                  )}
                </span>
                <span>
                  <strong>{title}</strong>
                  <small>
                    {incoming
                      ? nodeName(
                          item?.sourceNodeID ||
                            (entry.source.kind === 'remote' ? entry.source.ownerNodeID : null),
                        )
                      : t('自己发起')}{' '}
                    · {state}
                  </small>
                </span>
                <ChevronRight size={14} />
              </button>
              {['waiting', 'held'].includes(entry.state) && (
                <div
                  className="queue-controls"
                  aria-label={t('{{value1}} 的队列操作', { value1: title })}
                >
                  <button
                    type="button"
                    aria-label={t('上移 {{value1}}', { value1: title })}
                    title={t('上移')}
                    disabled={busy || !!error}
                    onClick={() => control(entry, 'up')}
                  >
                    <ArrowUp size={12} />
                  </button>
                  <button
                    type="button"
                    aria-label={t('下移 {{value1}}', { value1: title })}
                    title={t('下移')}
                    disabled={busy || !!error}
                    onClick={() => control(entry, 'down')}
                  >
                    <ArrowDown size={12} />
                  </button>
                  <button
                    type="button"
                    disabled={busy || !!error}
                    onClick={() => control(entry, entry.state === 'held' ? 'resume' : 'hold')}
                  >
                    {entry.state === 'held' ? <Play size={12} /> : <Pause size={12} />}
                    {entry.state === 'held' ? t('恢复') : t('暂缓')}
                  </button>
                  <button
                    type="button"
                    disabled={busy || !!error}
                    onClick={() => control(entry, 'reject')}
                  >
                    <X size={12} />
                    {t('拒绝')}
                  </button>
                </div>
              )}
              {executing && (
                <p className="queue-protected">
                  {item?.localTask?.state === 'accepted' ||
                  item?.remote?.executionState === 'accepted' ||
                  item?.brainTask?.status === 'completed'
                    ? t('执行已完成 · 正在同步队列')
                    : t('执行槽已保留 · 在会话中继续处理')}
                </p>
              )}
            </article>
          );
        })}
        {!entries.length && (
          <div className="rail-empty">
            <Check size={20} />
            <span>{snapshot ? t('当前没有等待执行的会话') : t('正在读取本机队列')}</span>
          </div>
        )}
      </div>
    </section>
  );
}

// locale participates in memo invalidation because the translated labels are getters.
const HistoryRow = memo(function HistoryRow({
  item,
  selected,
  source,
  icon,
  open,
  remove,
  canRemove,
  rename,
  pin,
  busy,
}: {
  item: Conversation;
  selected: boolean;
  source?: string;
  icon?: string;
  open: (item: Conversation) => void;
  remove: (item: Conversation) => void;
  canRemove: boolean;
  rename: (item: Conversation) => void;
  pin: (item: Conversation) => void;
  busy: boolean;
  locale: string;
}) {
  const menu = useContextMenu();
  const state = conversationState(item);
  const group = conversationStatusGroup(item);
  const origin = item.incoming ? source : t('自己发起');
  const label = [item.title, origin, state, item.pinned ? t('已置顶') : ''].filter(Boolean).join(' · ');
  return (
    <div className="history-row" onContextMenu={menu.context} onKeyDown={menu.keyboard}>
    <button
      aria-current={selected ? 'page' : undefined}
      aria-label={label}
      className={`conversation-item ${item.incoming ? 'incoming' : 'own'} ${selected ? 'selected' : ''}`}
      onClick={() => open(item)}
      title={label}
    >
      <span className="conversation-item-origin" aria-hidden="true">
        {item.incoming ? <NodeAvatar small icon={icon} /> : <MessageSquare size={15} />}
      </span>
      <strong>{item.title}</strong>
      {item.pinned && <Pin className="conversation-pinned" size={11} aria-label={t('已置顶')} />}
      {group !== 'completed' && (
        <span
          className={`conversation-item-state ${group} ${conversationIsRunning(item) ? 'is-running' : ''}`}
          aria-hidden="true"
        >
          <small>{state}</small>
        </span>
      )}
    </button>
    <button type="button" className="context-more icon-button" aria-label={t('会话操作：{{title}}', { title: item.title })} title={t('更多操作')} {...menu.trigger}><MoreHorizontal size={15} /></button>
    <button type="button" className="history-delete icon-button" disabled={!canRemove}
      aria-label={t('删除会话：{{title}}', { title: item.title })}
      title={canRemove ? t('移入回收站') : t('请先停止会话并等待处理完成')}
      onClick={() => remove(item)}><Trash2 size={14} /></button>
    <ContextMenu menu={menu} label={t('会话操作')} actions={[
      { id: 'rename', label: t('重命名'), icon: <Pencil />, disabled: busy, select: () => rename(item) },
      { id: 'pin', label: item.pinned ? t('取消置顶') : t('置顶'), icon: item.pinned ? <PinOff /> : <Pin />, disabled: busy, select: () => pin(item) },
      { id: 'trash', label: t('移入回收站'), icon: <Trash2 />, disabled: !canRemove, danger: true,
        hint: !canRemove ? t('请先停止会话并等待处理完成') : undefined, select: () => remove(item) },
    ]} />
    </div>
  );
});

const Transcript = memo(function Transcript({
  item,
  source,
}: {
  item: Conversation;
  source: string;
  locale: string;
}) {
  const task = item.localTask;
  const messages = task?.messages || [];
  // The first engine prompt includes the task envelope. Show the user's requirement instead.
  const firstUser = messages.find((message) => message.role === 'user');
  const displayed: Message[] = messages.length
    ? messages
    : [
        {
          id: 'requirement',
          role: 'user',
          text: item.description,
          tools: [],
        },
      ];
  const summary = executionSummaryText(
    item.brainTask?.executionSummary || item.remote?.executionSummary,
    item.brainTask?.status || item.remote?.executionState,
  );
  return (
    <>
      {displayed.map((message) => {
        const text =
          message.id === firstUser?.id ? item.description.split('\n\n补充要求：')[0] : message.text;
        return (
          <article className={`chat-message ${message.role}`} key={message.id} aria-label={message.role === 'user' ? source : undefined}>
            {message.role === 'assistant' ? <div className="chat-message-byline">
              <Bot size={17} />
              <strong>Rivloom</strong>
              {text.trim() && <CopyButton text={text} label={t('复制这条消息')} iconOnly className="message-copy" />}
            </div> : text.trim() && <CopyButton text={text} label={t('复制这条消息')} iconOnly className="message-copy" />}
            {message.text && (message.role === 'user' ? <div className="chat-message-text">{text}</div> : <MessageMarkdown text={text} />)}
            {message.tools.map((tool, index) => (
              <details className="chat-tool" key={index}>
                <summary>
                  <FileCode2 size={15} />
                  <span>{tool.title || tool.name}</span>
                  <small>{executionStateText(tool.status)}</small>
                </summary>
                <pre>{tool.output || t('等待执行结果…')}</pre>
                {tool.output?.trim() && (
                  <div className="tool-copy">
                    <CopyButton text={tool.output} label={t('复制工具输出')} iconOnly className="message-copy" />
                  </div>
                )}
              </details>
            ))}
          </article>
        );
      })}
      {!task && summary && (
        <article className="chat-message assistant">
          <div className="chat-message-byline">
            <Bot size={17} />
            <strong>{t('执行结果')}</strong>
            <CopyButton text={summary} label={t('复制执行结果')} iconOnly className="message-copy" />
          </div>
          <MessageMarkdown text={summary} />
        </article>
      )}
      {task && activeStates.includes(task.state) && (
        <div className="chat-progress" role="status">
          <LoaderCircle size={15} className="spin" />
          {task.state === 'running' ? t('正在处理…') : conversationState(item)}
        </div>
      )}
    </>
  );
});

export function ConversationWorkspace({
  data,
  refresh,
  connected,
  connectionError,
}: {
  data: Bootstrap;
  refresh: () => Promise<void>;
  connected: boolean;
  connectionError: string;
}) {
  const rivloomVersion = useRivloomVersion();
  const [view, setView] = useState<'chat' | 'network' | 'models' | 'attention' | 'diagnostics' | 'trash'>(
    'chat',
  );
  const [diagnosticTarget, setDiagnosticTarget] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef(selected);
  const seenSelected = useRef<string | null>(null);
  selectedRef.current = selected;
  const [search, setSearch] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [historyAction, setHistoryAction] = useState<{ action: 'trash' | 'purge' | 'empty'; key?: string; title?: string } | null>(null);
  const [aliasDirectory, setAliasDirectory] = useState<{ key: string; label: string; name: string } | null>(null);
  const [renameConversation, setRenameConversation] = useState<{ key: string; title: string } | null>(null);
  const [statusFilter, setStatusFilter] = useState<ConversationStatusFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<ConversationSourceFilter>('all');
  const storageKey = draftStorageKey(data.user.id, data.network.local?.id || 'local');
  const [recovered] = useState(() => { try { return latestDrafts(localStorage.getItem(storageKey), data.conversationDrafts); }
    catch { return latestDrafts(null, data.conversationDrafts); } });
  const draftClock = useRef(recovered.savedAt || 0);
  const [drafts, setDrafts] = useState<Record<string, ConversationDraft>>(recovered.drafts);
  const [draftSaveError, setDraftSaveError] = useState(false);
  const emptyDraft = useRef(createWorkflowDraft());
  const [busy, setBusy] = useState(false);
  const operation = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [modal, setModal] = useState<'profile' | 'folder' | 'queue' | 'about' | 'concurrency' | null>(null);
  const [queueSnapshot, setQueueSnapshot] = useState<NodeQueueSnapshot | null>(null);
  const [queueError, setQueueError] = useState('');
  const [rejectQueueEntry, setRejectQueueEntry] = useState<NodeQueueItem | null>(null);
  const [pendingQueueRequest, setPendingQueueRequest] = useState<{
    path: string;
    body: Record<string, unknown> & { operationID: string };
  } | null>(null);
  const [folderPath, setFolderPath] = useState('');
  const [folderName, setFolderName] = useState('');
  const [projectID, setProjectID] = useState(
    recovered.settings?.projectID ?? data.executionPolicy.projectID ?? data.projects[0]?.id ?? '',
  );
  const [model, setModel] = useState(recovered.settings?.model ?? data.defaultModel);
  const [approvalChoice, setApprovalChoice] = useState<ApprovalMode | 'default'>(recovered.settings?.approvalChoice || 'default');
  const mode = approvalChoice === 'default' ? data.executionPolicy.approvalMode : approvalChoice;
  const [criteria, setCriteria] = useState(recovered.settings?.criteria || '');
  useEffect(() => {
    draftClock.current = Math.max(Date.now(), draftClock.current + 1);
    const value = encodeDrafts({ drafts, savedAt: draftClock.current, settings: { projectID, model, approvalChoice, criteria } });
    try { localStorage.setItem(storageKey, value); } catch { /* The service below also persists drafts independently of the browser origin. */ }
    let active = true;
    const save = () => void api('/ui/drafts', { value }).then(() => { if (active) setDraftSaveError(false); }).catch(() => { if (active) setDraftSaveError(true); });
    const timer = setTimeout(save, 350);
    const flush = () => {
      void fetch('/api/ui/drafts', { method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'Content-Type': 'application/json', 'X-Rivloom-Request': '1' }, body: JSON.stringify({ value }) }).catch(() => undefined);
    };
    window.addEventListener('pagehide', flush); window.addEventListener('online', save);
    return () => { active = false; clearTimeout(timer); window.removeEventListener('pagehide', flush); window.removeEventListener('online', save); };
  }, [storageKey, drafts, projectID, model, approvalChoice, criteria, connected]);
  const [options, setOptions] = useState(false);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [mention, setMention] = useState<ActiveNodeMention | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [deleteNodeID, setDeleteNodeID] = useState<string | null>(null);
  const [queueConfirmation, setQueueConfirmation] = useState<
    (QueueConfirmation & { title: string }) | null
  >(null);
  const queueAnswer = useRef<((answer: boolean) => void) | null>(null);
  useEffect(
    () => () => {
      queueAnswer.current?.(false);
    },
    [],
  );
  function answerQueue(answer: boolean) {
    const resolve = queueAnswer.current;
    queueAnswer.current = null;
    setQueueConfirmation(null);
    resolve?.(answer);
  }
  async function createTask<T>(path: string, input: Record<string, unknown>): Promise<T | null> {
    const body: Record<string, unknown> = {
      ...input,
      requestID: input.requestID || crypto.randomUUID(),
    };
    let confirmedFor: string | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await api<T>(
          path,
          { ...body, ...(confirmedFor ? { queueConfirmedFor: confirmedFor } : {}) },
          { timeoutMilliseconds: 15_000 },
        );
      } catch (error) {
        if (!(error instanceof ApiError) || !error.queueConfirmation) throw error;
        const confirmation = error.queueConfirmation;
        const confirmed = await new Promise<boolean>((resolve) => {
          queueAnswer.current = resolve;
          setQueueConfirmation({ ...confirmation, title: String(body.title || '') });
        });
        if (!confirmed) return null;
        confirmedFor = confirmation.nodeID;
      }
    }
    throw new Error(t('目标机器发生变化，请检查队列后重新提交。'));
  }
  const [remarkNodeID, setRemarkNodeID] = useState<string | null>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const scrollPinned = useRef(true);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const all = useMemo(
    () => conversations(data),
    [data.tasks, data.workflows, data.network.local?.id, data.network.remoteTasks, data.network.brainTasks, data.conversationPreferences],
  );
  function openAttention(key: string) {
    if (key === 'attention') {
      setView('attention');
      setMobileSidebar(false);
      return;
    }
    const item = all.find((candidate) => candidate.key === key);
    if (item) open(item);
    else {
      setView('attention');
      setNotice(t('该通知对应的任务暂未出现在当前列表，请刷新待办。'));
    }
  }
  const attention = useTaskAttention(
    `${data.network.local?.id || 'local'}:${data.user.id}`,
    openAttention,
  );
  const current = all.find((item) => item.key === selected);
  useEffect(() => {
    const available = new Set(['new', ...all.map((item) => item.key), ...(data.conversationTrash || []).map((item) => item.key)]);
    setDrafts((previous) => Object.keys(previous).every((key) => available.has(key)) ? previous :
      Object.fromEntries(Object.entries(previous).filter(([key]) => available.has(key))));
  }, [all, data.conversationTrash]);
  const task = current?.localTask;
  const remote = current?.remote;
  const draftKey = selected || 'new';
  const draftState = drafts[draftKey] || emptyDraft.current;
  const draft = draftState.text;
  const inputUsage = conversationInputUsage(draftState, !!current);
  const changeDraft = (change: Partial<Pick<ConversationDraft, 'text' | 'routing'>>) =>
    setDrafts((previous) => ({
      ...previous,
      [draftKey]: updateConversationDraft(previous[draftKey] || emptyDraft.current, change),
    }));
  const setDraft = (text: string) => changeDraft({ text });
  const setRouting = (routing: ConversationRouting) => changeDraft({ routing });
  const workflowTarget = draftState.routing.kind === 'workflow' ? draftState.routing.target :
    draftState.routing.kind === 'node' ? { mode: 'preferred' as const, nodeID: draftState.routing.nodeID } : { mode: 'automatic' as const };
  const scope = workflowTarget.mode === 'automatic' ? 'automatic' : 'local';
  const setScope = (kind: 'local' | 'automatic') => setRouting({ kind: 'workflow', target:
    kind === 'local' && data.network.local ? { mode: 'locked', nodeID: data.network.local.id } : { mode: 'automatic' } });
  const targetNodeID = workflowTarget.mode === 'automatic' ? null : workflowTarget.nodeID;
  const targetMode = workflowTarget.mode === 'locked' ? 'locked' : 'preferred';
  const local = data.network.local;
  const peers = useMemo(() => pairedNodes(data), [data.network.paired, data.network.nearby]);
  const targetNode = [local, ...peers].find((node) => node?.id === targetNodeID) || null;
  const targetName = targetNode
    ? nodeDisplayName(targetNode)
    : targetNodeID
      ? `${'name' in draftState.routing ? draftState.routing.name || '' : ''} · ${targetNodeID.slice(0, 6)}`
      : '';
  const remarkNode = peers.find((node) => node.id === remarkNodeID) || null;
  const mentionNodes = mention ? recentNodeMentions(peers, mention.query).slice(0, 8) : [];
  const rail = showNetworkRail(peers);
  const currentQueueEntry = current
    ? queueSnapshot?.entries.find((entry) => queueConversation(entry, all)?.key === current.key)
    : undefined;
  const receiptPeer =
    remote?.direction === 'outgoing' ? peers.find((node) => node.id === remote.targetNodeID) : null;
  const currentReceipt = current
    && !current.workflow ? taskReceiptView(current, {
        connected:
          connected &&
          !connectionError &&
          (remote?.direction !== 'outgoing' || !!(receiptPeer?.online && receiptPeer.channelReady)),
        queueEntry: currentQueueEntry,
        queueConfirmed: !queueError,
      })
    : null;
  const nodes = useMemo(
    () => [...(local ? [local] : []), ...peers, ...data.network.nearby],
    [local, peers, data.network.nearby],
  );
  const locale = language();
  const nodeName = useCallback(
    (id: string | null) => {
      const node = nodes.find((candidate) => candidate.id === id);
      return node ? nodeDisplayName(node) : id ? `Node ${id.slice(0, 6)}` : t('本机');
    },
    [nodes, locale],
  );
  const sourceName = current?.incoming ? nodeName(current.sourceNodeID) : t('你');
  const visible = useMemo(
    () =>
      filterConversations(
        all,
        { status: statusFilter, source: sourceFilter, query: '' },
        nodeName,
      ).filter((item) => {
        const directory = conversationDirectory(item, data);
        return !search.trim() || `${directory.label} ${directoryDisplayName(directory, data.directoryAliases)}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()) ||
          filterConversations([item], { status: 'all', source: 'all', query: search }, nodeName).length > 0;
      }),
    [all, statusFilter, sourceFilter, search, nodeName, data.projects, data.network, data.directoryAliases],
  );
  const historyGroups = groupConversationHistory(visible, data, data.directoryAliases);
  const removeHistory = useCallback((item: Conversation) => setHistoryAction({ action: 'trash', key: item.key, title: item.title }), []);
  const renameHistory = useCallback((item: Conversation) => { setError(''); setRenameConversation({ key: item.key, title: item.title }); }, []);
  const pinHistory = (item: Conversation) => void perform(() => api('/ui/conversation', { key: item.key, pinned: !item.pinned }));
  const filtering = !!search.trim() || statusFilter !== 'all' || sourceFilter !== 'all';
  function clearFilters() {
    setSearch('');
    setStatusFilter('all');
    setSourceFilter('all');
  }
  const canRemoteControl =
    !!remote && remote.direction === 'outgoing' && remote.executionSequence > 0 && data.user.owner;
  const canWriteLocal = !!task && [task.creatorID, task.assigneeID].includes(data.user.id);
  const finished = !!current && conversationStatusGroup(current) === 'completed';
  const queueRejected =
    currentQueueEntry?.endReason?.code === 'rejected' ||
    ((current?.brainTask?.queueReceipt || remote?.queueReceipt)?.state === 'rejected' &&
      !task?.sessionID &&
      !remote?.executionSequence);
  const waitingForRemoteSession =
    remote?.direction === 'outgoing' &&
    remote.executionSequence === 0 &&
    ['pending', 'accepted'].includes(remote.status) &&
    !queueRejected;
  const awaitingCreatedConversation = !!selected && !current;
  const canWrite =
    (!current && !awaitingCreatedConversation) ||
    (!!current?.workflow && current.workflow.creatorID === data.user.id) ||
    (!finished && !queueRejected && (canWriteLocal || canRemoteControl));
  const approvals = task?.approvals || remote?.remoteApprovals || [];
  const questions = task?.questions || remote?.remoteQuestions || [];
  const artifacts = task?.artifacts || remote?.remoteArtifacts || [];
  const running = task
    ? activeStates.includes(task.state) || task.state === 'interrupted'
    : !!remote &&
      remote.executionState !== 'not_started' &&
      activeStates.includes(remote.executionState);
  const canApprove = task ? task.approverID === data.user.id : canRemoteControl;

  useEffect(() => {
    if (!model && data.defaultModel) setModel(data.defaultModel);
    if (!current && scope === 'local' && !projectID && data.projects.length)
      setProjectID(data.executionPolicy.projectID || data.projects[0].id);
  }, [
    data.defaultModel,
    data.projects,
    data.executionPolicy.projectID,
    model,
    projectID,
    scope,
    current?.key,
  ]);

  useEffect(() => {
    if (!data.user.owner) {
      setQueueSnapshot(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const snapshot = await api<NodeQueueSnapshot>('/node-queue');
        if (!cancelled) {
          setQueueSnapshot((previous) =>
            previous && previous.version > snapshot.version
              ? previous
              : reuseJson(previous, snapshot),
          );
          setQueueError('');
        }
      } catch (e) {
        if (!cancelled) setQueueError((e as Error).message);
      } finally {
        if (!cancelled) timer = setTimeout(() => void poll(), 2500);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [data.user.owner, local?.id]);

  useEffect(() => {
    let cancelled = false;
    setActivities([]);
    if (task)
      void api<{ activities: Activity[] }>(`/tasks/${task.id}`)
        .then((value) => {
          if (!cancelled) setActivities(value.activities);
        })
        .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [task?.id, task?.version]);
  useLayoutEffect(() => {
    scrollPinned.current = true;
    setAwayFromLatest(false);
  }, [selected, view]);
  useLayoutEffect(() => {
    // Follow message updates before ResizeObserver can reinterpret their added height as scrolling.
    if (transcript.current && scrollPinned.current)
      transcript.current.scrollTop = current?.workflow && !current.workflow.rounds?.length && !current.workflow.messages?.length ? 0 : transcript.current.scrollHeight;
    updateScrollPosition();
  }, [
    selected,
    view,
    task?.messages,
    current?.brainTask?.executionSummary,
    remote?.executionSummary,
    task?.state,
    current?.workflow?.roundRequestID,
    current?.workflow?.messages?.length,
  ]);
  useEffect(() => {
    const element = transcript.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (scrollPinned.current && !current?.workflow) element.scrollTop = element.scrollHeight;
      updateScrollPosition();
    });
    observer.observe(element);
    // Details and asynchronous file results change content height without resizing the viewport.
    // Update the button/follow state without pulling a reader away from the expanded content.
    const contentObserver = new ResizeObserver(updateScrollPosition);
    if (element.firstElementChild) contentObserver.observe(element.firstElementChild);
    element.addEventListener('toggle', updateScrollPosition, true);
    return () => {
      observer.disconnect();
      contentObserver.disconnect();
      element.removeEventListener('toggle', updateScrollPosition, true);
    };
  }, [selected, view, current?.key]);
  useEffect(() => {
    if (!inputRef.current) return;
    inputRef.current.style.height = 'auto';
    inputRef.current.style.height = `${Math.min(180, inputRef.current.scrollHeight)}px`;
  }, [draft, selected]);

  function updateScrollPosition() {
    const element = transcript.current;
    if (!element) return;
    const away = element.scrollHeight - element.scrollTop - element.clientHeight > 100;
    scrollPinned.current = !away;
    setAwayFromLatest(away);
  }
  function scrollToLatest() {
    const element = transcript.current;
    if (!element) return;
    scrollPinned.current = true;
    element.scrollTop = element.scrollHeight;
    setAwayFromLatest(false);
    element.focus({ preventScroll: true });
  }

  async function perform(fn: () => Promise<unknown>): Promise<boolean> {
    if (operation.current) return false;
    operation.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : typeof e === 'string' && e ? e : t('请求失败'));
      return false;
    } finally {
      try {
        await refresh();
      } catch {
        setError((previous) => previous || t('会话列表暂时无法更新，正在等待状态恢复。'));
      } finally {
        setBusy(false);
        operation.current = false;
      }
    }
  }
  const open = useCallback((item: Conversation | null) => {
    selectedRef.current = item?.key || null;
    setSelected(item?.key || null);
    setMention(null);
    setView('chat');
    setError('');
    setNotice('');
    setMobileSidebar(false);
  }, []);
  useEffect(() => {
    if (current) seenSelected.current = current.key;
    else if (selected && seenSelected.current === selected) { seenSelected.current = null; open(null); }
  }, [current, selected, open]);
  function chooseMentionNode(nodeID: string) {
    if (operation.current) return;
    const node = peers.find((candidate) => candidate.id === nodeID);
    if (!node || !mention) return;
    const mode = mention.mode || 'preferred'; const prefix = nodeMentionPrefix(mode);
    const next = `${draft.slice(0, mention.start)}${prefix}${node.name} ${draft.slice(mention.end)}`;
    const cursor = mention.start + node.name.length + prefix.length + 1;
    changeDraft({ text: next, routing: { kind: 'workflow', target: { mode, nodeID: node.id }, name: node.name } });
    setMention(null);
    setMentionIndex(0);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(cursor, cursor);
    });
  }
  function showMention(mode: 'preferred' | 'locked') {
    const input = inputRef.current; const cursor = input?.selectionStart ?? draft.length;
    const active = mention || activeNodeMention(draft, cursor, peers);
    const start = active?.start ?? cursor; const end = active?.end ?? cursor;
    const padding = start > 0 && !/\s/.test(draft[start - 1]) ? ' ' : '';
    const replacement = padding + nodeMentionPrefix(mode) + (active?.query || '');
    const next = draft.slice(0, start) + replacement + draft.slice(end); const caret = start + replacement.length;
    setDraft(next); setMention({ start: start + padding.length, end: caret, query: active?.query || '', mode }); setMentionIndex(0);
    requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(caret, caret); });
  }
  function changeTargetMode(mode: 'preferred' | 'locked' | null) {
    const name = targetNode?.name || ('name' in draftState.routing ? draftState.routing.name : '') || '';
    changeDraft({ text: name ? replaceBoundNodeMention(draft, name, mode) : draft,
      routing: { kind: 'workflow', target: mode && targetNodeID ? { mode, nodeID: targetNodeID } : { mode: 'automatic' }, ...(mode ? { name } : {}) } });
  }
  async function refreshQueue() {
    if (!data.user.owner) return;
    try {
      const snapshot = await api<NodeQueueSnapshot>('/node-queue');
      setQueueSnapshot((previous) =>
        previous && previous.version > snapshot.version ? previous : reuseJson(previous, snapshot),
      );
      setQueueError('');
    } catch (e) {
      setQueueError((e as Error).message);
    }
  }
  async function executeQueueRequest(request: NonNullable<typeof pendingQueueRequest>) {
    return perform(async () => {
      setPendingQueueRequest(request);
      try {
        await api(request.path, request.body, { timeoutMilliseconds: 15_000 });
        setPendingQueueRequest(null);
      } catch (error) {
        // A known client rejection made no new queue change. Other failures may have lost a committed response.
        if (error instanceof ApiError && error.status >= 400 && error.status < 500)
          setPendingQueueRequest(null);
        throw error;
      } finally {
        await refreshQueue();
      }
    });
  }
  async function controlQueue(entry: NodeQueueItem, action: NodeQueueAction, reason?: string) {
    if (!queueSnapshot || pendingQueueRequest) return false;
    const body = {
      expectedVersion: entry.version,
      expectedQueueVersion: queueSnapshot.version,
      action,
      ...(reason ? { reason } : {}),
    };
    return executeQueueRequest({
      path: `/node-queue/${entry.id}/control`,
      body: { ...body, operationID: crypto.randomUUID() },
    });
  }
  const queuePanel = () => (
    <QueuePanel
      remoteConcurrency={data.executionPolicy.maxConcurrent}
      configure={() => setModal('concurrency')}
      tasks={data.tasks}
      snapshot={queueSnapshot}
      items={all}
      nodeName={nodeName}
      busy={busy || !!pendingQueueRequest}
      error={queueError}
      retry={
        pendingQueueRequest && !busy
          ? () =>
              void executeQueueRequest(pendingQueueRequest).then((ok) => {
                if (ok) setRejectQueueEntry(null);
              })
          : undefined
      }
      open={(item) => {
        setModal(null);
        open(item);
      }}
      control={(entry, action) => {
        if (action === 'reject') setRejectQueueEntry(entry);
        else void controlQueue(entry, action);
      }}
      pause={(paused) => {
        if (!queueSnapshot || pendingQueueRequest) return;
        void executeQueueRequest({
          path: '/node-queue/pause',
          body: {
            expectedVersion: queueSnapshot.version,
            paused,
            operationID: crypto.randomUUID(),
          },
        });
      }}
    />
  );
  const control = (action: RemoteTaskControlAction) => {
    if (!remote || !canRemoteControl) throw new Error(t('此会话当前没有可用的远程操作通道。'));
    return api(`/network/tasks/${remote.id}/control`, {
      expectedExecutionSequence: remote.executionSequence,
      action,
      confirmed: true,
    });
  };
  async function runLocal(value: Task, addition?: string) {
    if (value.state === 'open') await api(`/tasks/${value.id}/claim`, {});
    await api(`/tasks/${value.id}/run`, {
      confirmed: true,
      ...(value.sessionID ? { addition: addition || value.description } : {}),
    });
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (
      !text ||
      busy ||
      !canWrite ||
      inputUsage.overLimit ||
      ((!current || current.workflow) && !draftFilesReady(draftState.files))
    )
      return;
    await perform(async () => {
      if (current) {
        if (current.workflow) {
          const body = { text, attachmentIDs: (draftState.files || []).map((f) => f.id) };
          const prepared = prepareConversationRequest(draftState, body);
          setDrafts((previous) => ({ ...previous, [draftKey]: prepared }));
          await api(`/workflows/${current.workflow.id}/messages`, { ...body, requestID: prepared.requestID }, { timeoutMilliseconds: 15_000 });
          scrollPinned.current = true;
          setDrafts((previous) => clearSubmittedDraft(previous, draftKey, prepared.requestID, createWorkflowDraft));
          return;
        } else if (task) {
          if (task.assigneeID !== data.user.id)
            await api(`/tasks/${task.id}/requirements`, { text });
          else {
            const updated = await api<Task>(`/tasks/${task.id}/requirements`, { text });
            if (!['waiting', 'held'].includes(currentQueueEntry?.state || ''))
              await runLocal(updated, text);
          }
        } else await control({ kind: 'supplement', text });
        setDraft('');
      } else {
        const title = text
          .split('\n')
          .find((line) => line.trim())!
          .slice(0, 120);
        const acceptance =
          criteria.trim() || t('完成会话要求，说明结果、验证情况和仍需处理的问题。');
        const routing: ConversationRouting = { kind: 'workflow', target: workflowTarget };
        const body = {
          title,
          ...(draftState.files?.length ? { attachmentIDs: draftState.files.map((f) => f.id) } : {}),
          description: text,
          criteria: acceptance,
          projectID: projectID || null, model: model || null, approvalMode: mode, target: workflowTarget,
        };
        const prepared = prepareConversationRequest(draftState, body);
        setDrafts((previous) => ({ ...previous, [draftKey]: prepared }));
        const completeCreation = (id: string) => {
          const createdKey = createdConversationKey(routing, id);
          if (selectedRef.current === selected) {
            selectedRef.current = createdKey;
            setSelected(createdKey);
            setMention(null);
          }
          setDrafts((previous) => clearSubmittedDraft(previous, draftKey, prepared.requestID, createWorkflowDraft));
        };
        const result = await api<Workflow>('/workflows', { ...body, requestID: prepared.requestID }, { timeoutMilliseconds: 15_000 });
        completeCreation(result.id); await refreshQueue();
      }
    });
  }

  const networkActions = {
    onRequestPairing: (nodeID: string) => void perform(() => api('/network/pairings', { nodeID })),
    onConfirmPairing: (id: string) =>
      void perform(() => api(`/network/pairings/${id}/confirm`, {})),
    onCancelPairing: (id: string) => void perform(() => api(`/network/pairings/${id}/cancel`, {})),
    onRevokeTrust: (id: string) => {
      setDeleteNodeID(id);
    },
    onEditNodeRemark: (id: string) => setRemarkNodeID(id),
    onCreateRemoteTask: (input: { title: string; description: string; criteria: string }) =>
      void perform(() => createTask('/network/tasks', { ...input, confirmed: true })),
    onCancelRemoteTask: (id: string) =>
      void perform(() => api(`/network/tasks/${id}/cancel`, { confirmed: true })),
    onControlRemoteTask: (id: string, sequence: number, action: RemoteTaskControlAction) =>
      void perform(() =>
        api(`/network/tasks/${id}/control`, {
          expectedExecutionSequence: sequence,
          action,
          confirmed: true,
        }),
      ),
    onSaveExecutionPolicy: (input: {
      enabled: boolean;
      approvalMode: ApprovalMode;
      projectID: string | null;
      model: string | null;
    }) => void perform(() => api('/network/execution-policy', { ...input, confirmed: true })),
  };

  return (
    <ResizableWorkspace hasNetwork={rail} sidebarOpen={mobileSidebar}>
      {mobileSidebar && (
        <button
          className="sidebar-scrim"
          aria-label={t('收起会话栏')}
          onClick={() => setMobileSidebar(false)}
        />
      )}
      <aside
        id="conversation-history-sidebar"
        className="conversation-sidebar"
        aria-label={t('历史会话')}
      >
        <button
          className="node-identity-button"
          onClick={() => setModal('profile')}
          disabled={!local || !data.user.owner}
          title={t('编辑 Node 名称与图标')}
        >
          <NodeAvatar icon={local?.icon} name={local?.name} />
          <span>
            <strong>{local?.name || t('我的 Node')}</strong>
            <small>
              <i className={connected ? 'status-dot online' : 'status-dot'} />
              {connected ? t('本机在线') : t('正在连接')}
            </small>
          </span>
          <ChevronDown size={15} />
        </button>
        <button className="new-conversation" onClick={() => open(null)}>
          <Plus size={18} />
          {t('新会话')}
          <span>↗</span>
        </button>
        <div className="conversation-searchbar">
          <label className="conversation-search">
            <Search size={15} />
            <input
              aria-label={t('搜索会话')}
              title={t('搜索标题、工作目录、设备名或需求正文')}
              placeholder={t('搜索会话')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <ConversationFilterButton
            status={statusFilter}
            source={sourceFilter}
            filtering={filtering}
            onStatusChange={setStatusFilter}
            onSourceChange={setSourceFilter}
            onClear={clearFilters}
          />
        </div>
        {view === 'chat' && current && !visible.some((item) => item.key === current.key) && (
          <p className="history-selection-note">{t('当前打开的会话不在筛选结果中。')}</p>
        )}
        <div className="conversation-history">
          {historyGroups.map((group) => <section className="history-directory" key={group.key} aria-label={group.name}>
            <HistoryDirectoryHeading group={group} expanded={!collapsedGroups.has(group.key) || !!search.trim()} busy={busy} perform={perform}
              copied={() => setNotice(t('已复制到剪贴板'))}
              toggle={() => setCollapsedGroups((previous) => { const next = new Set(previous); if (next.has(group.key)) next.delete(group.key); else next.add(group.key); return next; })}
              alias={() => { setError(''); setAliasDirectory({ key: group.key, label: group.label, name: group.name }); }} />
          {(!collapsedGroups.has(group.key) || !!search.trim()) && <div className="history-directory-items" role="group" aria-label={group.name}>{group.items.map((item) => (
            <HistoryRow
              key={item.key}
              item={item}
              selected={view === 'chat' && selected === item.key}
              source={item.incoming ? nodeName(item.sourceNodeID) : undefined}
              icon={item.incoming ? nodes.find((n) => n.id === item.sourceNodeID)?.icon : undefined}
              open={open}
              remove={removeHistory}
              rename={renameHistory}
              pin={pinHistory}
              busy={busy}
              canRemove={data.user.owner && !busy && historyCanTrash(item, data, queueSnapshot?.entries || [])}
              locale={locale}
            />
          ))}</div>}</section>)}
          {!visible.length && (
            <div className="history-empty">
              <p>{filtering ? t('没有符合筛选条件的会话') : t('你的会话会保存在这里')}</p>
              {filtering && (
                <button type="button" className="text-button" onClick={clearFilters}>
                  {t('显示全部会话')}
                </button>
              )}
            </div>
          )}
        </div>
        <nav className="conversation-settings" aria-label={t('设置')}>
          {data.user.owner && <button className={view === 'trash' ? 'active' : ''} onClick={() => { setView('trash'); setMobileSidebar(false); setNotice(''); }}>
            <Trash2 size={17} />{t('回收站')}<span className="attention-count">{data.conversationTrash?.length || 0}</span>
          </button>}
          <button
            className={view === 'attention' ? 'active' : ''}
            onClick={() => openAttention('attention')}
          >
            <Inbox size={17} />
            {t('待办中心')}
            <span className="attention-count">{attention.snapshot?.items.length ?? '—'}</span>
          </button>
          <button
            className={view === 'network' || view === 'models' ? 'active' : ''}
            onClick={() => {
              setView('models');
              setMobileSidebar(false);
            }}
          >
            <Settings2 size={17} />
            {t('设备与模型')}
            <ChevronRight size={14} />
          </button>
          <button
            className={view === 'diagnostics' ? 'active' : ''}
            onClick={() => {
              setDiagnosticTarget(null);
              setView('diagnostics');
              setMobileSidebar(false);
            }}
          >
            <DiagnosticIcon size={17} />
            {t('连接诊断')}
            <ChevronRight size={14} />
          </button>
          <div className="sidebar-signature">
            <Wordmark />
            <AboutRivloomEntry version={rivloomVersion} onClick={() => setModal('about')} />
          </div>
          <LanguageSwitcher />
        </nav>
      </aside>
      <main className="conversation-center">
        <header className="conversation-header">
          <button
            className="icon-button mobile-nav"
            aria-label={t('打开会话栏')}
            onClick={() => setMobileSidebar(true)}
          >
            <PanelLeft size={18} />
          </button>
          {view !== 'chat' && (
            <button
              className="icon-button"
              aria-label={t('返回会话')}
              onClick={() => setView('chat')}
            >
              <ArrowLeft size={18} />
            </button>
          )}
          <div>
            <span>
              {view === 'trash' ? t('回收站') : view === 'network'
                ? t('设备与模型')
                : view === 'models'
                  ? t('设备与模型')
                  : view === 'attention'
                    ? t('待办中心')
                    : view === 'diagnostics'
                      ? t('连接诊断')
                      : current?.title || t('新会话')}
            </span>
            {view === 'chat' && current && <small>{conversationState(current)}</small>}
          </div>
          {view === 'chat' && data.user.owner && !rail && (
            <button
              className="local-queue-entry"
              onClick={() => setModal('queue')}
              aria-label={t('打开本机执行队列')}
              aria-haspopup="dialog"
            >
              <ListOrdered size={15} />
              <span>{t('本机队列')}</span>
            </button>
          )}
          <span className="header-status">
            <i className={`status-dot ${connected ? 'online' : ''}`} />
            {connected ? t('已连接') : t('正在重连')}
          </span>
        </header>
        {(error || connectionError) && (
          <div className="workspace-alert error" role="alert">
            {systemText(error || connectionError)}
            <button className="icon-button" aria-label={t('关闭错误')} onClick={() => setError('')}>
              <X size={15} />
            </button>
          </div>
        )}
        {notice && (
          <div className="workspace-alert notice" role="status">
            {notice}
          </div>
        )}
        {view === 'chat' ? (
          <>
            <div className="conversation-transcript">
              <div
                className={`conversation-body ${current ? '' : 'blank'}`}
                ref={transcript}
                id="conversation-transcript"
                tabIndex={0}
                aria-label={t('会话消息')}
                onScroll={updateScrollPosition}
              >
                {current?.workflow ? <div className="transcript-content"><WorkflowView key={current.workflow.id} value={current.workflow} data={data} busy={busy} perform={perform} nodeName={nodeName} /></div> : current ? (
                  <div className="transcript-content">
                    {currentReceipt && (
                      <section
                        className={`task-receipt ${currentReceipt.tone}`}
                        role="status"
                        aria-live="polite"
                      >
                        {currentReceipt.syncing ? (
                          <LoaderCircle size={16} className="spin" />
                        ) : (
                          <ListOrdered size={16} />
                        )}
                        <div>
                          <strong>{currentReceipt.label}</strong>
                          <p>{currentReceipt.detail}</p>
                          {currentReceipt.updatedAt && (
                            <time dateTime={currentReceipt.updatedAt}>
                              {t('更新于 {{value1}}', {
                                value1: dateLabel(currentReceipt.updatedAt),
                              })}
                            </time>
                          )}
                        </div>
                        {remote?.direction === 'outgoing' && (
                          <button
                            className="receipt-diagnostics"
                            onClick={() => {
                              setDiagnosticTarget(remote.targetNodeID);
                              setView('diagnostics');
                            }}
                          >
                            {t('连接诊断')}
                          </button>
                        )}
                      </section>
                    )}
                    <Transcript item={current} source={sourceName} locale={locale} />
                    {task?.error && <p className="error">{systemText(task.error)}</p>}
                    {approvals.map((approval) => (
                      <section className="chat-approval" key={approval.id}>
                        <h3>
                          <ShieldCheck size={18} />
                          {t('需要你的批准')}
                        </h3>
                        <p>{approval.permission}</p>
                        <pre>
                          {String(
                            approval.metadata.command ||
                              approval.metadata.diff ||
                              approval.patterns.join('\n'),
                          )}
                        </pre>
                        {canApprove ? (
                          <div className="action-group">
                            {(['reject', 'once'] as const).map((reply) => (
                              <Button
                                key={reply}
                                disabled={busy || remote?.controlPending}
                                variant={reply === 'once' ? 'primary' : ''}
                                onClick={() =>
                                  void perform(() =>
                                    task
                                      ? api(`/tasks/${task.id}/permissions/${approval.id}`, {
                                          reply,
                                        })
                                      : control({
                                          kind: 'permission',
                                          requestID: approval.id,
                                          reply,
                                        }),
                                  )
                                }
                              >
                                {reply === 'once' ? t('仅本次允许') : t('拒绝')}
                              </Button>
                            ))}
                          </div>
                        ) : (
                          <p className="muted">{t('等待指定审批人处理。')}</p>
                        )}
                      </section>
                    ))}
                    {questions.map((question) => (
                      <form
                        className="chat-approval"
                        key={question.id}
                        onSubmit={(event) => {
                          event.preventDefault();
                          const form = new FormData(event.currentTarget);
                          const answers = question.questions.map((_, i) => [
                            String(form.get(`answer-${i}`)),
                          ]);
                          void perform(() =>
                            task
                              ? api(`/tasks/${task.id}/questions/${question.id}`, { answers })
                              : control({ kind: 'question', requestID: question.id, answers }),
                          );
                        }}
                      >
                        <h3>{t('补充一点信息')}</h3>
                        {question.questions.map((q, i) => (
                          <Field
                            key={i}
                            label={q.question}
                            hint={q.options.map((o) => `${o.label}：${o.description}`).join('；')}
                          >
                            <input
                              name={`answer-${i}`}
                              required
                              maxLength={4000}
                              disabled={!canWrite}
                            />
                          </Field>
                        ))}
                        <Button
                          type="submit"
                          variant="primary"
                          disabled={busy || !canWrite || remote?.controlPending}
                        >
                          {t('回复')}
                        </Button>
                      </form>
                    ))}
                    <div className="chat-actions">
                      {task &&
                        task.assigneeID === data.user.id &&
                        !queueRejected &&
                        !['waiting', 'held'].includes(currentQueueEntry?.state || '') &&
                        !(currentQueueEntry?.state === 'admitted' && !task.sessionID) &&
                        ['open', 'ready', 'stopped', 'failed', 'interrupted'].includes(
                          task.state,
                        ) && (
                          <Button
                            disabled={busy || !data.engine.ready}
                            onClick={() => void perform(() => runLocal(task))}
                          >
                            <Play size={14} />
                            {task.sessionID ? t('继续执行') : t('开始执行')}
                          </Button>
                        )}
                      {running && (task || canRemoteControl) && (
                        <Button
                          disabled={busy || task?.state === 'stopping' || remote?.controlPending}
                          onClick={() =>
                            void perform(() =>
                              task ? api(`/tasks/${task.id}/stop`, {}) : control({ kind: 'stop' }),
                            )
                          }
                        >
                          <Square size={13} />
                          {t('停止')}
                        </Button>
                      )}
                    </div>
                    {current && (
                      <details className="conversation-details">
                        <summary>
                          {t('会话详情与执行记录')}
                          <ChevronDown size={14} />
                        </summary>
                        <dl>
                          <dt>{t('来源')}</dt>
                          <dd>{nodeName(current.sourceNodeID)}</dd>
                          <dt>{t('创建时间')}</dt>
                          <dd>{dateLabel(current.createdAt)}</dd>
                          <dt>{t('完成要求')}</dt>
                          <dd>
                            {task?.criteria || current.brainTask?.criteria || remote?.criteria}
                          </dd>
                          {task && (
                            <>
                              <dt>{t('文件夹')}</dt>
                              <dd>
                                {data.projects.find((p) => p.id === task.projectID)?.directory}
                              </dd>
                              <dt>{t('模型 / 审批')}</dt>
                              <dd>
                                {task.model} · {approvalModeLabels[task.approvalMode]}
                              </dd>
                            </>
                          )}
                          {current.brainTask && (
                            <>
                              <dt>{t('归属 Brain')}</dt>
                              <dd>{current.brainTask.brainID}</dd>
                              <dt>{t('执行节点')}</dt>
                              <dd>{nodeName(current.brainTask.selectedWorkerID)}</dd>
                            </>
                          )}
                        </dl>
                        {artifacts.map((artifact) => (
                          <details className="chat-tool" key={artifact.file}>
                            <summary>
                              <FileCode2 size={14} />
                              {artifact.file}
                              <small>
                                +{artifact.additions} −{artifact.deletions}
                              </small>
                            </summary>
                            <pre>{artifact.patch}</pre>
                          </details>
                        ))}
                        {!artifacts.length && (
                          <p className="muted">
                            {t('尚无官方文件差异，请结合执行记录与实际文件查看结果。')}
                          </p>
                        )}
                        {current.brainTask?.executions.map((execution) => (
                          <p className="execution-history-row" key={execution.executionID}>
                            {t('第')}
                            {execution.attempt}
                            {t('次 ·')}
                            {nodeName(execution.workerNodeID)} ·{' '}
                            {executionStateText(execution.status)}
                            <small>
                              {executionSummaryText(execution.summary, execution.status)}
                            </small>
                          </p>
                        ))}
                        {activities.map((activity) => (
                          <p className="execution-history-row" key={activity.id}>
                            {systemText(activity.text)}
                            <small>{dateLabel(activity.at)}</small>
                          </p>
                        ))}
                      </details>
                    )}
                    <TaskFilesPanel
                      key={current.key}
                      scope={current.brainTask ? 'brain' : current.remote ? 'remote' : 'local'}
                      taskID={current.brainTask?.id || current.remote?.id || current.localTask!.id}
                    />
                  </div>
                ) : (
                  <div className="blank-conversation">
                    <span className="blank-mark">
                      <Wordmark />
                    </span>
                    <h1>
                      {awaitingCreatedConversation ? t('会话已保存') : t('今天，想完成什么？')}
                    </h1>
                    <p>
                      {awaitingCreatedConversation
                        ? t('正在等待会话状态更新。')
                        : t('从一个想法、一段问题，或一项工作开始。')}
                    </p>
                  </div>
                )}
              </div>
              {current && awayFromLatest && (
                <button
                  type="button"
                  className="return-to-latest"
                  aria-controls="conversation-transcript"
                  onClick={scrollToLatest}
                >
                  <ArrowDown size={15} />
                  {t('回到最新消息')}
                </button>
              )}
            </div>
            <div className="composer-area">
              <form
                className={`conversation-composer ${!canWrite ? 'read-only' : ''}`}
                onSubmit={send}
              >
                {(!current || current.workflow) && (
                  <TaskFilePicker
                    key={draftKey}
                    files={draftState.files || []}
                    disabled={busy || !canWrite}
                    composer
                    onChange={(update) =>
                      setDrafts((previous) => {
                        const saved = previous[draftKey] || emptyDraft.current;
                        return {
                          ...previous,
                          [draftKey]: updateConversationDraft(saved, {
                            files: update(saved.files || []),
                          }),
                        };
                      })
                    }
                  />
                )}
                {!current && data.user.owner && <div className="composer-target-hints">
                  <span>{t('先分析与规划，再自动执行')}</span>
                  <button type="button" disabled={busy} onClick={() => showMention('preferred')}>@ {t('首选 Node')}</button>
                  <button type="button" disabled={busy} onClick={() => showMention('locked')}>@@ {t('锁定 Node')}</button>
                </div>}
                <textarea
                  ref={inputRef}
                  aria-label={t('会话消息')}
                  aria-describedby={canWrite ? 'conversation-input-usage' : undefined}
                  aria-invalid={(canWrite && inputUsage.overLimit) || undefined}
                  aria-controls={mention ? 'node-mention-options' : undefined}
                  aria-activedescendant={
                    mentionNodes[mentionIndex]
                      ? `node-mention-${mentionNodes[mentionIndex].id}`
                      : undefined
                  }
                  placeholder={
                    queueRejected
                      ? t('此项工作已被拒绝，请新建会话提交新的工作')
                      : waitingForRemoteSession
                        ? t('等待目标 Node 准备执行会话，开始后可补充要求')
                        : current?.workflow
                          ? t('继续提出要求，当前轮结束后依次执行…')
                        : finished
                          ? t('会话已完成，点击「新会话」开始新的工作')
                          : !canWrite
                            ? t('当前只能查看此会话的执行状态')
                            : current
                              ? t('继续对话，补充你的要求…')
                              : t('有什么想交给 Rivloom？')
                  }
                  value={draft}
                  onChange={(event) => {
                    const next = event.target.value;
                    const boundName = targetNode?.name || ('name' in draftState.routing ? draftState.routing.name : '') || '';
                    const typedMode = boundName ? boundNodeMentionMode(next, boundName) : null;
                    if (!current && targetNodeID && typedMode && typedMode !== targetMode) changeDraft({ text: next,
                      routing: { kind: 'workflow', target: { mode: typedMode, nodeID: targetNodeID }, name: boundName } });
                    else setDraft(next);
                    if (!current && data.user.owner) {
                      setMention(activeNodeMention(next, event.target.selectionStart, peers));
                      setMentionIndex(0);
                    } else setMention(null);
                  }}
                  onSelect={(event) => {
                    if (!current && data.user.owner && !composing.current) {
                      setMention(
                        activeNodeMention(
                          event.currentTarget.value,
                          event.currentTarget.selectionStart,
                          peers,
                        ),
                      );
                      setMentionIndex(0);
                    }
                  }}
                  onCompositionStart={() => {
                    composing.current = true;
                  }}
                  onCompositionEnd={(event) => {
                    composing.current = false;
                    if (!current && data.user.owner)
                      setMention(
                        activeNodeMention(
                          event.currentTarget.value,
                          event.currentTarget.selectionStart,
                          peers,
                        ),
                      );
                  }}
                  disabled={!canWrite || busy}
                  rows={2}
                  maxLength={inputUsage.limit}
                  onKeyDown={(event) => {
                    // IME confirmation must precede both mention selection and form submission.
                    if (isNodeMentionComposing(event.nativeEvent, composing.current)) return;
                    if (mention && mentionNodes.length) {
                      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                        event.preventDefault();
                        setMentionIndex((currentIndex) =>
                          event.key === 'ArrowDown'
                            ? (currentIndex + 1) % mentionNodes.length
                            : (currentIndex - 1 + mentionNodes.length) % mentionNodes.length,
                        );
                        return;
                      }
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        chooseMentionNode(mentionNodes[mentionIndex]?.id || mentionNodes[0].id);
                        return;
                      }
                    }
                    if (event.key === 'Escape' && mention) {
                      event.preventDefault();
                      setMention(null);
                      return;
                    }
                    if (
                      event.key === 'Enter' &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
                {canWrite && (
                  <div
                    id="conversation-input-usage"
                    className={`composer-input-usage ${inputUsage.overLimit ? 'exceeded' : inputUsage.nearLimit ? 'near-limit' : ''}`}
                  >
                    <span className="composer-input-warning" role="status" aria-live="polite">
                      {inputUsage.overLimit
                        ? t('内容超出当前上限，请缩短后再发送。')
                        : inputUsage.remaining === 0
                          ? t('已达到输入上限。')
                          : inputUsage.nearLimit
                            ? t('接近输入上限。')
                            : ''}
                    </span>
                    <span className="composer-input-count">
                      {t('{{used}} / {{limit}} 字符', {
                        used: inputUsage.length.toLocaleString(language()),
                        limit: inputUsage.limit.toLocaleString(language()),
                      })}
                    </span>
                  </div>
                )}
                {mention && (
                  <div
                    className="node-mention-menu"
                    role="dialog"
                    aria-label={t('选择执行 Node')}
                  >
                    <div className="node-mention-heading">
                      <AtSign size={14} />
                      <span>{mention.query ? t('匹配的 Node') : t('最近使用的 Node')}</span>
                    </div>
                    <div className="node-mention-mode">{(['preferred', 'locked'] as const).map((mode) => <button type="button" key={mode}
                      aria-pressed={(mention.mode || 'preferred') === mode} onMouseDown={(e) => e.preventDefault()} onClick={() => showMention(mode)}>
                      {nodeMentionPrefix(mode)} {mode === 'preferred' ? t('首选') : t('锁定')}</button>)}</div>
                    <p className="node-mention-mode-help">{mention.mode === 'locked' ? t('全部执行留在此 Node；仍可查询和取回其他节点的材料。') : t('优先使用此 Node；资源或工具不适合时可自动转交。')}</p>
                    <div role="listbox" id="node-mention-options" aria-label={t('最近使用的 Node')}>
                    {mentionNodes.map((node, index) => {
                      const capability = nodeCapabilitySummary(
                        node,
                        Date.now(),
                        connected && !connectionError,
                      );
                      return (
                        <button
                          type="button"
                          role="option"
                          id={`node-mention-${node.id}`}
                          aria-selected={index === mentionIndex}
                          className={index === mentionIndex ? 'active' : ''}
                          key={node.id}
                          title={capability.detail}
                          aria-label={`${nodeDisplayName(node)}，${capability.summary}`}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => chooseMentionNode(node.id)}
                        >
                          <NodeAvatar small icon={node.icon} name={node.name} />
                          <span>
                            <strong className="node-mention-name">{nodeDisplayName(node)}</strong>
                            <small className="node-mention-capability">{capability.summary}</small>
                            {(!capability.loadFresh ||
                              !capability.queueFresh ||
                              capability.health) && (
                              <small className="node-mention-freshness">
                                {capability.health ||
                                  (!capability.loadFresh
                                    ? t('负载等待更新')
                                    : t('队列信息未提供或待更新'))}
                              </small>
                            )}
                          </span>
                          <i
                            className={`status-dot ${node.online && node.channelReady ? 'online' : ''}`}
                          />
                        </button>
                      );
                    })}
                    {!mentionNodes.length && <p>{t('没有匹配的已配对 Node')}</p>}
                    </div>
                  </div>
                )}
                {!current && targetNodeID && (
                  <div
                    className={`directed-node-chip ${!targetNode ? 'unavailable' : ''}`}
                    title={t('目标 Node：{{value1}}（{{value2}}）', {
                      value1: targetName,
                      value2: targetNodeID,
                    })}
                  >
                    <AtSign size={14} />
                    <span>
                      {targetMode === 'locked' ? '@@ ' + t('锁定') + ' ' : '@ ' + t('首选') + ' '}
                      {targetName}
                      {!targetNode && t(' · 目标暂未出现在已配对目录中，重试时会确认原投递')}
                    </span>
                    <button type="button" className="target-mode-toggle" disabled={busy} onClick={() => changeTargetMode(targetMode === 'locked' ? 'preferred' : 'locked')}>
                      {targetMode === 'locked' ? t('改为首选') : t('改为锁定')}</button>
                    <button
                      type="button"
                      aria-label={t('清除目标，自动选择 Node')}
                      title={t('清除目标，自动选择 Node')}
                      disabled={busy}
                      onClick={() => changeTargetMode(null)}
                    >
                      <X size={13} />
                    </button>
                  </div>
                )}
                <div className="composer-toolbar">
                  <div className="composer-choices">
                    {!current ? (
                      <>
                        {targetNodeID ? (
                          <span className="composer-directed-location">
                            <AtSign size={15} />
                            {targetName}
                          </span>
                        ) : (
                          <label className="composer-select">
                            <FolderOpen size={15} />
                            <select
                              aria-label={t('工作文件夹')}
                              disabled={busy}
                              value={projectID}
                              onChange={(event) => {
                                if (event.target.value === '__add__') setModal('folder');
                                else setProjectID(event.target.value);
                              }}
                            >
                              <option value="">
                                {t('本机规划工作目录')}
                              </option>
                              {data.projects.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name}
                                </option>
                              ))}
                              {data.user.owner && (
                                <option value="__add__">{t('添加文件夹…')}</option>
                              )}
                            </select>
                          </label>
                        )}
                        {(!targetNodeID || targetNodeID === local?.id) && (
                          <label className="composer-select model-select">
                            <Bot size={15} />
                            <select
                              aria-label={t('执行模型')}
                              disabled={busy}
                              value={model}
                              onChange={(e) => setModel(e.target.value)}
                            >
                              {!data.engine.models.some((m) => m.id === model) && (
                                <option value={model}>
                                  {data.engine.models.length ? t('选择模型') : t('尚未连接模型')}
                                </option>
                              )}
                              {data.engine.models.map((m) => (
                                <option key={m.id} value={m.id}>
                                  {m.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                        <button
                          type="button"
                          className={`composer-options ${options ? 'active' : ''}`}
                          aria-label={t('会话设置')}
                          disabled={busy}
                          aria-expanded={options}
                          onClick={() => setOptions(!options)}
                        >
                          <Settings2 size={16} />
                        </button>
                      </>
                    ) : (
                      <span className="composer-context">
                        {task ? (
                          <>
                            <FolderOpen size={14} />
                            {data.projects.find((p) => p.id === task.projectID)?.name}
                          </>
                        ) : (
                          <>
                            <Network size={14} />
                            {conversationState(current)}
                          </>
                        )}
                      </span>
                    )}
                  </div>
                  <button
                    type="submit"
                    className="send-message"
                    aria-label={t('发送消息')}
                    disabled={
                      busy ||
                      !draft.trim() ||
                      inputUsage.overLimit ||
                      ((!current || current.workflow) && !draftFilesReady(draftState.files)) ||
                      !canWrite ||
                      remote?.controlPending ||
                      (!current &&
                        conversationCreationNeedsModel(draftState) &&
                        !data.engine.models.some((m) => m.id === model))
                    }
                  >
                    {busy ? <LoaderCircle size={19} className="spin" /> : <ArrowUp size={20} />}
                  </button>
                </div>
                {!current && options && (
                  <div className="composer-expanded">
                    {targetNodeID ? (
                      <div className="directed-node-setting">
                        <AtSign size={16} />
                        <span>
                          <small>{t('执行位置')}</small>
                          <strong>{targetName}</strong>
                        </span>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => changeTargetMode(null)}
                        >
                          {t('清除目标，自动选择 Node')}
                        </button>
                      </div>
                    ) : (
                      <Field label={t('执行位置')}>
                        <select
                          value={scope}
                          disabled={busy}
                          onChange={(e) => {
                            setScope(e.target.value as typeof scope);
                          }}
                        >
                          <option value="local">{t('@@ 锁定本机执行')}</option>
                          {data.user.owner && (
                            <option value="automatic">{t('自动分配到可用节点')}</option>
                          )}
                        </select>
                      </Field>
                    )}
                    {!targetNodeID || targetNodeID === local?.id ? (
                      <Field label={t('本机执行审批')}>
                        <select
                          value={approvalChoice}
                          disabled={busy}
                          onChange={(e) => setApprovalChoice(e.target.value as ApprovalMode | 'default')}
                        >
                          <option value="default">
                            {t('跟随本机设置（{{mode}}）', { mode: approvalModeLabels[data.executionPolicy.approvalMode] })}
                          </option>
                          {Object.entries(approvalModeLabels).map(([value, label]) => (
                            <option value={value} key={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </Field>
                    ) : (
                      <p className="muted">{t('远端执行使用目标 Node 配置的模型、目录和审批设置。')}</p>
                    )}
                    {mode === 'full' && (!targetNodeID || targetNodeID === local?.id) && (
                      <p className="notice">
                        {t('允许文件、命令、联网及项目外目录操作自动执行。请只用于你信任的环境。')}
                      </p>
                    )}
                    <Field label={t('完成要求（可选）')}>
                      <textarea
                        value={criteria}
                        disabled={busy}
                        onChange={(e) => setCriteria(e.target.value)}
                        maxLength={4000}
                        rows={2}
                        placeholder={t('例如：通过测试，并说明修改结果')}
                      />
                    </Field>
                  </div>
                )}
              </form>
              {draftSaveError && <p className="file-error" role="alert">{t('草稿暂时无法保存，请保留此窗口。')}</p>}
              <div className="composer-hint">
                {current?.workflow ? t('新要求会排队接续；模型的问题请在问题卡片中直接回答。') : waitingForRemoteSession
                  ? t('当前可查看投递与排队状态；目标准备执行会话后可补充要求。')
                  : !canWrite && !finished
                    ? t('执行状态由归属节点同步；当前节点没有可用的继续操作权限。')
                    : running
                      ? t('发送补充要求会先停止当前执行，再继续同一会话。')
                      : current
                        ? t('Enter 发送 · Shift + Enter 换行')
                        : targetNodeID
                          ? targetMode === 'locked'
                            ? t('先分析与规划，全部执行锁定在 {{node}}；仍可查询其他节点的材料。', { node: targetName })
                            : t('先分析与规划，优先使用 {{node}}；必要时自动转交。', { node: targetName })
                          : t('发送后先分析与规划，再按资源与依赖自动执行。')}
              </div>
            </div>
          </>
        ) : (
          <div className="conversation-settings-page">
            {(view === 'models' || view === 'network') && (
              <nav className="device-settings-tabs" aria-label={t('设备设置分类')}>
                <button
                  type="button"
                  aria-current={view === 'models' ? 'page' : undefined}
                  onClick={() => setView('models')}
                >
                  {t('模型与执行')}
                </button>
                <button
                  type="button"
                  aria-current={view === 'network' ? 'page' : undefined}
                  onClick={() => setView('network')}
                >
                  {t('节点与 Brain')}
                </button>
              </nav>
            )}
            {view === 'trash' ? <ConversationTrash entries={data.conversationTrash || []} busy={busy}
              restore={(entry) => void perform(async () => { await api('/history/restore', { key: entry.key }); setNotice(t('会话已恢复到历史列表。')); })}
              purge={(entry) => setHistoryAction({ action: 'purge', key: entry.key, title: entry.title })}
              empty={() => setHistoryAction({ action: 'empty' })} /> : view === 'diagnostics' ? (
              <NodeDiagnosticsView
                key={diagnosticTarget || 'local'}
                data={data}
                connected={connected && !connectionError}
                queue={queueSnapshot}
                initialNodeID={diagnosticTarget}
                refresh={refresh}
                navigate={(action) => {
                  if (action === 'queue') setModal('queue');
                  else setView(action);
                }}
              />
            ) : view === 'attention' ? (
              <TaskAttentionView controller={attention} open={openAttention} />
            ) : view === 'models' ? (
              <ModelSettingsView
                owner={data.user.owner}
                engineReady={data.engine.ready}
                onChanged={() => void refresh()}
                executionSettings={
                  data.user.owner && (
                    <section className="network-section local-execution-settings">
                      <div className="section-title">
                        <h2>{t('本机执行能力')}</h2>
                      </div>
                      <ExecutionPolicyCard
                        key={data.executionPolicy.updatedAt || 'new-policy'}
                        policy={data.executionPolicy}
                        projects={data.projects}
                        models={data.engine.models}
                        actions={{
                          owner: data.user.owner,
                          busy,
                          saveExecutionPolicy: networkActions.onSaveExecutionPolicy,
                        }}
                      />
                      <ExecutionConcurrencySettings policy={data.executionPolicy} onChanged={() => void refresh()} />
                      <Button onClick={() => setModal('folder')}>
                        <FolderOpen size={16} />
                        {t('添加执行文件夹')}
                      </Button>
                      <ResourceDiscovery
                        nodes={data.resourceDirectory || []}
                        refresh={refresh}
                        nodeName={nodeName}
                        localNodeID={local?.id}
                        projects={data.projects}
                      />
                    </section>
                  )
                }
              />
            ) : (
              <>
                <NodeNetworkView
                  onEditConcurrency={() => setModal('concurrency')}
                  network={data.network}
                  owner={data.user.owner}
                  projects={data.projects}
                  models={data.engine.models}
                  executionPolicy={data.executionPolicy}
                  busy={busy}
                  conversationsInSidebar
                  hideExecutionPolicy
                  {...networkActions}
                />
                {data.user.owner && (
                  <Button onClick={() => setModal('folder')}>
                    <FolderOpen size={16} />
                    {t('添加执行文件夹')}
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </main>
      {rail && (
        <aside
          id="conversation-network-sidebar"
          className="network-rail"
          aria-label={t('本机队列和机器状态')}
        >
          {data.user.owner ? (
            queuePanel()
          ) : (
            <p className="muted">{t('本机队列由 Node 所有者管理。')}</p>
          )}
          <PairedMachines
            nodes={peers}
            items={all}
            connected={connected && !connectionError}
            owner={data.user.owner}
            remark={setRemarkNodeID}
            remove={setDeleteNodeID}
          />
          <div className="rail-footer">
            <i className={`status-dot ${connected ? 'online' : ''}`} />
            {connected ? t('状态实时同步') : t('正在恢复状态连接')}
          </div>
        </aside>
      )}
      {renameConversation && <ConversationRenameEditor key={renameConversation.key} title={renameConversation.title} busy={busy} failureMessage={error}
        close={() => setRenameConversation(null)} save={(title) => perform(() => api('/ui/conversation', { key: renameConversation.key, title }))} />}
      {aliasDirectory && <DirectoryAliasEditor key={aliasDirectory.key} directory={aliasDirectory}
        alias={data.directoryAliases?.[aliasDirectory.key] || ''} busy={busy} failureMessage={error}
        close={() => setAliasDirectory(null)} save={(alias) => perform(() => api('/ui/directory-alias', { key: aliasDirectory.key, alias }))} />}
      {modal === 'concurrency' && data.user.owner && (
        <Modal title={t('并发设置')} close={() => setModal(null)}>
          <ExecutionConcurrencySettings policy={data.executionPolicy} onChanged={() => void refresh()} />
        </Modal>
      )}
      {modal === 'about' && (
        <AboutRivloom
          version={rivloomVersion}
          engineVersion={data.engine.version}
          close={() => setModal(null)}
        />
      )}
      {modal === 'profile' && local && (
        <NodeProfileEditor
          profile={{ name: local.name, icon: local.icon || 'monitor' }}
          busy={busy}
          failureMessage={error}
          close={() => setModal(null)}
          save={(profile) => perform(() => api('/network/profile', profile))}
        />
      )}
      {modal === 'queue' && (
        <Modal
          title={t('本机执行队列')}
          subtitle={t('调整尚未开始的工作；已保留的执行槽保持原任务归属。')}
          close={() => setModal(null)}
        >
          {queuePanel()}
        </Modal>
      )}
      {rejectQueueEntry && (
        <Modal
          title={t('拒绝执行此项工作')}
          subtitle={queueConversation(rejectQueueEntry, all)?.title || t('尚未开始的排队项')}
          close={() => setRejectQueueEntry(null)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const reason = String(new FormData(event.currentTarget).get('reason')).trim();
              if (!reason) return;
              void controlQueue(rejectQueueEntry, 'reject', reason).then((ok) => {
                if (ok) setRejectQueueEntry(null);
              });
            }}
          >
            <Field label={t('拒绝原因')} hint={t('原因会保存在原会话，并告知任务发起方。')}>
              <textarea
                name="reason"
                disabled={busy || !!pendingQueueRequest}
                required
                maxLength={500}
                rows={3}
                placeholder={t('说明这台 Node 无法继续执行的原因')}
              />
            </Field>
            {error && (
              <p className="error" role="alert">
                {systemText(error)}
              </p>
            )}
            <div className="modal-actions">
              <Button onClick={() => setRejectQueueEntry(null)}>{t('返回')}</Button>
              {pendingQueueRequest && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void executeQueueRequest(pendingQueueRequest).then((ok) => {
                      if (ok) setRejectQueueEntry(null);
                    })
                  }
                >
                  {t('重试确认')}
                </Button>
              )}
              <Button type="submit" disabled={busy || !!pendingQueueRequest}>
                {t('拒绝执行')}
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {remarkNode && (
        <NodeRemarkEditor
          node={remarkNode}
          busy={busy}
          failureMessage={error}
          close={() => setRemarkNodeID(null)}
          save={(remark) =>
            perform(() => api(`/network/nodes/${remarkNode.id}/remark`, { remark }))
          }
        />
      )}
      {modal === 'folder' && (
        <Modal
          title={t('选择工作文件夹')}
          subtitle={t('会话将在这个文件夹中执行。')}
          close={() => setModal(null)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                const project = await api<Project>('/projects', {
                  name:
                    folderName.trim() ||
                    folderPath.split(/[\\/]/).filter(Boolean).at(-1) ||
                    t('工作文件夹'),
                  directory: folderPath,
                  trusted: true,
                });
                setProjectID(project.id);
                setModal(null);
                setFolderPath('');
                setFolderName('');
              });
            }}
          >
            <Field label={t('文件夹路径')}>
              <input
                value={folderPath}
                onChange={(e) => setFolderPath(e.target.value)}
                required
                placeholder="C:\projects\my-project"
              />
            </Field>
            {desktop && (
              <Button
                onClick={() =>
                  void chooseProjectDirectory()
                    .then((path) => {
                      if (path) setFolderPath(path);
                    })
                    .catch(() => setError(t('无法打开目录选择器，请手动填写路径。')))
                }
              >
                <FolderOpen size={16} />
                {t('浏览本机文件夹')}
              </Button>
            )}
            <Field label={t('显示名称（可选）')}>
              <input
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                maxLength={60}
                placeholder={t('默认使用文件夹名称')}
              />
            </Field>
            <label className="checkbox">
              <input type="checkbox" required />
              {t('我信任此文件夹及其配置，允许 AI 按审批设置读取和修改文件。')}
            </label>
            {error && <p className="error">{systemText(error)}</p>}
            <div className="modal-actions">
              <Button onClick={() => setModal(null)}>{t('取消')}</Button>
              <Button type="submit" variant="primary" disabled={busy || !data.user.owner}>
                {t('使用此文件夹')}
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {queueConfirmation && (
        <Modal
          title={t('队列任务较多')}
          subtitle={queueConfirmation.name}
          close={() => answerQueue(false)}
        >
          <p>
            {t('该 Node「{{name}}」已有 {{count}} 个任务堆积，是否继续提交任务？', {
              name: queueConfirmation.name,
              count: queueConfirmation.count,
            })}
          </p>
          <p className="muted">{queueConfirmation.title}</p>
          <p className="muted">
            {t('默认在 10 个任务时提醒。继续提交后，任务会按队列顺序等待执行。')}
          </p>
          <div className="modal-actions">
            <Button onClick={() => answerQueue(false)}>{t('取消')}</Button>
            <Button variant="primary" onClick={() => answerQueue(true)}>
              {t('继续提交')}
            </Button>
          </div>
        </Modal>
      )}
      {historyAction && <Modal title={historyAction.action === 'trash' ? t('移入回收站') : historyAction.action === 'empty' ? t('清空回收站') : t('永久删除')}
        subtitle={historyAction.title} close={() => { if (!busy) setHistoryAction(null); }}>
        <p>{historyAction.action === 'trash' ? t('会话会保留 3 个日历月，期间可以从回收站恢复。') : t('永久删除后无法恢复。会话记录和不再使用的附件副本将被清理，项目文件保持不变。')}</p>
        {error && <p className="error" role="alert">{systemText(error)}</p>}
        <div className="modal-actions"><Button disabled={busy} onClick={() => setHistoryAction(null)}>{t('取消')}</Button>
          <Button variant="danger" disabled={busy} onClick={() => void perform(async () => {
            const result = await api<{ failed?: string[] }>(`/history/${historyAction.action}`, { ...(historyAction.key ? { key: historyAction.key } : {}), ...(historyAction.action !== 'trash' ? { confirmed: true } : {}) });
            if (historyAction.action === 'trash' && selectedRef.current === historyAction.key) open(null);
            setHistoryAction(null);
            setNotice(result.failed?.length ? t('部分会话暂时无法清理，请稍后重试。') : historyAction.action === 'trash' ? t('会话已移入回收站。') : t('会话已永久删除。'));
          })}>{busy ? t('正在处理…') : historyAction.action === 'trash' ? t('移入回收站') : historyAction.action === 'empty' ? t('清空回收站') : t('永久删除')}</Button>
        </div>
      </Modal>}
      {deleteNodeID && (
        <Modal
          title={t('删除配对机器')}
          subtitle={nodeName(deleteNodeID)}
          close={() => setDeleteNodeID(null)}
        >
          <p>{t('将取消与这台机器的配对。由它发来且仍在本机执行的任务将停止。')}</p>
          {error && <p className="error">{systemText(error)}</p>}
          <div className="modal-actions">
            <Button onClick={() => setDeleteNodeID(null)}>{t('取消')}</Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await api(`/network/trusted/${deleteNodeID}/revoke`, { confirmed: true });
                  setDeleteNodeID(null);
                })
              }
            >
              {t('确认删除')}
            </Button>
          </div>
        </Modal>
      )}
    </ResizableWorkspace>
  );
}
