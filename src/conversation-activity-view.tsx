import { useEffect, useId, useRef, useState, type ReactNode, type Ref, type RefObject } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronRight, CircleAlert, Circle, LoaderCircle, Monitor, ArrowRight, History } from 'lucide-react';
import { t } from '../shared/i18n.ts';
import { taskFileBytesLabel } from '../shared/task-files.ts';
import { prefersReducedMotion } from './motion';
import { ActivityReadingAnchor } from './activity-reading-anchor';
import { advancingTransfers, type ActivityTransfer, type ConversationActivitySummary } from './conversation-activity';
import type { ConversationJourney, JourneyConnection, JourneyStage, JourneyState, JourneyTransferGroup } from './conversation-journey';
import type { TaskFileQuery } from './task-file-state';
import './conversation-activity.css';

type JourneyPhase = 'active' | 'confirming' | 'quiet';
const acknowledgementMs = 650;
const confirmationMs = 650;
const foldingMs = 200;
type NodeName = (id: string | null) => string;

function stateLabel(state: JourneyState) {
  return { active: t('执行中'), waiting: t('等待'), complete: t('已完成'), failed: t('执行失败'), unknown: t('状态待更新'), stopped: t('已停止') }[state];
}

function useConnectionPulses(journey: ConversationJourney, transfers: readonly ActivityTransfer[], live: boolean) {
  const previous = useRef<{ key: string; ready: boolean; transfers: readonly ActivityTransfer[] } | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [pulses, setPulses] = useState<Record<string, number>>({});
  const latest = useRef({ journey, transfers, live }); latest.current = { journey, transfers, live };
  const motionKey = JSON.stringify([journey.key, journey.fresh, live, journey.historical,
    journey.connections.map(edge => [edge.key, edge.state, edge.fresh]), transfers.map(file => [file.key, file.bytes, file.state, file.fresh])]);
  useEffect(() => {
    const { journey: value, transfers: next, live: currentLive } = latest.current;
    const ready = currentLive && !value.historical && !document.hidden && !prefersReducedMotion();
    const prior = previous.current;
    previous.current = { key: value.key, transfers: next, ready };
    const active = new Set(ready ? value.connections.filter(edge => edge.fresh && edge.counts.active > 0).map(edge => edge.key) : []);
    for (const [key, timer] of timers.current) if (!active.has(key)) {
      clearTimeout(timer); timers.current.delete(key);
      setPulses(before => { const after = { ...before }; delete after[key]; return after; });
    }
    if (!ready || prior?.key !== value.key || !prior.ready) return;
    const moved = new Set(advancingTransfers(prior.transfers, next).map(file => file.key));
    for (const edge of value.connections) {
      if (!active.has(edge.key) || timers.current.has(edge.key) || !edge.transferKeys.some(key => moved.has(key))) continue;
      // One short acknowledgement per direction; another peer's bytes never animate this edge.
      setPulses(before => ({ ...before, [edge.key]: Date.now() }));
      timers.current.set(edge.key, setTimeout(() => {
        timers.current.delete(edge.key);
        setPulses(before => { const after = { ...before }; delete after[edge.key]; return after; });
      }, acknowledgementMs));
    }
  }, [motionKey]);
  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const stop = () => {
      if (!document.hidden && !reducedMotion.matches) return;
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear(); previous.current = null; setPulses({});
    };
    document.addEventListener('visibilitychange', stop);
    reducedMotion.addEventListener('change', stop);
    return () => {
      document.removeEventListener('visibilitychange', stop);
      reducedMotion.removeEventListener('change', stop);
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    };
  }, []);
  return pulses;
}

function useCompletionAppearance(journey: ConversationJourney, summary: ConversationActivitySummary, live: boolean,
  expanded: boolean, processID: string, container: RefObject<HTMLElement | null>) {
  const complete = summary.tone === 'settled' && journey.canSettle;
  const quietRecord = journey.historical || !live;
  const observedActive = journey.stages.some(stage => !stage.historical && stage.kind === 'execution' && stage.state === 'active')
    || journey.groups.some(group => group.fresh && group.counts.active > 0);
  // A completed record may briefly wait for its file snapshot. Loading is not a new run.
  const initialPhase: JourneyPhase = quietRecord || journey.canSettle ? 'quiet' : 'active';
  const [appearance, setAppearance] = useState<{ key: string; phase: JourneyPhase; folding: boolean; archivedNow: boolean }>(() => ({
    key: journey.key, phase: initialPhase, folding: false, archivedNow: false,
  }));
  const previous = useRef({ key: journey.key, expanded });
  const observed = useRef({ key: journey.key, active: false });
  const confirmation = useRef<number | null>(null);
  const collapseFocus = useRef<Element | null>(null);
  useEffect(() => {
    const ready = live && journey.fresh && !journey.historical && !document.hidden;
    const prior = previous.current;
    previous.current = { key: journey.key, expanded };
    if (observed.current.key !== journey.key || !ready) observed.current = { key: journey.key, active: false };
    if (ready && observedActive) observed.current.active = true;
    if (prior.key !== journey.key) collapseFocus.current = null;
    if (prior.expanded && !expanded && container.current?.contains(document.activeElement)) collapseFocus.current = document.activeElement;
    let hold: ReturnType<typeof setTimeout> | undefined, fold: ReturnType<typeof setTimeout> | undefined;
    const show = (phase: JourneyPhase, folding = false, archivedNow = false) => setAppearance(before =>
      before.key === journey.key && before.phase === phase && before.folding === folding && before.archivedNow === archivedNow
        ? before : { key: journey.key, phase, folding, archivedNow });
    if (quietRecord) { confirmation.current = null; show('quiet'); return; }
    if (!complete) { confirmation.current = null; show(observed.current.active ? 'active' : initialPhase); return; }
    if (prior.key !== journey.key || !ready) { confirmation.current = null; show('quiet'); return; }
    if (observed.current.active && confirmation.current === null) {
      observed.current.active = false;
      confirmation.current = Date.now();
    }
    if (confirmation.current === null) { show('quiet'); return; }
    show('confirming');
    const protectedReading = () => {
      const root = container.current, detail = document.getElementById(processID);
      const selection = window.getSelection();
      const scope = root?.closest('.conversation-body') || root;
      return expanded || document.activeElement !== collapseFocus.current && !!root?.contains(document.activeElement) || !!detail?.contains(document.activeElement)
        || !!selection?.rangeCount && !selection.isCollapsed && !!scope?.contains(selection.getRangeAt(0).commonAncestorContainer);
    };
    const compress = () => {
      if (confirmation.current === null || document.hidden) { confirmation.current = null; show('quiet'); return; }
      if (protectedReading()) { if (fold) clearTimeout(fold); fold = undefined; show('confirming'); return; }
      const remaining = confirmationMs - (Date.now() - confirmation.current!);
      if (remaining > 0) { if (hold) clearTimeout(hold); hold = setTimeout(compress, remaining); return; }
      if (prefersReducedMotion()) { confirmation.current = null; show('quiet'); return; }
      if (fold) return;
      show('confirming', true);
      fold = setTimeout(() => {
        fold = undefined;
        if (confirmation.current === null || document.hidden) { confirmation.current = null; show('quiet'); return; }
        if (protectedReading()) { show('confirming'); return; }
        confirmation.current = null; show('quiet', false, true);
      }, foldingMs);
    };
    const changed = (event: Event) => {
      if (event.type === 'focusout' && event.target === collapseFocus.current) collapseFocus.current = null;
      if (confirmation.current !== null) compress();
    };
    compress();
    document.addEventListener('selectionchange', changed);
    document.addEventListener('focusin', changed);
    document.addEventListener('focusout', changed);
    document.addEventListener('visibilitychange', changed);
    return () => {
      if (hold) clearTimeout(hold); if (fold) clearTimeout(fold);
      document.removeEventListener('selectionchange', changed); document.removeEventListener('focusin', changed);
      document.removeEventListener('focusout', changed); document.removeEventListener('visibilitychange', changed);
    };
  }, [journey.key, complete, quietRecord, initialPhase, observedActive, journey.fresh, journey.historical, live, expanded, processID, container]);
  useEffect(() => {
    const suspend = () => {
      if (!document.hidden) return;
      observed.current.active = false; confirmation.current = null;
      setAppearance(before => before.phase === 'confirming' || before.archivedNow
        ? { ...before, phase: 'quiet', folding: false, archivedNow: false } : before);
    };
    document.addEventListener('visibilitychange', suspend);
    return () => document.removeEventListener('visibilitychange', suspend);
  }, []);
  const shown = appearance.key === journey.key ? appearance : { key: journey.key, phase: initialPhase, folding: false, archivedNow: false };
  const ready = live && journey.fresh && !journey.historical && (typeof document === 'undefined' || !document.hidden);
  const sawActive = ready && observed.current.key === journey.key && observed.current.active;
  // Decide prop-driven transitions in the parent commit. The effect owns the
  // confirmation timer, but must not resize a sibling's reading area afterward.
  if (quietRecord || complete && (!ready || observed.current.key !== journey.key || !sawActive && confirmation.current === null))
    return { key: journey.key, phase: 'quiet' as const, folding: false, archivedNow: ready && !quietRecord && shown.archivedNow };
  if (!complete) return { key: journey.key, phase: sawActive || ready && observedActive ? 'active' as const : initialPhase, folding: false, archivedNow: false };
  return { ...shown, phase: 'confirming' as const, folding: shown.phase === 'confirming' && shown.folding };
}

function DeviceChip({ id, nodeName, executing = false }: { id: string | null; nodeName: NodeName; executing?: boolean }) {
  return <span className="journey-device" data-node-id={id || undefined} data-execution-node={executing ? id || undefined : undefined}
    data-executing={executing} title={nodeName(id)}><span className="journey-device-icon"><Monitor size={14} strokeWidth={1.6} aria-hidden="true" /></span><span>{nodeName(id)}</span></span>;
}

function JourneyWire({ pulse }: { pulse?: number }) {
  const route = 'M2 11H54';
  return <span className="journey-wire" aria-hidden="true">
    <svg viewBox="0 0 56 22" preserveAspectRatio="none"><path className="journey-wire-base" d={route} /><path className="journey-wire-tip" d="m50 7.5 4 3.5-4 3.5" /></svg>
    {pulse && <span className="activity-transfer-motion" data-pulse={pulse} key={pulse}>
      <svg viewBox="0 0 56 22" preserveAspectRatio="none">
        <path className="journey-wire-trail" d={route} />
        <path className="journey-wire-packet" pathLength="100" d={route} />
      </svg>
    </span>}
  </span>;
}

function Connection({ edge, journey, nodeName, pulse }: { edge: JourneyConnection; journey: ConversationJourney; nodeName: NodeName; pulse?: number }) {
  return <span className="journey-connection" data-connection-key={edge.key} data-from={edge.fromNodeID || undefined}
    data-to={edge.toNodeID || undefined} data-direction={edge.direction} data-state={edge.state}
    data-file-count={edge.fileCount} data-group-count={edge.groupKeys.length}>
    <DeviceChip id={edge.fromNodeID} nodeName={nodeName} executing={journey.devices.some(device => device.id === edge.fromNodeID && device.executing)} />
    <JourneyWire pulse={pulse} />
    <DeviceChip id={edge.toNodeID} nodeName={nodeName} executing={journey.devices.some(device => device.id === edge.toNodeID && device.executing)} />
    {edge.fileCount > 1 && <small className="journey-file-count" title={t('{{count}} 个文件', { count: edge.fileCount })}>×{edge.fileCount}</small>}
  </span>;
}

/** One stable disclosure; incoming updates never open it or steal keyboard focus. */
export function ConversationActivity({ summary: inputSummary, journey, nodeName, identityKey, expanded, toggle, processID, triggerRef, live = true, actions }: {
  summary: ConversationActivitySummary; journey: ConversationJourney; nodeName: NodeName; identityKey: string;
  expanded: boolean; toggle: () => void; processID: string; triggerRef?: Ref<HTMLButtonElement>; live?: boolean; actions?: ReactNode;
}) {
  const root = useRef<HTMLElement>(null);
  const blocking = journey.stages.filter(stage => !stage.historical && stage.state !== 'complete');
  const failed = blocking.some(stage => stage.state === 'failed'), unknown = blocking.some(stage => stage.state === 'unknown');
  const active = blocking.some(stage => stage.state === 'active');
  const summary: ConversationActivitySummary = live && !journey.historical && journey.completed && !journey.canSettle
    && inputSummary.tone === 'settled' && blocking.length ? { ...inputSummary,
      tone: failed ? 'attention' : unknown ? 'unavailable' : active ? 'active' : 'waiting',
      label: failed ? t('需要检查执行结果') : unknown ? t('状态待确认') : active ? t('执行中') : t('等待处理'),
    } : inputSummary;
  const pulses = useConnectionPulses(journey, summary.transfers, live);
  const appearance = useCompletionAppearance(journey, summary, live, expanded, processID, root);
  const settled = summary.tone === 'settled';
  const priorDetail = useRef({ key: journey.key, text: summary.detail });
  if (priorDetail.current.key !== journey.key || !settled) priorDetail.current = { key: journey.key, text: settled ? '' : summary.detail };
  const completedStages = journey.stages.filter(stage => stage.kind === 'execution' && !stage.historical && stage.state === 'complete').length;
  const confirmationDetail = appearance.phase === 'confirming' && priorDetail.current.text
    ? summary.transfers.length ? t('{{count}} 项传输', { count: summary.transfers.length })
      : completedStages ? t('已完成 {{count}} 个阶段', { count: completedStages }) : '' : '';
  const detail = settled ? confirmationDetail : live ? summary.detail : summary.tone === 'attention' ? summary.label : '';
  // Receipts arrive per route. Keep confirmed paths in place, dimmed, until the
  // activity closes; removing them one by one can briefly shrink a wrapped row.
  const connections = journey.connections;
  const executing = journey.devices.filter(device => device.executing);
  const execution = journey.stages.find(stage => stage.kind === 'execution' && stage.state === 'active' && stage.nodeID);
  return <section ref={root} className="conversation-activity" data-tone={summary.tone} data-live={live && !settled}
    data-activity-identity={journey.identityIndex} data-identity-key={identityKey} data-phase={appearance.phase} data-expanded={expanded}
    data-folding={appearance.folding} data-archived-now={appearance.archivedNow} aria-label={t('任务进展')}>
    <div className="conversation-activity-row">
    <button type="button" className="conversation-activity-toggle" ref={triggerRef} aria-expanded={expanded}
      aria-controls={processID} onClick={toggle}>
      {appearance.phase !== 'quiet' ? <>
      <span className="conversation-activity-icon" aria-hidden="true">
        {summary.tone === 'attention' || summary.tone === 'unavailable' ? <CircleAlert size={17} strokeWidth={1.7} /> : journey.canSettle ? <Check size={16} strokeWidth={1.8} /> :
          summary.tone === 'active' ? <LoaderCircle size={17} strokeWidth={1.7} /> : <Circle size={15} strokeWidth={1.6} />}
      </span>
      <span className="conversation-activity-content">
      <span className="conversation-activity-heading">
        <span className="conversation-activity-label" title={summary.label}>{appearance.phase === 'confirming' ? t('已完成') : !live ? t('执行过程') : summary.label}</span>
        {detail && <span className="conversation-activity-meta">{detail}</span>}
      </span>
      <span className="journey-live-paths">
        {connections.slice(0, 3).map(edge => <Connection key={edge.key} edge={edge} journey={journey} nodeName={nodeName} pulse={pulses[edge.key]} />)}
        {!connections.length && execution?.fromNodeID && execution.nodeID !== execution.fromNodeID ?
          <span className="journey-execution-route"><DeviceChip id={execution.fromNodeID} nodeName={nodeName} /><JourneyWire />
            <DeviceChip id={execution.nodeID} nodeName={nodeName} executing /></span> : !connections.length &&
          executing.slice(0, 3).map(device => <DeviceChip key={device.id} id={device.id} nodeName={nodeName} executing />)}
        {connections.length > 3 && <small className="journey-overflow">{t('另有 {{count}} 条路径', { count: connections.length - 3 })}</small>}
      </span>
      </span>
      </> : <span className="journey-archive"><History size={13} aria-hidden="true" /><span className="conversation-activity-label">{t('过程记录')}</span>
        {(summary.tone === 'attention' || summary.tone === 'unavailable') && <small>{summary.label}</small>}
        {journey.handoffCount !== undefined && journey.handoffCount > 0 && <small>· {t('{{count}} 次交接', { count: journey.handoffCount })}</small>}</span>}
      <ChevronRight className="conversation-activity-chevron" size={13} aria-hidden="true" />
    </button>
    {actions}
    </div>
    <span className="activity-announcement" aria-live="polite" aria-atomic="true">{live && (summary.tone === 'attention' || summary.tone === 'unavailable') ? [summary.label, summary.detail].filter(Boolean).join(' · ') : ''}</span>
  </section>;
}

/** Compact independent events. Array order never draws a dependency or a relay. */
export function ConversationJourneyTrail({ journey, nodeName, selected, onSelectStage, identityKey, files, routeName }: {
  journey: ConversationJourney; nodeName: NodeName; identityKey?: string;
  files: readonly ActivityTransfer[]; routeName?: (route: TaskFileQuery) => string | undefined;
  selected?: { stepID: string; attempt: number } | null; onSelectStage?: (stage: JourneyStage) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [showCompleted, setShowCompleted] = useState(false), [limit, setLimit] = useState(12);
  const [protectedKeys, setProtectedKeys] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const protect = () => {
      const element = root.current;
      if (!element) return;
      const focused = document.activeElement?.closest<HTMLElement>('[data-journey-stage]');
      const selection = window.getSelection();
      const source = selection?.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0).commonAncestorContainer : null;
      const range = source && element.contains(source) ? selection!.getRangeAt(0) : null;
      const keys = new Set<string>();
      if (focused && element.contains(focused)) keys.add(focused.dataset.journeyStage!);
      if (range) for (const stage of element.querySelectorAll<HTMLElement>('[data-journey-stage]')) {
        if (range.intersectsNode(stage)) keys.add(stage.dataset.journeyStage!);
      }
      setProtectedKeys(before => before.size === keys.size && [...keys].every(key => before.has(key)) ? before : keys);
    };
    document.addEventListener('selectionchange', protect); document.addEventListener('focusin', protect); document.addEventListener('focusout', protect);
    return () => { document.removeEventListener('selectionchange', protect); document.removeEventListener('focusin', protect); document.removeEventListener('focusout', protect); };
  }, []);
  // Transfers own their file disclosure below; do not repeat them as generic stage rows.
  const stages = journey.stages.filter(stage => stage.kind !== 'transfer');
  const completed = stages.filter(stage => stage.state === 'complete' || stage.historical);
  const outstanding = stages.filter(stage => stage.state !== 'complete' && !stage.historical);
  const visibleOutstanding = new Set(outstanding.filter(stage => ['failed', 'unknown'].includes(stage.state)).map(stage => stage.key));
  outstanding.slice(0, limit).forEach(stage => visibleOutstanding.add(stage.key));
  const retainedStages = useRef(new Set<string>());
  visibleOutstanding.forEach(key => retainedStages.current.add(key));
  const isStageSelected = (stage: JourneyStage) => !!selected && selected.stepID === stage.stepID && selected.attempt === (stage.attempt || 0);
  // This trail exists only while its owner is explicitly expanded. Preserve
  // already displayed rows until it closes, so finishing cannot lift files at scrollTop=0.
  const archived = completed.filter(stage => !retainedStages.current.has(stage.key) && !isStageSelected(stage) && !protectedKeys.has(stage.key));
  const title = (stage: JourneyStage) => stage.title || (stage.kind === 'handoff' ? t('执行转交') : t('文件传输'));
  const status = (stage: JourneyStage) => stage.kind === 'transfer' && stage.state === 'active' ? t('传输中') : stateLabel(stage.state);
  return <div ref={root} className="conversation-journey-trail" data-activity-identity={journey.identityIndex} data-identity-key={identityKey}>
    <div className="journey-trail-heading"><span>{t('协作轨迹')}</span></div>
    {archived.length > 0 && <button type="button" className="journey-past-toggle" aria-expanded={showCompleted}
      onClick={() => setShowCompleted(value => !value)}><ChevronRight size={12} aria-hidden="true" />{t('历史阶段（{{count}}）', { count: archived.length })}</button>}
    <ul className="journey-stage-list activity-step-list">
      {stages.map(stage => {
        const isSelected = isStageSelected(stage);
        const past = stage.state === 'complete' || stage.historical;
        const visible = isSelected || protectedKeys.has(stage.key) || retainedStages.current.has(stage.key) || (past ? showCompleted : visibleOutstanding.has(stage.key));
        const content = <><span className="journey-stage-marker" aria-hidden="true">{stage.state === 'failed' ? <CircleAlert size={12} /> : stage.state === 'complete' ? <Check size={11} /> : <i />}</span>
          <span className="journey-stage-copy"><span className="journey-stage-title">{title(stage)}</span><small>
            {stage.fromNodeID && stage.toNodeID && stage.fromNodeID !== stage.toNodeID ? <>{nodeName(stage.fromNodeID)} <ArrowRight size={11} aria-hidden="true" /> {nodeName(stage.toNodeID)} · </> : stage.nodeID ? `${nodeName(stage.nodeID)} · ` : ''}
            {status(stage)}
          </small>{stage.dependsOn.length > 0 && <small className="journey-dependencies">{t('阶段依赖')}：{stage.dependsOn.map(key => journey.stages.find(item => item.key === key)?.title).filter(Boolean).join('、')}</small>}</span></>;
        return <li key={stage.key} data-journey-stage={stage.key} data-state={stage.state} data-past={past} data-retained={retainedStages.current.has(stage.key)} hidden={!visible}>
          {onSelectStage && stage.stepID && (stage.kind === 'execution' || stage.kind === 'handoff' && stage.fromNodeID && stage.toNodeID && stage.attempt !== null) ?
            <button type="button" aria-label={title(stage)} aria-pressed={isSelected} onClick={() => onSelectStage(stage)}>{content}</button> : <div className="journey-stage-record">{content}</div>}
        </li>;
      })}
    </ul>
    {outstanding.length > limit && <button type="button" className="activity-show-more" onClick={() => setLimit(value => value + 12)}>{t('显示更多阶段')}</button>}
    <ActivityTransferList files={files} journey={journey} nodeName={nodeName} routeName={routeName} />
  </div>;
}

function TransferGroup({ group, files, nodeName, owner }: {
  group: JourneyTransferGroup; files: readonly ActivityTransfer[]; nodeName: NodeName; owner?: string;
}) {
  const [limit, setLimit] = useState(8);
  const [revealFiles, setRevealFiles] = useState(false);
  const needsAttention = group.state === 'unknown' || group.state === 'failed' || files.some(file => !file.fresh || file.state === 'failed');
  const [disclosure, setDisclosure] = useState({ attention: needsAttention, expanded: files.length === 1 || needsAttention });
  // Apply new attention during this render so the parent's reading snapshot sees
  // the expansion in the same commit, not in a later child-only effect.
  if (disclosure.attention !== needsAttention) setDisclosure({ attention: needsAttention, expanded: needsAttention || disclosure.expanded });
  const expanded = needsAttention !== disclosure.attention ? needsAttention || disclosure.expanded : disclosure.expanded;
  const revealedFiles = useRef(new Set<string>());
  const shownStatus = useRef(new Set<string>());
  files.slice(0, limit).forEach(file => revealedFiles.current.add(file.key));
  files.filter(file => !file.fresh || file.state === 'failed').slice(0, limit).forEach(file => revealedFiles.current.add(file.key));
  files.forEach(file => { if (!file.fresh || group.state === 'unknown' || file.state === 'failed' || file.state === 'waiting') shownStatus.current.add(file.key); });
  const peer = group.peerNodeID ? nodeName(group.peerNodeID) : group.direction === 'send' ? t('目标待确认') : t('来源待确认');
  const state = group.state === 'unknown' ? t('状态待更新') : group.state === 'failed' ? t('传输失败') : group.state === 'active'
    ? group.direction === 'send' ? t('发送中') : t('接收中') : group.state === 'waiting' ? t('等待传输') : stateLabel(group.state);
  return <details className="journey-transfer-group" data-transfer-group={group.key} data-state={group.state}
    open={expanded} onToggle={event => { const open = event.currentTarget.open;
      setDisclosure(before => before.expanded === open && before.attention === needsAttention ? before : { attention: needsAttention, expanded: open }); }}>
    <summary onClick={() => setRevealFiles(!expanded)}>
      <span className="journey-transfer-icon" aria-hidden="true">{group.direction === 'send' ? <ArrowUp size={14} strokeWidth={1.6} /> : <ArrowDown size={14} strokeWidth={1.6} />}</span>
      <span className="journey-transfer-copy"><span className="journey-transfer-title">{group.direction === 'send' ? t('向 {{node}} 发送', { node: peer }) : t('从 {{node}} 接收', { node: peer })}
        <span className="journey-transfer-count">{t('{{count}} 个文件', { count: files.length })}</span></span>
        {owner && <small>{owner}</small>}</span>
      <span className="journey-transfer-state">{state}</span><ChevronRight className="journey-transfer-chevron" size={13} aria-hidden="true" />
    </summary>
    <div className="journey-transfer-files" data-reveal={revealFiles} hidden={!expanded}>
    <ul className="activity-transfer-list" aria-label={t('文件传输')}>
      {files.filter(file => revealedFiles.current.has(file.key)).map(file => {
        const fresh = file.fresh && group.state !== 'unknown';
        const showProgress = fresh && file.total > 0 && (file.state === 'sending' || file.state === 'receiving');
        return <li key={file.key} data-state={fresh ? file.state : 'unavailable'} data-transfer-key={file.key}>
        <span className="activity-file-state" aria-hidden="true">{fresh && file.state === 'complete' ? <Check size={12} /> : !fresh || file.state === 'failed' ? <CircleAlert size={12} /> : <i />}</span>
        <div><span className="activity-file-name">{file.name}</span>{shownStatus.current.has(file.key) &&
          <small>{!fresh ? t('状态待更新') : file.state === 'failed' ? t('传输失败') : file.state === 'waiting' ? t('等待传输')
            : file.state === 'complete' ? t('已完成') : file.direction === 'send' ? t('发送中') : t('接收中')}</small>}</div>
        <span className="activity-file-bytes">{taskFileBytesLabel(file.bytes)} / {taskFileBytesLabel(file.total)}
          {showProgress && <span className="activity-file-meter" aria-hidden="true"><i style={{ transform: `scaleX(${file.bytes / file.total})` }} /></span>}
        </span>
      </li>; })}
    </ul>
    {files.some(file => !revealedFiles.current.has(file.key)) && <button type="button" className="activity-show-more" onClick={() => setLimit(value => value + 12)}>{t('显示更多传输')}</button>}
    </div>
  </details>;
}

export function ActivityTransferList({ files, journey, nodeName, routeName }: {
  files: readonly ActivityTransfer[]; journey: ConversationJourney; nodeName: NodeName; routeName?: (route: TaskFileQuery) => string | undefined;
}) {
  const [limit, setLimit] = useState(8);
  const byKey = new Map(files.map(file => [file.key, file]));
  const groups = journey.groups.filter(group => group.transferKeys.some(key => byKey.has(key)));
  // Once displayed, a group stays mounted and visible even if snapshots reorder it.
  const revealed = useRef(new Set<string>());
  groups.forEach((group, index) => { if (index < limit || group.state === 'failed' || group.state === 'unknown') revealed.current.add(group.key); });
  if (!groups.length) return null;
  return <div className="activity-transfers">
    {groups.map(group => <div key={group.key} hidden={!revealed.current.has(group.key)}>
      <TransferGroup group={group} files={group.transferKeys.flatMap(key => byKey.has(key) ? [byKey.get(key)!] : [])}
        nodeName={nodeName} owner={routeName?.(group.route)} />
    </div>)}
    {groups.some(group => !revealed.current.has(group.key)) &&
      <button type="button" className="activity-show-more" onClick={() => setLimit(value => value + 8)}>{t('显示更多路径')}</button>}
  </div>;
}

/** Reusable plain disclosure for a complete conversation's process, not each tool call. */
export function ActivityDisclosure({ summary, journey, identityKey, children, nodeName, actions }: {
  summary: ConversationActivitySummary; journey: ConversationJourney; identityKey: string; children: ReactNode; nodeName: NodeName; actions?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const id = useId(), trigger = useRef<HTMLButtonElement>(null);
  return <>
    <ConversationActivity summary={summary} journey={journey} identityKey={identityKey} nodeName={nodeName} expanded={expanded} processID={id} triggerRef={trigger} actions={actions}
      toggle={() => setExpanded(value => !value)} />
    <ActivityReadingAnchor navigationKey={String(expanded)}><div className="conversation-activity-detail" id={id}
      data-activity-identity={journey.identityIndex} hidden={!expanded}>
      {expanded && <><ConversationJourneyTrail journey={journey} identityKey={identityKey} nodeName={nodeName} files={summary.transfers} />{children}</>}
    </div></ActivityReadingAnchor>
  </>;
}
