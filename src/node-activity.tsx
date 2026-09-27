import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Activity, ArrowDown, ArrowUp, BookOpen, Check, ChevronRight, CircleAlert, FolderOpen, Inbox, LoaderCircle, Monitor, Plug, X } from 'lucide-react';
import { t } from '../shared/i18n.ts';
import { knowledgeError } from '../shared/knowledge-errors.ts';
import type { NodeActivitySnapshot } from '../shared/node-activity.ts';
import type { NodeModelActivityCounts, NodeModelActivityRates } from '../shared/node-model-activity.ts';
import type { KnowledgeActivityAction, OperationActivity } from '../shared/operation-activity.ts';
import type { AttentionItem } from '../shared/task-attention.ts';
import type { NodeNetwork } from '../shared/types.ts';
import { api } from './api';
import { localActivity, type LocalActivity } from './local-activity';
import { officeMessage } from './office-messages';
import { machineStatus } from './machine-status';
import { activityFresh, activityRate, activityRateText, attentionAdded, knowledgeActivityVersion, visibleModelRates } from './sidebar-activity';

function useNodeActivity(identity: string, owner: boolean, connected: boolean) {
  const [visible, setVisible] = useState(() => !document.hidden);
  const [now, setNow] = useState(Date.now);
  const [received, setReceived] = useState<{ data: NodeActivitySnapshot; at: number; identity: string } | null>(null);
  useEffect(() => {
    const changed = () => { setVisible(!document.hidden); setNow(Date.now()); };
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [visible]);
  useEffect(() => {
    setReceived(null);
    if (!owner || !connected || !visible) return;
    let cancelled = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await api<NodeActivitySnapshot>('/node-activity', undefined, { signal: controller.signal, timeoutMilliseconds: 4000 });
        if (!cancelled) { const at = Date.now(); setReceived({ data, at, identity }); setNow(at); }
      } catch { if (!cancelled) setReceived(null); }
      finally { if (!cancelled) timer = setTimeout(poll, 1000); }
    };
    void poll();
    return () => { cancelled = true; controller.abort(); clearTimeout(timer); };
  }, [identity, owner, connected, visible]);
  const fresh = owner && received?.identity === identity && activityFresh(received.at, now, connected, visible);
  return { snapshot: fresh ? received.data : null, now, visible };
}

function RateValues({ rates }: { rates: NodeModelActivityRates }) {
  const input = activityRate(rates.inputTokensPerSecond), output = activityRate(rates.outputTokensPerSecond);
  return <>
    {input !== null && <span className="activity-rate" title={t('近60秒新确认输入量的平均速率，不是预填充速度')}><ArrowDown size={11} /><span>{t('入均')}</span><b>{activityRateText(input)}</b></span>}
    {output !== null && <span className="activity-rate output" title={t('近3秒流式文本与推理增量的估算速率')}><ArrowUp size={11} /><span>{t('出')}</span><b>≈{activityRateText(output)}</b></span>}
    {(input !== null || output !== null) && <small className="activity-unit">t/s</small>}
  </>;
}

function Wave({ moving }: { moving: boolean }) {
  return <span className={`activity-wave${moving ? ' moving' : ''}`} aria-hidden="true"><i /><i /><i /><i /><i /></span>;
}

function ActivityPopover({ anchor, title, close, children }: { anchor: HTMLElement; title: string; close: (restore?: boolean) => void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(close); closeRef.current = close;
  useLayoutEffect(() => {
    const element = ref.current!;
    const position = () => {
      if (!anchor.isConnected || !anchor.getClientRects().length) { closeRef.current(false); return; }
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(364, window.innerWidth - 24);
      element.style.width = `${width}px`;
      element.style.left = `${Math.max(12, Math.min(rect.right + 10, window.innerWidth - width - 12))}px`;
      element.style.top = `${Math.max(12, Math.min(rect.top, window.innerHeight - element.offsetHeight - 12))}px`;
    };
    position();
    element.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    const pointer = (event: PointerEvent) => { if (!element.contains(event.target as Node) && !anchor.contains(event.target as Node)) closeRef.current(false); };
    const focus = (event: FocusEvent) => { if (!element.contains(event.target as Node) && !anchor.contains(event.target as Node)) closeRef.current(false); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(true); }
      if (event.key === 'Tab') {
        const controls = [...element.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]')];
        if (document.activeElement === (event.shiftKey ? controls[0] : controls.at(-1))) {
          event.preventDefault(); event.stopPropagation(); closeRef.current(true);
        }
      }
    };
    const reposition = () => closeRef.current(false);
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !element.contains(event.target)) closeRef.current(false); };
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('focusin', focus);
    document.addEventListener('keydown', key, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', scroll, true);
    const resize = new ResizeObserver(position); resize.observe(element);
    // Polling can remove a badge or hide the sidebar while its portal is still mounted.
    const mutation = new MutationObserver(() => {
      if (!anchor.isConnected || !anchor.getClientRects().length) closeRef.current(false);
    });
    mutation.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    return () => {
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', scroll, true);
      resize.disconnect(); mutation.disconnect();
    };
  }, [anchor]);
  return createPortal(<section ref={ref} className="activity-popover" role="dialog" aria-label={title}>
    <header><strong>{title}</strong><button className="icon-button" aria-label={t('关闭')} onClick={() => close(true)}><X size={16} /></button></header>
    <div className="activity-popover-body">{children}</div>
  </section>, document.body);
}

function Counts({ counts }: { counts: NodeModelActivityCounts }) {
  return <div className="activity-counts">
    <span>{t('运行')} <b>{counts.active}</b></span>
    {counts.generating > 0 && <span>{t('生成中')} <b>{counts.generating}</b></span>}
    {counts.tools > 0 && <span>{t('工具执行')} <b>{counts.tools}</b></span>}
    {counts.waiting > 0 && <span>{t('等待')} <b>{counts.waiting}</b></span>}
    {counts.failed > 0 && <span className="activity-failure">{t('近60秒失败')} <b>{counts.failed}</b></span>}
  </div>;
}

function knowledgeAction(action: KnowledgeActivityAction) {
  switch (action) {
    case 'refresh': return t('更新目录'); case 'search': return t('查找知识'); case 'read': return t('读取知识');
    case 'save': return t('保存记忆'); case 'rules': return t('保存说明'); case 'organize': return t('整理分类');
    case 'share': return t('更新分享范围'); case 'register': return t('登记技能'); case 'remove': return t('移除条目'); case 'withdraw': return t('撤回记忆');
  }
}

type ActivityItem = { id: string; label: string; state: 'running' | 'completed' | 'partial' | 'failed'; action: string; error?: string; count?: number };
function StatusIcon({ state, action }: { state: ActivityItem['state']; action?: string }) {
  return state === 'running' ? <LoaderCircle size={13} className={`activity-running activity-action-${action || 'read'}`} />
    : state === 'completed' ? <Check size={13} /> : <CircleAlert size={13} />;
}

function OperationBadge({ items, label, open, expanded, paused }: { items: ActivityItem[]; label: string; open: (anchor: HTMLElement) => void; expanded: boolean; paused: boolean }) {
  const running = items.filter(item => item.state === 'running');
  const failed = items.some(item => item.state === 'failed' || item.state === 'partial');
  const main = running[0] || items.find(item => item.state !== 'completed') || items[0];
  if (!main) return null;
  return <button type="button" className={`operation-badge ${main.state}${failed ? ' has-failure' : ''}`} data-paused={paused} aria-label={label} aria-haspopup="dialog" aria-expanded={expanded}
    title={`${main.label}${failed ? ` · ${t('有操作未完成')}` : ''}`} onClick={event => open(event.currentTarget)}>
    <StatusIcon state={main.state} action={main.action} />{running.length > 1 && <small>{running.length}</small>}{failed && main.state === 'running' && <i />}
  </button>;
}

function OperationList({ items, dismiss }: { items: ActivityItem[]; dismiss: (id: string) => void }) {
  return items.length ? <ul className="activity-operation-list">{items.map(item => <li key={item.id} className={item.state}>
    <StatusIcon state={item.state} action={item.action} /><div><strong>{item.label}</strong>
      <small>{item.state === 'running' ? t('进行中') : item.state === 'completed' ? t('已完成') : item.state === 'partial' ? t('部分未完成') : t('未完成')}{item.count && item.count > 1 ? ` · ${item.count}` : ''}</small>
      {item.error && <p>{item.error}</p>}</div>
    {item.state !== 'running' && <button className="icon-button" aria-label={t('清除此提示')} onClick={() => dismiss(item.id)}><X size={13} /></button>}
  </li>)}</ul> : <p className="activity-empty">{t('当前没有操作')}</p>;
}

function knowledgeItems(operations: OperationActivity[], sampledAt: number): ActivityItem[] {
  return operations.filter(item => item.status !== 'completed' || sampledAt - (item.completedAt || item.updatedAt) < 3000)
    .map(item => ({ id: item.id, label: knowledgeAction(item.action), state: item.status, action: item.action,
      error: item.error ? knowledgeError(item.error) : undefined, count: item.activeCount || item.occurrences }));
}
function fileItems(operations: readonly LocalActivity[]): ActivityItem[] {
  return operations.map(item => ({ id: item.id, label: `${item.kind === 'file-read' ? t('读取文件') : t('保存文件')}${item.label ? ` · ${item.label}` : ''}`,
    state: item.state, action: item.kind === 'file-read' ? 'read' : 'save', error: item.errorCode ? officeMessage(item.errorCode) : undefined }));
}

export function SidebarActivityEntries({ identity, owner, connected, network, attentionItems, view, openConnections, openProjectFiles, openKnowledge, openAttention, openDevices }: {
  identity: string; owner: boolean; connected: boolean; network: NodeNetwork; attentionItems: AttentionItem[] | undefined; view: string;
  openConnections: () => void; openProjectFiles: () => void; openKnowledge: () => void; openAttention: () => void; openDevices: () => void;
}) {
  const { snapshot, now, visible } = useNodeActivity(identity, owner, connected);
  const files = useSyncExternalStore(localActivity.subscribe, localActivity.getSnapshot);
  const [panel, setPanel] = useState<{ kind: 'models' | 'knowledge' | 'files'; anchor: HTMLElement; identity: string } | null>(null);
  const [dismissError, setDismissError] = useState(false);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [bounce, setBounce] = useState(false);
  const previousAttention = useRef<AttentionItem[] | null>(null);
  const [deviceChange, setDeviceChange] = useState(false);
  const previousDevices = useRef<string | null>(null);
  const currentOwner = useRef({ identity, owner }); currentOwner.current = { identity, owner };
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => {
    localActivity.clear(); previousAttention.current = null; previousDevices.current = null;
    setPanel(null); setDismissed([]); setDismissError(false); setBounce(false); setDeviceChange(false);
  }, [identity]);
  useLayoutEffect(() => { if (!owner) { setPanel(null); setDismissed([]); setDismissError(false); } }, [owner]);
  useEffect(() => {
    if (!snapshot) return;
    const versions = new Set(snapshot.knowledge.map(knowledgeActivityVersion));
    setDismissed(previous => {
      const next = previous.filter(version => versions.has(version));
      return next.length === previous.length ? previous : next;
    });
  }, [snapshot]);
  useEffect(() => {
    if (!attentionItems) return;
    const added = attentionAdded(previousAttention.current, attentionItems);
    previousAttention.current = attentionItems;
    if (added && visible) setBounce(true);
  }, [attentionItems, visible]);
  useEffect(() => { if (!bounce) return; const timer = setTimeout(() => setBounce(false), 650); return () => clearTimeout(timer); }, [bounce]);
  const nodes = [...(network.local ? [network.local] : []), ...(network.paired || [])];
  const deviceState = connected ? nodes.map(node => `${node.id}:${node.online && node.channelReady}:${machineStatus(node, now, connected).executing ?? ''}`).sort().join('|') : null;
  const executing = visible && connected && nodes.some(node => (machineStatus(node, now, connected).executing || 0) > 0);
  useEffect(() => {
    if (deviceState !== null && previousDevices.current !== null && previousDevices.current !== deviceState && visible) setDeviceChange(true);
    previousDevices.current = deviceState;
  }, [deviceState, visible]);
  useEffect(() => { if (!deviceChange) return; const timer = setTimeout(() => setDeviceChange(false), 650); return () => clearTimeout(timer); }, [deviceChange]);
  useEffect(() => { if (!visible) { setPanel(null); setBounce(false); setDeviceChange(false); } }, [visible]);
  const models = snapshot?.models || null;
  const rates = visibleModelRates(models);
  const modelKnown = models && (rates.inputTokensPerSecond !== null || rates.outputTokensPerSecond !== null || (!models.limited && models.countsComplete && models.counts.active > 0) || models.counts.failed > 0 ||
    models.connections.some(connection => activityRate(connection.inputTokensPerSecond) !== null || activityRate(connection.outputTokensPerSecond) !== null || connection.countsComplete && connection.counts.active > 0 || connection.counts.failed > 0));
  const knowledge = knowledgeItems((snapshot?.knowledge || []).filter(item => !dismissed.includes(knowledgeActivityVersion(item))), models?.sampledAt || now);
  const fileOperations = fileItems(files);
  const openPanel = (kind: 'models' | 'knowledge' | 'files', anchor: HTMLElement) => { setDismissError(false); setPanel(previous => previous?.kind === kind ? null : { kind, anchor, identity }); };
  const closePanel = (restore = false) => { if (restore && panel?.anchor.isConnected) panel.anchor.focus({ preventScroll: true }); setPanel(null); };
  const dismissKnowledge = async (id: string) => {
    const operation = snapshot?.knowledge.find(item => item.id === id);
    if (!operation) return;
    const requestIdentity = identity, version = knowledgeActivityVersion(operation);
    const current = () => mounted.current && currentOwner.current.identity === requestIdentity && currentOwner.current.owner;
    setDismissError(false);
    try {
      const result = await api<{ dismissed: boolean }>('/node-activity/knowledge/dismiss', { id }, { timeoutMilliseconds: 4000 });
      if (current() && result.dismissed) setDismissed(previous => [...previous.filter(value => value !== version).slice(-31), version]);
    } catch { if (current()) setDismissError(true); }
  };
  return <>
    {owner && <div className="sidebar-model-entry">
      <button type="button" className="activity-office-entry" title={t('模型连接')} onClick={openConnections}><Plug size={16} /><span>{t('模型连接')}</span><Wave moving={visible && !!models?.countsComplete && !!models?.counts.generating} /><ChevronRight size={13} /></button>
      {modelKnown && <button type="button" className="sidebar-model-metrics" aria-label={t('查看模型活动')} aria-haspopup="dialog" aria-expanded={panel?.kind === 'models'} onClick={event => openPanel('models', event.currentTarget)}>
        {(models.limited || !models.countsComplete) && rates.inputTokensPerSecond === null && rates.outputTokensPerSecond === null && <Activity size={12} />}
        <RateValues rates={rates} />{!models.limited && models.countsComplete && <span className="activity-run-count" title={t('此Node正在运行的会话')}><Activity size={10} aria-hidden="true" /><b>{models.counts.active}</b> <span className="activity-run-label">{t('运行')}</span></span>}
        {models.counts.failed > 0 && <CircleAlert className="activity-failure" size={12} aria-label={t('有任务失败')} />}
      </button>}
    </div>}
    {owner && <div className="sidebar-file-entry"><button type="button" className="activity-office-entry" onClick={openProjectFiles}><FolderOpen size={16} /><span>{t('项目文件')}</span><ChevronRight size={13} /></button>
      <OperationBadge items={fileOperations} label={t('查看文件活动')} paused={!visible} expanded={panel?.kind === 'files'} open={anchor => openPanel('files', anchor)} /></div>}
    {owner && <div className="sidebar-utility-entry"><button type="button" className={`activity-utility${view === 'knowledge' ? ' active' : ''}`} title={t('技能与记忆')} onClick={openKnowledge}><BookOpen size={16} /><span>{t('知识')}</span></button>
      <OperationBadge items={knowledge} label={t('查看知识活动')} paused={!visible} expanded={panel?.kind === 'knowledge'} open={anchor => openPanel('knowledge', anchor)} /></div>}
    <button type="button" className="utility-nav-entry" title={t('待办中心')} aria-label={attentionItems ? `${t('待办中心')} · ${attentionItems.length}` : t('待办中心')} data-active={view === 'attention'} onClick={openAttention}>
      <Inbox size={16} /><span className="nav-label">{t('待办')}</span>{!!attentionItems?.length && <span className={`attention-count${bounce ? ' activity-bounce' : ''}`} aria-hidden="true">{attentionItems.length}</span>}
    </button>
    <button type="button" className={`utility-nav-entry${deviceChange ? ' activity-device-change' : ''}`} title={t('设备与模型')} aria-label={t('设备与模型')} data-active={['network', 'models', 'execution', 'diagnostics'].includes(view)} onClick={openDevices}>
      <Monitor size={16} /><span className="nav-label">{t('设备')}</span>{executing && <span className="activity-device-running" aria-label={t('设备执行中')} />}
    </button>
    {owner && visible && panel?.identity === identity && <ActivityPopover anchor={panel.anchor} title={panel.kind === 'models' ? t('此Node的模型活动') : panel.kind === 'knowledge' ? t('知识活动') : t('文件活动')} close={closePanel}>
      {panel.kind === 'models' && <>
        <p className="activity-description">{t('汇总此Node执行的所有会话，包括收到的委派。')}</p>
        {models && <>
          <div className="activity-totals"><RateValues rates={rates} /></div>
          {!models.limited && models.countsComplete && <Counts counts={models.counts} />}
          <ul className="activity-connections">{models.connections.map(connection => <li key={connection.id}>
            <div><Plug size={14} /><strong title={connection.name}>{connection.name}</strong><small>{connection.providerName}</small></div>
            <div className="activity-connection-rates"><RateValues rates={connection} /></div>{connection.countsComplete && <Counts counts={connection.counts} />}
          </li>)}</ul>
        </>}
        <p className="activity-footnote">{t('输入按近60秒新确认用量统计；输出按近3秒流式增量估算。缺少数据时隐藏对应数值。')}</p>
      </>}
      {panel.kind === 'knowledge' && <><OperationList items={knowledge} dismiss={id => void dismissKnowledge(id)} />{dismissError && <p role="alert" className="activity-failure">{t('提示未清除，请重试。')}</p>}<p className="activity-footnote">{t('显示实际知识操作，不代表设备间完整同步。')}</p></>}
      {panel.kind === 'files' && <OperationList items={fileOperations} dismiss={localActivity.dismiss} />}
    </ActivityPopover>}
  </>;
}
