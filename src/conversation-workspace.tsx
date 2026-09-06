import { useEffect, useRef, useState, type FormEvent } from 'react';
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
  Radio,
  PanelLeft,
  FileCode2,
  Bot,
  ShieldCheck,
  ChevronRight,
  AtSign,
  Pencil,
  Pause,
} from 'lucide-react';
import { api, ApiError, type CreatedNodeTaskResponse } from './api';
import { desktop, chooseProjectDirectory } from './desktop';
import { NodeNetworkView } from './node-network';
import { ModelSettingsView } from './model-settings';
import { NodeAvatar, NodeProfileEditor, NodeRemarkEditor } from './node-avatar';
import {
  activeNodeMention,
  isNodeMentionComposing,
  nodeCapabilitySummary,
  nodeDisplayName,
  recentNodeMentions,
  type ActiveNodeMention,
} from './node-mentions';
import {
  clearSubmittedDraft,
  conversationCreationNeedsModel,
  createConversationDraft,
  createdConversationKey,
  prepareConversationRequest,
  updateConversationDraft,
  type ConversationDraft,
  type ConversationRouting,
} from './conversation-drafts';
import { Button, Field, Mark, Modal, Wordmark } from './ui';
import {
  conversations,
  conversationState,
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
  new Date(value).toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

function queueConversation(entry: NodeQueueItem, items: Conversation[]) {
  const source = entry.source;
  return items.find((item) =>
    source.kind === 'local'
      ? item.localTask?.id === source.taskID
      : item.remote?.id === source.remoteTaskID ||
        item.attempts.some((attempt) => attempt.id === source.remoteTaskID),
  );
}

function QueuePanel({
  snapshot,
  items,
  nodeName,
  busy,
  error,
  open,
  control,
  pause,
  retry,
}: {
  snapshot: NodeQueueSnapshot | null;
  items: Conversation[];
  nodeName: (id: string | null) => string;
  busy: boolean;
  error: string;
  open: (item: Conversation) => void;
  control: (entry: NodeQueueItem, action: NodeQueueAction) => void;
  pause: (paused: boolean) => void;
  retry?: () => void;
}) {
  const entries = snapshot?.entries.filter((entry) => entry.state !== 'ended') || [];
  return (
    <section className="node-queue">
      <div className="rail-heading">
        <ListOrdered size={17} />
        <h2>本机执行队列</h2>
        <span>{snapshot ? entries.length : '—'}</span>
      </div>
      <div className="queue-toolbar">
        <small>
          {error ? '正在确认队列状态' : snapshot?.paused ? '后续启动已暂停' : '按本机接收顺序执行'}
        </small>
        <button
          type="button"
          disabled={busy || !snapshot || !!error}
          onClick={() => pause(!snapshot?.paused)}
        >
          {snapshot?.paused ? <Play size={12} /> : <Pause size={12} />}
          {snapshot?.paused ? '恢复队列' : '暂停队列'}
        </button>
      </div>
      {error && (
        <p className="queue-sync-error" role="status">
          {error}
        </p>
      )}
      {retry && (
        <p className="queue-pending-operation" role="status">
          上次队列操作结果未确认。
          <button type="button" onClick={retry}>
            重试确认
          </button>
        </p>
      )}
      <div className="queue-list">
        {entries.map((entry) => {
          const item = queueConversation(entry, items);
          const incoming = item?.incoming ?? entry.source.kind === 'remote';
          const title = item?.title || '正在同步会话';
          const reason = queueReasonLabel(entry.blockReason || entry.endReason);
          const state =
            entry.state === 'held'
              ? '已暂缓'
              : entry.state === 'admitted'
                ? item
                  ? conversationState(item)
                  : '已获执行槽'
                : reason || (entry.position ? `当前候选第 ${entry.position} 位` : '等待执行条件');
          return (
            <article className={`queue-card ${incoming ? 'incoming' : 'own'}`} key={entry.id}>
              <button
                className="queue-item"
                disabled={!item}
                onClick={() => item && open(item)}
                title={title}
              >
                <span className="queue-number">
                  {entry.state === 'admitted' ? (
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
                      : '自己发起'}{' '}
                    · {state}
                  </small>
                </span>
                <ChevronRight size={14} />
              </button>
              {['waiting', 'held'].includes(entry.state) && (
                <div className="queue-controls" aria-label={`${title} 的队列操作`}>
                  <button
                    type="button"
                    aria-label={`上移 ${title}`}
                    title="上移"
                    disabled={busy || !!error}
                    onClick={() => control(entry, 'up')}
                  >
                    <ArrowUp size={12} />
                  </button>
                  <button
                    type="button"
                    aria-label={`下移 ${title}`}
                    title="下移"
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
                    {entry.state === 'held' ? '恢复' : '暂缓'}
                  </button>
                  <button
                    type="button"
                    disabled={busy || !!error}
                    onClick={() => control(entry, 'reject')}
                  >
                    <X size={12} />
                    拒绝
                  </button>
                </div>
              )}
              {entry.state === 'admitted' && (
                <p className="queue-protected">
                  {item?.localTask?.state === 'accepted' ||
                  item?.remote?.executionState === 'accepted' ||
                  item?.brainTask?.status === 'completed'
                    ? '执行已完成 · 正在同步队列'
                    : '执行槽已保留 · 在会话中继续处理'}
                </p>
              )}
            </article>
          );
        })}
        {!entries.length && (
          <div className="rail-empty">
            <Check size={20} />
            <span>{snapshot ? '当前没有等待执行的会话' : '正在读取本机队列'}</span>
          </div>
        )}
      </div>
    </section>
  );
}

function Transcript({ item, source }: { item: Conversation; source: string }) {
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
  const summary = item.brainTask?.executionSummary || item.remote?.executionSummary;
  return (
    <>
      {displayed.map((message) => (
        <article className={`chat-message ${message.role}`} key={message.id}>
          <div className="chat-message-byline">
            {message.role === 'assistant' ? <Bot size={17} /> : <MessageSquare size={15} />}
            <strong>{message.role === 'assistant' ? 'Rivloom' : source}</strong>
          </div>
          {message.text && (
            <div className="chat-message-text">
              {message.id === firstUser?.id
                ? item.description.split('\n\n补充要求：')[0]
                : message.text}
            </div>
          )}
          {message.tools.map((tool, index) => (
            <details className="chat-tool" key={index}>
              <summary>
                <FileCode2 size={15} />
                <span>{tool.title || tool.name}</span>
                <small>{tool.status}</small>
              </summary>
              <pre>{tool.output || '等待执行结果…'}</pre>
            </details>
          ))}
        </article>
      ))}
      {!task && summary && (
        <article className="chat-message assistant">
          <div className="chat-message-byline">
            <Bot size={17} />
            <strong>执行结果</strong>
          </div>
          <div className="chat-message-text">{summary}</div>
        </article>
      )}
      {task && activeStates.includes(task.state) && (
        <div className="chat-progress" role="status">
          <LoaderCircle size={15} className="spin" />
          {task.state === 'running' ? '正在处理…' : conversationState(item)}
        </div>
      )}
    </>
  );
}

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
  const [view, setView] = useState<'chat' | 'network' | 'models'>('chat');
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [search, setSearch] = useState('');
  const [drafts, setDrafts] = useState<Record<string, ConversationDraft>>(() => ({
    new: createConversationDraft(),
  }));
  const emptyDraft = useRef(createConversationDraft());
  const [busy, setBusy] = useState(false);
  const operation = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [modal, setModal] = useState<'profile' | 'folder' | 'review' | 'queue' | null>(null);
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
    data.executionPolicy.projectID || data.projects[0]?.id || '',
  );
  const [model, setModel] = useState(data.defaultModel);
  const [mode, setMode] = useState<ApprovalMode>('ask');
  const [criteria, setCriteria] = useState('');
  const [options, setOptions] = useState(false);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [mention, setMention] = useState<ActiveNodeMention | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [remarkNodeID, setRemarkNodeID] = useState<string | null>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const scrollPinned = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const all = conversations(data);
  const current = all.find((item) => item.key === selected);
  const task = current?.localTask;
  const remote = current?.remote;
  const draftKey = selected || 'new';
  const draftState = drafts[draftKey] || emptyDraft.current;
  const draft = draftState.text;
  const changeDraft = (change: Partial<Pick<ConversationDraft, 'text' | 'routing'>>) =>
    setDrafts((previous) => ({
      ...previous,
      [draftKey]: updateConversationDraft(previous[draftKey] || emptyDraft.current, change),
    }));
  const setDraft = (text: string) => changeDraft({ text });
  const setRouting = (routing: ConversationRouting) => changeDraft({ routing });
  const scope = draftState.routing.kind === 'automatic' ? 'automatic' : 'local';
  const setScope = (kind: 'local' | 'automatic') => setRouting({ kind });
  const targetNodeID = draftState.routing.kind === 'node' ? draftState.routing.nodeID : null;
  const local = data.network.local;
  const peers = pairedNodes(data);
  const targetNode = peers.find((node) => node.id === targetNodeID) || null;
  const targetName = targetNode
    ? nodeDisplayName(targetNode)
    : draftState.routing.kind === 'node'
      ? `${draftState.routing.name} · ${draftState.routing.nodeID.slice(0, 6)}`
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
    ? taskReceiptView(current, {
        connected:
          connected &&
          !connectionError &&
          (remote?.direction !== 'outgoing' || !!(receiptPeer?.online && receiptPeer.channelReady)),
        queueEntry: currentQueueEntry,
        queueConfirmed: !queueError,
      })
    : null;
  const nodes = [...(local ? [local] : []), ...peers, ...data.network.nearby];
  const nodeName = (id: string | null) => {
    const node = nodes.find((candidate) => candidate.id === id);
    return node ? nodeDisplayName(node) : id ? `Node ${id.slice(0, 6)}` : '本机';
  };
  const sourceName = current?.incoming ? nodeName(current.sourceNodeID) : '你';
  const visible = all.filter((item) =>
    `${item.title} ${nodeName(item.sourceNodeID)}`.toLowerCase().includes(search.toLowerCase()),
  );
  const canRemoteControl =
    !!remote && remote.direction === 'outgoing' && remote.executionSequence > 0 && data.user.owner;
  const canWriteLocal = !!task && [task.creatorID, task.assigneeID].includes(data.user.id);
  const finished =
    task?.state === 'accepted' ||
    (!task &&
      (current?.brainTask?.status === 'completed' || remote?.executionState === 'accepted'));
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
    (!finished && !queueRejected && (canWriteLocal || canRemoteControl));
  const approvals = task?.approvals || remote?.remoteApprovals || [];
  const questions = task?.questions || remote?.remoteQuestions || [];
  const artifacts = task?.artifacts || remote?.remoteArtifacts || [];
  const reviewing = task?.state === 'review' || (!task && remote?.executionState === 'review');
  const running = task
    ? activeStates.includes(task.state) || task.state === 'interrupted'
    : !!remote &&
      remote.executionState !== 'not_started' &&
      activeStates.includes(remote.executionState);
  const canApprove = task ? task.approverID === data.user.id : canRemoteControl;
  const canReview = task ? task.reviewerID === data.user.id : canRemoteControl;

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
            previous && previous.version > snapshot.version ? previous : snapshot,
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
  useEffect(() => {
    scrollPinned.current = true;
  }, [selected]);
  useEffect(() => {
    if (transcript.current && scrollPinned.current)
      transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [selected, task?.messages, current?.brainTask?.executionSummary, task?.state]);
  useEffect(() => {
    if (!inputRef.current) return;
    inputRef.current.style.height = 'auto';
    inputRef.current.style.height = `${Math.min(180, inputRef.current.scrollHeight)}px`;
  }, [draft, selected]);

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
      setError((e as Error).message);
      return false;
    } finally {
      try {
        await refresh();
      } catch {
        setError((previous) => previous || '会话列表暂时无法更新，正在等待状态恢复。');
      } finally {
        setBusy(false);
        operation.current = false;
      }
    }
  }
  function open(item: Conversation | null) {
    selectedRef.current = item?.key || null;
    setSelected(item?.key || null);
    setMention(null);
    setView('chat');
    setError('');
    setNotice('');
    setMobileSidebar(false);
  }
  function chooseMentionNode(nodeID: string) {
    if (operation.current) return;
    const node = peers.find((candidate) => candidate.id === nodeID);
    if (!node || !mention) return;
    const next = `${draft.slice(0, mention.start)}@${node.name} ${draft.slice(mention.end)}`;
    const cursor = mention.start + node.name.length + 2;
    changeDraft({ text: next, routing: { kind: 'node', nodeID: node.id, name: node.name } });
    setMention(null);
    setMentionIndex(0);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(cursor, cursor);
    });
  }
  async function refreshQueue() {
    if (!data.user.owner) return;
    try {
      const snapshot = await api<NodeQueueSnapshot>('/node-queue');
      setQueueSnapshot((previous) =>
        previous && previous.version > snapshot.version ? previous : snapshot,
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
    if (!remote || !canRemoteControl) throw new Error('此会话当前没有可用的远程操作通道。');
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
    if (!text || busy || !canWrite) return;
    if (!current && draftState.routing.kind === 'local' && !projectID) {
      setModal('folder');
      return;
    }
    await perform(async () => {
      if (current) {
        if (task) {
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
        const acceptance = criteria.trim() || '完成会话要求，说明结果、验证情况和仍需处理的问题。';
        const routing = draftState.routing;
        const body = {
          title,
          description: text,
          criteria: acceptance,
          ...(routing.kind === 'local'
            ? {
                projectID,
                model,
                approvalMode: mode,
                runRequested: true,
                assigneeID: data.user.id,
                approverID: data.user.id,
                reviewerID: data.user.id,
              }
            : {
                ...(routing.kind === 'automatic' ? { requestedProjectID: projectID || null } : {}),
                requirements: {},
                confirmed: true,
              }),
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
          setDrafts((previous) => clearSubmittedDraft(previous, draftKey, prepared.requestID));
        };
        if (routing.kind === 'node') {
          // Always use the bound ID, including when the directory is temporarily unavailable.
          const result = await api<CreatedNodeTaskResponse>(
            `/network/nodes/${routing.nodeID}/tasks`,
            {
              ...body,
              requestID: prepared.requestID,
            },
            { timeoutMilliseconds: 15_000 },
          );
          completeCreation(result.createdTaskID);
        } else if (routing.kind === 'automatic') {
          const result = await api<CreatedNodeTaskResponse>(
            '/network/tasks',
            {
              ...body,
              requestID: prepared.requestID,
            },
            { timeoutMilliseconds: 15_000 },
          );
          completeCreation(result.createdTaskID);
        } else {
          const result = await api<Task>(
            '/tasks',
            { ...body, requestID: prepared.requestID },
            { timeoutMilliseconds: 15_000 },
          );
          completeCreation(result.id);
          await refreshQueue();
          setNotice('会话已保存到本机执行队列，执行条件就绪后会自动开始。');
        }
      }
    });
  }

  const networkActions = {
    onRequestPairing: (nodeID: string) => void perform(() => api('/network/pairings', { nodeID })),
    onConfirmPairing: (id: string) =>
      void perform(() => api(`/network/pairings/${id}/confirm`, {})),
    onCancelPairing: (id: string) => void perform(() => api(`/network/pairings/${id}/cancel`, {})),
    onRevokeTrust: (id: string) => {
      if (confirm('撤销配对后，将停止这台设备发来且仍在本机执行的任务。确定撤销吗？'))
        void perform(() => api(`/network/trusted/${id}/revoke`, { confirmed: true }));
    },
    onEditNodeRemark: (id: string) => setRemarkNodeID(id),
    onCreateRemoteTask: (input: { title: string; description: string; criteria: string }) =>
      void perform(() => api('/network/tasks', { ...input, confirmed: true })),
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
    <div
      className={`conversation-shell ${rail ? 'with-network' : ''} ${mobileSidebar ? 'sidebar-open' : ''}`}
    >
      {mobileSidebar && (
        <button
          className="sidebar-scrim"
          aria-label="收起会话栏"
          onClick={() => setMobileSidebar(false)}
        />
      )}
      <aside className="conversation-sidebar" aria-label="历史会话">
        <button
          className="node-identity-button"
          onClick={() => setModal('profile')}
          disabled={!local || !data.user.owner}
          title="编辑 Node 名称与图标"
        >
          <NodeAvatar icon={local?.icon} name={local?.name} />
          <span>
            <strong>{local?.name || '我的 Node'}</strong>
            <small>
              <i className={connected ? 'status-dot online' : 'status-dot'} />
              {connected ? '本机在线' : '正在连接'}
            </small>
          </span>
          <ChevronDown size={15} />
        </button>
        <button className="new-conversation" onClick={() => open(null)}>
          <Plus size={18} />
          新会话<span>↗</span>
        </button>
        <label className="conversation-search">
          <Search size={15} />
          <input
            aria-label="搜索会话"
            placeholder="搜索会话"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className="history-heading">
          <span>历史会话</span>
          <span>{all.length}</span>
        </div>
        <div className="conversation-history">
          {visible.map((item) => (
            <button
              key={item.key}
              aria-current={view === 'chat' && selected === item.key ? 'page' : undefined}
              className={`conversation-item ${item.incoming ? 'incoming' : 'own'} ${view === 'chat' && selected === item.key ? 'selected' : ''}`}
              onClick={() => open(item)}
              title={item.title}
            >
              <span className="conversation-item-top">
                <MessageSquare size={15} />
                <strong>{item.title}</strong>
              </span>
              <span className="conversation-item-meta">
                {item.incoming ? (
                  <>
                    <NodeAvatar small icon={nodes.find((n) => n.id === item.sourceNodeID)?.icon} />
                    <span>{nodeName(item.sourceNodeID)}</span>
                  </>
                ) : (
                  <span>自己发起</span>
                )}
                <small>{conversationState(item)}</small>
              </span>
            </button>
          ))}
          {!visible.length && (
            <div className="history-empty">
              {search ? '没有匹配的会话' : '你的会话会保存在这里'}
            </div>
          )}
        </div>
        <nav className="conversation-settings" aria-label="设置">
          <button
            className={view === 'network' ? 'active' : ''}
            onClick={() => {
              setView('network');
              setMobileSidebar(false);
            }}
          >
            <Network size={17} />
            节点与 Brain
            <ChevronRight size={14} />
          </button>
          <button
            className={view === 'models' ? 'active' : ''}
            onClick={() => {
              setView('models');
              setMobileSidebar(false);
            }}
          >
            <Settings2 size={17} />
            模型与额度
            <ChevronRight size={14} />
          </button>
          <div className="sidebar-signature">
            <Wordmark />
            <small>0.1.4</small>
          </div>
        </nav>
      </aside>
      <main className="conversation-center">
        <header className="conversation-header">
          <button
            className="icon-button mobile-nav"
            aria-label="打开会话栏"
            onClick={() => setMobileSidebar(true)}
          >
            <PanelLeft size={18} />
          </button>
          {view !== 'chat' && (
            <button className="icon-button" aria-label="返回会话" onClick={() => setView('chat')}>
              <ArrowLeft size={18} />
            </button>
          )}
          <div>
            <span>
              {view === 'network'
                ? '节点与 Brain'
                : view === 'models'
                  ? '模型与额度'
                  : current?.title || '新会话'}
            </span>
            {view === 'chat' && current && <small>{conversationState(current)}</small>}
          </div>
          {view === 'chat' && data.user.owner && (
            <button
              className="local-queue-entry"
              onClick={() => setModal('queue')}
              aria-label="打开本机执行队列"
            >
              <ListOrdered size={15} />
              <span>本机队列</span>
            </button>
          )}
          <span className="header-status">
            <i className={`status-dot ${connected ? 'online' : ''}`} />
            {connected ? '已连接' : '正在重连'}
          </span>
        </header>
        {(error || connectionError) && (
          <div className="workspace-alert error" role="alert">
            {error || connectionError}
            <button className="icon-button" aria-label="关闭错误" onClick={() => setError('')}>
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
            <div
              className={`conversation-body ${current ? '' : 'blank'}`}
              ref={transcript}
              onScroll={() => {
                const element = transcript.current;
                if (element)
                  scrollPinned.current =
                    element.scrollHeight - element.scrollTop - element.clientHeight < 100;
              }}
            >
              {current ? (
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
                            更新于 {dateLabel(currentReceipt.updatedAt)}
                          </time>
                        )}
                      </div>
                    </section>
                  )}
                  <Transcript item={current} source={sourceName} />
                  {task?.error && <p className="error">{task.error}</p>}
                  {approvals.map((approval) => (
                    <section className="chat-approval" key={approval.id}>
                      <h3>
                        <ShieldCheck size={18} />
                        需要你的批准
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
                                    ? api(`/tasks/${task.id}/permissions/${approval.id}`, { reply })
                                    : control({
                                        kind: 'permission',
                                        requestID: approval.id,
                                        reply,
                                      }),
                                )
                              }
                            >
                              {reply === 'once' ? '仅本次允许' : '拒绝'}
                            </Button>
                          ))}
                        </div>
                      ) : (
                        <p className="muted">等待指定审批人处理。</p>
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
                      <h3>补充一点信息</h3>
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
                        回复
                      </Button>
                    </form>
                  ))}
                  <div className="chat-actions">
                    {task &&
                      task.assigneeID === data.user.id &&
                      !queueRejected &&
                      !['waiting', 'held'].includes(currentQueueEntry?.state || '') &&
                      !(currentQueueEntry?.state === 'admitted' && !task.sessionID) &&
                      ['open', 'ready', 'stopped', 'failed', 'interrupted', 'review'].includes(
                        task.state,
                      ) && (
                        <Button
                          disabled={busy || !data.engine.ready}
                          onClick={() => void perform(() => runLocal(task))}
                        >
                          <Play size={14} />
                          {task.sessionID ? '继续执行' : '开始执行'}
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
                        停止
                      </Button>
                    )}
                    {reviewing && canReview && (
                      <Button
                        variant="primary"
                        disabled={busy || remote?.controlPending}
                        onClick={() => setModal('review')}
                      >
                        <Check size={15} />
                        确认完成
                      </Button>
                    )}
                  </div>
                  {current && (
                    <details className="conversation-details">
                      <summary>
                        会话详情与执行记录
                        <ChevronDown size={14} />
                      </summary>
                      <dl>
                        <dt>来源</dt>
                        <dd>{nodeName(current.sourceNodeID)}</dd>
                        <dt>创建时间</dt>
                        <dd>{dateLabel(current.createdAt)}</dd>
                        <dt>验收要求</dt>
                        <dd>{task?.criteria || current.brainTask?.criteria || remote?.criteria}</dd>
                        {task && (
                          <>
                            <dt>文件夹</dt>
                            <dd>{data.projects.find((p) => p.id === task.projectID)?.directory}</dd>
                            <dt>模型 / 审批</dt>
                            <dd>
                              {task.model} · {approvalModeLabels[task.approvalMode]}
                            </dd>
                          </>
                        )}
                        {current.brainTask && (
                          <>
                            <dt>归属 Brain</dt>
                            <dd>{current.brainTask.brainID}</dd>
                            <dt>执行节点</dt>
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
                          尚无官方文件差异。验收时请结合执行记录与实际文件核对。
                        </p>
                      )}
                      {current.brainTask?.executions.map((execution) => (
                        <p className="execution-history-row" key={execution.executionID}>
                          第 {execution.attempt} 次 · {nodeName(execution.workerNodeID)} ·{' '}
                          {execution.status}
                          <small>{execution.summary}</small>
                        </p>
                      ))}
                      {activities.map((activity) => (
                        <p className="execution-history-row" key={activity.id}>
                          {activity.text}
                          <small>{dateLabel(activity.at)}</small>
                        </p>
                      ))}
                    </details>
                  )}
                </div>
              ) : (
                <div className="blank-conversation">
                  <span className="blank-mark">
                    <Mark />
                  </span>
                  <span className="blank-eyebrow">RIVLOOM</span>
                  <h1>{awaitingCreatedConversation ? '会话已保存' : '今天，想完成什么？'}</h1>
                  <p>
                    {awaitingCreatedConversation
                      ? '正在等待会话状态更新。'
                      : '从一个想法、一段问题，或一项工作开始。'}
                  </p>
                </div>
              )}
            </div>
            <div className="composer-area">
              <form
                className={`conversation-composer ${!canWrite ? 'read-only' : ''}`}
                onSubmit={send}
              >
                <textarea
                  ref={inputRef}
                  aria-label="会话消息"
                  aria-controls={mention ? 'node-mention-options' : undefined}
                  aria-activedescendant={
                    mentionNodes[mentionIndex]
                      ? `node-mention-${mentionNodes[mentionIndex].id}`
                      : undefined
                  }
                  placeholder={
                    queueRejected
                      ? '此项工作已被拒绝，请新建会话提交新的工作'
                      : waitingForRemoteSession
                        ? '等待目标 Node 准备执行会话，开始后可补充要求'
                        : finished
                          ? '会话已完成，点击「新会话」开始新的工作'
                          : !canWrite
                            ? '当前只能查看此会话的执行状态'
                            : current
                              ? '继续对话，补充你的要求…'
                              : '有什么想交给 Rivloom？'
                  }
                  value={draft}
                  onChange={(event) => {
                    const next = event.target.value;
                    setDraft(next);
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
                  maxLength={!current && draftState.routing.kind !== 'local' ? 4000 : 12000}
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
                {mention && (
                  <div
                    id="node-mention-options"
                    className="node-mention-menu"
                    role="listbox"
                    aria-label="最近使用的 Node"
                  >
                    <div className="node-mention-heading">
                      <AtSign size={14} />
                      <span>{mention.query ? '匹配的 Node' : '最近使用的 Node'}</span>
                    </div>
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
                                    ? '负载等待更新'
                                    : '队列信息未提供或待更新')}
                              </small>
                            )}
                          </span>
                          <i
                            className={`status-dot ${node.online && node.channelReady ? 'online' : ''}`}
                          />
                        </button>
                      );
                    })}
                    {!mentionNodes.length && <p>没有匹配的已配对 Node</p>}
                  </div>
                )}
                {!current && targetNodeID && (
                  <div
                    className={`directed-node-chip ${!targetNode ? 'unavailable' : ''}`}
                    title={`固定目标：${targetName}（${targetNodeID}）`}
                  >
                    <AtSign size={14} />
                    <span>
                      任务将发送给 {targetName}
                      {!targetNode && ' · 目标暂未出现在已配对目录中，重试时会确认原投递'}
                    </span>
                    <button
                      type="button"
                      aria-label="取消指定 Node，改为本机执行"
                      title="取消指定 Node，改为本机执行"
                      disabled={busy}
                      onClick={() => setRouting({ kind: 'local' })}
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
                              aria-label="工作文件夹"
                              disabled={busy}
                              value={projectID}
                              onChange={(event) => {
                                if (event.target.value === '__add__') setModal('folder');
                                else setProjectID(event.target.value);
                              }}
                            >
                              <option value="">
                                {scope === 'automatic' ? '临时工作目录' : '选择文件夹'}
                              </option>
                              {data.projects.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name}
                                </option>
                              ))}
                              {data.user.owner && <option value="__add__">添加文件夹…</option>}
                            </select>
                          </label>
                        )}
                        {!targetNodeID && scope === 'local' && (
                          <label className="composer-select model-select">
                            <Bot size={15} />
                            <select
                              aria-label="执行模型"
                              disabled={busy}
                              value={model}
                              onChange={(e) => setModel(e.target.value)}
                            >
                              {!data.engine.models.some((m) => m.id === model) && (
                                <option value={model}>
                                  {data.engine.models.length ? '选择模型' : '尚未连接模型'}
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
                          aria-label="会话设置"
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
                    aria-label="发送消息"
                    disabled={
                      busy ||
                      !draft.trim() ||
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
                          <small>执行位置</small>
                          <strong>{targetName}</strong>
                        </span>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setRouting({ kind: 'local' })}
                        >
                          取消指定，改为本机
                        </button>
                      </div>
                    ) : (
                      <Field label="执行位置">
                        <select
                          value={scope}
                          disabled={busy}
                          onChange={(e) => {
                            setScope(e.target.value as typeof scope);
                            if (e.target.value === 'automatic') setProjectID('');
                          }}
                        >
                          <option value="local">本机执行</option>
                          {data.user.owner && <option value="automatic">自动分配到可用节点</option>}
                        </select>
                      </Field>
                    )}
                    {!targetNodeID && scope === 'local' ? (
                      <Field label="AI 审批">
                        <select
                          value={mode}
                          disabled={busy}
                          onChange={(e) => setMode(e.target.value as ApprovalMode)}
                        >
                          {Object.entries(approvalModeLabels).map(([value, label]) => (
                            <option value={value} key={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </Field>
                    ) : (
                      <p className="muted">执行节点使用自己的模型和审批设置。</p>
                    )}
                    {mode === 'full' && scope === 'local' && !targetNodeID && (
                      <p className="notice">
                        允许文件、命令、联网及项目外目录操作自动执行。请只用于你信任的环境。
                      </p>
                    )}
                    <Field label="完成要求（可选）">
                      <textarea
                        value={criteria}
                        disabled={busy}
                        onChange={(e) => setCriteria(e.target.value)}
                        maxLength={scope === 'automatic' || targetNodeID ? 2000 : 4000}
                        rows={2}
                        placeholder="例如：通过测试，并说明修改结果"
                      />
                    </Field>
                  </div>
                )}
              </form>
              <div className="composer-hint">
                {waitingForRemoteSession
                  ? '当前可查看投递与排队状态；目标准备执行会话后可补充要求。'
                  : !canWrite && !finished
                    ? '执行状态由归属节点同步；当前节点没有可用的继续操作权限。'
                    : running
                      ? '发送补充要求会先停止当前执行，再继续同一会话。'
                      : current
                        ? 'Enter 发送 · Shift + Enter 换行'
                        : targetNodeID
                          ? `发送后由 ${targetName} 按自己的模型和审批设置执行。`
                          : scope === 'automatic'
                            ? '发送后由可用节点执行，文件和模型由执行节点管理。'
                            : '发送后在所选文件夹执行，AI 按当前审批设置操作。'}
              </div>
            </div>
          </>
        ) : (
          <div className="conversation-settings-page">
            {view === 'models' ? (
              <ModelSettingsView
                owner={data.user.owner}
                engineReady={data.engine.ready}
                onChanged={() => void refresh()}
              />
            ) : (
              <>
                <NodeNetworkView
                  network={data.network}
                  owner={data.user.owner}
                  projects={data.projects}
                  models={data.engine.models}
                  executionPolicy={data.executionPolicy}
                  busy={busy}
                  conversationsInSidebar
                  {...networkActions}
                />
                {data.user.owner && (
                  <Button onClick={() => setModal('folder')}>
                    <FolderOpen size={16} />
                    添加执行文件夹
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </main>
      {rail && (
        <aside className="network-rail" aria-label="本机队列和机器状态">
          {data.user.owner ? queuePanel() : <p className="muted">本机队列由 Node 所有者管理。</p>}
          <section className="paired-machines">
            <div className="rail-heading">
              <Radio size={17} />
              <h2>已配对机器</h2>
              <span>{peers.length}</span>
            </div>
            <div className="machine-list">
              {peers.map((node) => {
                const capability = nodeCapabilitySummary(
                  node,
                  Date.now(),
                  connected && !connectionError,
                );
                const fresh = capability.loadFresh;
                return (
                  <article
                    className={`machine-card ${node.online ? '' : 'offline'}`}
                    key={node.id}
                    title={capability.detail}
                  >
                    <div className="machine-heading">
                      <NodeAvatar icon={node.icon} name={node.name} />
                      <div>
                        <strong>{nodeDisplayName(node)}</strong>
                        <small>
                          <i
                            className={`status-dot ${node.online && node.channelReady ? 'online' : ''}`}
                          />
                          {capability.status}
                        </small>
                      </div>
                      {data.user.owner && (
                        <button
                          className="machine-remark-button"
                          aria-label={`编辑 ${node.name} 的备注名`}
                          title="编辑本地备注名"
                          onClick={() => setRemarkNodeID(node.id)}
                        >
                          <Pencil size={13} />
                        </button>
                      )}
                    </div>
                    {fresh && node.worker && (
                      <div className="machine-load">
                        <span>
                          执行中 <b>{node.worker.load.runningTasks}</b>
                        </span>
                        <span>
                          空闲槽 <b>{node.worker.load.availableSlots}</b>
                        </span>
                        <span>
                          等待 <b>{capability.waiting ?? '未知'}</b>
                        </span>
                        <div className="machine-load-bar">
                          <i
                            style={{
                              width: `${Math.max(0, Math.min(100, node.worker.load.memoryUsedPercent))}%`,
                            }}
                          />
                        </div>
                        <small>
                          内存 {Math.round(node.worker.load.memoryUsedPercent)}%
                          {node.worker.load.cpuPercent !== null
                            ? ` · CPU ${Math.round(node.worker.load.cpuPercent)}%`
                            : ''}
                        </small>
                      </div>
                    )}
                    {node.online && node.channelReady && node.worker && !fresh && (
                      <p className="muted">等待最新负载</p>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
          <div className="rail-footer">
            <i className={`status-dot ${connected ? 'online' : ''}`} />
            {connected ? '状态实时同步' : '正在恢复状态连接'}
          </div>
        </aside>
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
          title="本机执行队列"
          subtitle="调整尚未开始的工作；已保留的执行槽保持原任务归属。"
          close={() => setModal(null)}
        >
          {queuePanel()}
        </Modal>
      )}
      {rejectQueueEntry && (
        <Modal
          title="拒绝执行此项工作"
          subtitle={queueConversation(rejectQueueEntry, all)?.title || '尚未开始的排队项'}
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
            <Field label="拒绝原因" hint="原因会保存在原会话，并告知任务发起方。">
              <textarea
                name="reason"
                disabled={busy || !!pendingQueueRequest}
                required
                maxLength={500}
                rows={3}
                placeholder="说明这台 Node 无法继续执行的原因"
              />
            </Field>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <Button onClick={() => setRejectQueueEntry(null)}>返回</Button>
              {pendingQueueRequest && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void executeQueueRequest(pendingQueueRequest).then((ok) => {
                      if (ok) setRejectQueueEntry(null);
                    })
                  }
                >
                  重试确认
                </Button>
              )}
              <Button type="submit" disabled={busy || !!pendingQueueRequest}>
                拒绝执行
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
          title="选择工作文件夹"
          subtitle="会话将在这个文件夹中执行。"
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
                    '工作文件夹',
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
            <Field label="文件夹路径">
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
                    .catch(() => setError('无法打开目录选择器，请手动填写路径。'))
                }
              >
                <FolderOpen size={16} />
                浏览本机文件夹
              </Button>
            )}
            <Field label="显示名称（可选）">
              <input
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                maxLength={60}
                placeholder="默认使用文件夹名称"
              />
            </Field>
            <label className="checkbox">
              <input type="checkbox" required />
              我信任此文件夹及其配置，允许 AI 按审批设置读取和修改文件。
            </label>
            {error && <p className="error">{error}</p>}
            <div className="modal-actions">
              <Button onClick={() => setModal(null)}>取消</Button>
              <Button type="submit" variant="primary" disabled={busy || !data.user.owner}>
                使用此文件夹
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {modal === 'review' && current && (
        <Modal
          title="确认会话完成"
          subtitle="请先检查实际文件和执行结果。"
          close={() => setModal(null)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const note = String(form.get('note'));
              void perform(async () => {
                if (task)
                  await api(`/tasks/${task.id}/accept`, {
                    version: task.version,
                    note,
                    confirmed: true,
                  });
                else await control({ kind: 'accept', note });
                setModal(null);
              });
            }}
          >
            <Field label="核对结果">
              <textarea
                name="note"
                required
                maxLength={4000}
                rows={4}
                placeholder="说明你检查了什么，以及完成情况"
              />
            </Field>
            <label className="checkbox">
              <input type="checkbox" required />
              已核对结果符合要求，确认完成。
            </label>
            {error && <p className="error">{error}</p>}
            <div className="modal-actions">
              <Button onClick={() => setModal(null)}>取消</Button>
              <Button type="submit" variant="primary" disabled={busy}>
                确认完成
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
