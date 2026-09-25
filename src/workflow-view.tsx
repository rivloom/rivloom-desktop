import { reasoningLabel } from './reasoning-picker';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, GitBranch, Pause, Play, ShieldCheck, Square } from 'lucide-react';
import { t } from '../shared/i18n.ts';
import type { Bootstrap, RemoteTaskInvite, Task } from '../shared/types';
import type { Workflow, WorkflowAttempt, WorkflowStep, WorkflowStepPlan, WorkflowMessage } from '../shared/workflows';
import { canRetryWorkflowPlanning, canRetryWorkflowStep, workflowPendingMessages } from '../shared/workflows';
import { api } from './api';
import { workflowError } from '../shared/workflow-errors.ts';
import { Button, Field, Modal } from './ui';
import { CopyButton } from './copy-button';
import { MessageReuseActions, type MessageReuseActionsProps } from './message-reuse-view';
import { UserMessageText } from './message-quote-view';
import { TaskTelemetryView } from './task-telemetry-view';
import { MessageTrace, TaskTrace } from './message-trace';
import { PendingMessageEditor } from './pending-message-editor';
import { MessageMarkdown } from './message-markdown';
import { FilePreviewButton } from './file-preview';
import { TaskFilesPanel } from './task-files';
import { WorkflowGraph, workflowStepLabel, type WorkflowGraphNode } from './workflow-graph';
import { workflowResults } from './workflow-results';
import { WorkflowActivity } from './workflow-activity-view';
import { recentWorkflowExecutions, workflowAttentionExecutions, workflowLatestExecutions } from './workflow-recent';
import { WorkflowRecentOutput } from './workflow-recent-view';
import { searchTargetID, workflowAttemptResponse, type SearchMatch } from './conversation-search';
import { SearchText } from './conversation-search-view';
import { WorkflowDiagnostics, type WorkflowDiagnosticNavigation } from './workflow-diagnostics';
import './workflow.css';

function ExecutionActions({ local, remote, data, busy, perform }: {
  local?: Task; remote?: RemoteTaskInvite; data: Bootstrap; busy: boolean; perform: (fn: () => Promise<unknown>) => Promise<boolean>;
}) {
  const approvals = local?.approvals || remote?.remoteApprovals || [];
  const questions = local?.questions || remote?.remoteQuestions || [];
  const canApprove = local ? local.approverID === data.user.id : remote?.direction === 'outgoing' && data.user.owner;
  const canAnswer = local ? [local.creatorID, local.assigneeID].includes(data.user.id) : remote?.direction === 'outgoing' && data.user.owner;
  const control = (action: unknown) => api(`/network/tasks/${remote!.id}/control`, { expectedExecutionSequence: remote!.executionSequence, action, confirmed: true });
  return <>
    {approvals.map((approval) => <section className="chat-approval" key={approval.id}>
      <h3><ShieldCheck size={17} />{t('需要你的批准')}</h3><p>{approval.permission}</p>
      <pre>{String(approval.metadata.command || approval.metadata.diff || approval.patterns.join('\n'))}</pre>
      {canApprove ? <div className="action-group">{(['reject', 'once'] as const).map((reply) => <Button key={reply}
        disabled={busy || remote?.controlPending} variant={reply === 'once' ? 'primary' : ''}
        onClick={() => void perform(() => local ? api(`/tasks/${local.id}/permissions/${approval.id}`, { reply }) : control({ kind: 'permission', requestID: approval.id, reply }))}>
        {reply === 'once' ? t('仅本次允许') : t('拒绝')}</Button>)}</div> : <p className="muted">{t('等待指定审批人处理。')}</p>}
    </section>)}
    {questions.map((question) => <form className="chat-approval" key={question.id} onSubmit={(event) => {
      event.preventDefault(); const form = new FormData(event.currentTarget);
      const answers = question.questions.map((_, i) => [String(form.get(`answer-${i}`))]);
      void perform(() => local ? api(`/tasks/${local.id}/questions/${question.id}`, { answers }) : control({ kind: 'question', requestID: question.id, answers }));
    }}><h3>{t('补充一点信息')}</h3>
      {question.questions.map((q, i) => <Field key={i} label={q.question} hint={q.options.map((o) => `${o.label}：${o.description}`).join('；')}>
        <input name={`answer-${i}`} required maxLength={4000} disabled={!canAnswer || busy} />
      </Field>)}<Button type="submit" variant="primary" disabled={!canAnswer || busy || remote?.controlPending}>{t('回复')}</Button>
    </form>)}
  </>;
}
type WorkflowViewProps = {
  value: Workflow; data: Bootstrap; busy: boolean; perform: (fn: () => Promise<unknown>) => Promise<boolean>; nodeName: (id: string | null) => string;
  searchMatch?: SearchMatch; searchQuery?: string; searchRevision?: number;
  navigateDiagnostics?: WorkflowDiagnosticNavigation;
  reuse?: Pick<MessageReuseActionsProps, 'draft' | 'onApply' | 'disabled'>;
};
export function WorkflowView(props: WorkflowViewProps) {
  const { value, busy, perform } = props;
  const [editingMessage, setEditingMessage] = useState<WorkflowMessage | null>(null);
  const queued = workflowPendingMessages(value);
  const control = (action: 'pause' | 'resume' | 'cancel', requestID?: string) => perform(() => api(`/workflows/${value.id}/messages/control`, { action, requestID }));
  return <>
    {(value.rounds || []).map((round, i) => <section className="workflow-round" key={round.requestID}>
      <small className="workflow-round-divider">{t('第 {{count}} 轮', { count: i + 1 })}</small>
      <WorkflowRoundView {...props} historical value={{ ...value, ...round, rounds: [], roundRequestID: round.requestID }} />
    </section>)}
    {!!value.rounds?.length && <small className="workflow-round-divider">{t('第 {{count}} 轮', { count: value.rounds.length + 1 })}</small>}
    <WorkflowRoundView {...props} key={value.roundRequestID || value.requestID} />
    {!!queued.length && <section className="workflow-message-queue" aria-label={t('待执行消息')}>
      <div className="workflow-queue-heading"><strong>{t('待执行消息')} · {queued.length}</strong>
        <Button disabled={busy} onClick={() => void control(value.queuePaused ? 'resume' : 'pause')}>{value.queuePaused ? t('继续消息队列') : t('暂停消息队列')}</Button></div>
      <p className="muted">{value.queuePaused ? t('消息队列已暂停，继续后会依次执行。') : t('当前轮结束后，按发送顺序继续执行。')}</p>
      {value.queueError && <p className="workflow-error" role="alert">{workflowError(value.queueError)}</p>}
      {queued.map((message, i) => <article className="chat-message user workflow-queue-message" key={message.requestID}
        tabIndex={-1} data-search-target={searchTargetID({ kind: 'queued', messageID: message.requestID })}>
        <UserMessageText text={message.text} searchQuery={props.searchQuery} />
        <small className="workflow-queued-model">{t('本机执行模型：{{model}}', { model: message.model === undefined ? t('沿用前一轮模型') :
          message.model === null ? t('默认模型') : props.data.engine.models.find((item) => item.id === message.model)?.name || message.model })}{message.reasoningEffort !== undefined && <> · {t('思考：{{level}}', { level: reasoningLabel(message.reasoningEffort) })}</>}</small>
        {message.inputFiles.map((file) => <FilePreviewButton key={file.id} file={file} path={`/task-files/uploads/${file.id}`} />)}
        <footer><span>{t('排队第 {{count}} 条', { count: i + 1 })}</span><CopyButton text={message.text} label={t('复制这条消息')} />
          <Button disabled={busy} onClick={() => setEditingMessage(structuredClone(message))}>{t('编辑待执行消息')}</Button>
          <Button disabled={busy} onClick={() => void control('cancel', message.requestID)}>{t('取消排队')}</Button></footer>
      </article>)}
    </section>}
    {editingMessage && <PendingMessageEditor key={editingMessage.requestID} workflowID={value.id} message={editingMessage}
      onSaved={() => { void perform(async () => undefined); }} close={() => setEditingMessage(null)} />}
  </>;
}
function WorkflowRoundView({ value, data, busy, perform, nodeName, navigateDiagnostics, historical = false, searchMatch, searchQuery = '', searchRevision, reuse }: WorkflowViewProps & { historical?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const processID = useId();
  const selectedDetail = useRef<HTMLElement>(null), navigateToDetail = useRef(false);
  const processTrigger = useRef<HTMLButtonElement>(null);
  const [selection, setSelection] = useState<{ stepID: string; attempt: number } | null>(null);
  const [editing, setEditing] = useState<WorkflowStepPlan | null>(null);
  const [editingVersion, setEditingVersion] = useState(0);
  const complex = value.steps.length > 1 || value.handoffs.length > 0;
  useLayoutEffect(() => { setExpanded(false); setSelection(null); }, [value.id]);
  const roundID = value.roundRequestID || value.requestID;
  useLayoutEffect(() => {
    const target = searchMatch?.target;
    if (target?.roundID !== roundID) return;
    if (target.kind === 'plan') setExpanded(true);
    if (target.kind === 'step') { setExpanded(true); setSelection({ stepID: target.stepID!, attempt: target.attempt! }); }
  }, [roundID, searchMatch?.id, searchRevision]);
  const steps = value.planVersion ? value.steps : [value.planner];
  const selectedStep = steps.find((s) => s.id === selection?.stepID) || steps.find((s) => s.state === 'running' || s.state === 'failed' || s.state === 'blocked') || steps.at(-1);
  const selectedAttempt = selectedStep?.attempts.find((a) => a.number === selection?.attempt) || selectedStep?.attempts.at(-1);
  const complete = value.state === 'completed'; const terminal = ['completed', 'failed', 'stopped'].includes(value.state);
  const results = workflowResults(value);
  const deliveries = steps.flatMap((step) => {
    const attempt = step.attempts.at(-1);
    return attempt?.outputFiles.length ? [{ step, attempt }] : [];
  });
  const retry = (step: WorkflowStep) => perform(() => api(`/workflows/${value.id}/steps/retry`, {
    version: value.version, roundRequestID: value.roundRequestID || value.requestID, stepID: step.id,
    attempt: step.attempts.length, requestID: crypto.randomUUID(),
  }));
  const records = (attempt?: WorkflowAttempt) => ({
    local: attempt ? data.tasks.find((task) => task.id === attempt.executionID) : undefined,
    remote: attempt ? data.network.remoteTasks.find((remote) => remote.id === attempt.executionID) : undefined,
  });
  const current = records(selectedAttempt);
  const latestExecutions = workflowLatestExecutions(value, data, historical);
  const recentExecutions = recentWorkflowExecutions(latestExecutions, value.state);
  const attentionExecutions = workflowAttentionExecutions(latestExecutions, value.state);
  const compactDiagnostics = !attentionExecutions.length && !value.error && !value.pendingConfirmation &&
    recentExecutions.length > 0 && latestExecutions.every(entry => !entry.attempt.error && !entry.local?.error && !entry.remote?.deliveryError);
  useLayoutEffect(() => {
    if (!expanded || !navigateToDetail.current) return;
    navigateToDetail.current = false;
    selectedDetail.current?.scrollIntoView({ block: 'start' });
    selectedDetail.current?.focus({ preventScroll: true });
  }, [expanded, selection]);
  const checkpoint = selectedAttempt && selectedStep ? workflowAttemptResponse(selectedStep, selectedAttempt) : selectedStep?.checkpoint;
  const status = { planning: t('正在分析与规划'), running: t('任务进行中'), paused: t('已暂停派发'), stopping: t('正在确认停止'),
    stopped: t('已停止'), completed: t('已完成'), failed: t('需要检查执行结果') }[value.state];
  const choose = (node: WorkflowGraphNode) => setSelection({ stepID: node.step.id, attempt: node.attempt?.number || 0 });
  const showStep = (step: WorkflowStep) => { navigateToDetail.current = true; setSelection({ stepID: step.id, attempt: step.attempts.at(-1)?.number || 0 }); setExpanded(true); };
  const closeProcess = () => { navigateToDetail.current = false; setExpanded(false); processTrigger.current?.focus({ preventScroll: true }); };
  const edit = (step: WorkflowStep) => { setEditingVersion(value.version); setEditing({ id: step.id, title: step.title, instructions: step.instructions, dependsOn: [...step.dependsOn],
    nodeID: step.nodeID, resources: step.resources, software: step.software, requirements: step.requirements }); };
  return <div className="workflow-conversation">
    <article className="chat-message user" aria-label={t('你')} tabIndex={-1} data-search-target={searchTargetID({ kind: 'requirement', roundID })}>
      <UserMessageText text={value.description} searchQuery={searchQuery} />
      {(value.messages?.find((m) => m.requestID === value.roundRequestID)?.inputFiles || (!value.roundRequestID || value.roundRequestID === value.requestID ? value.inputFiles : [])).map((file) =>
        <FilePreviewButton key={file.id} file={file} path={`/task-files/uploads/${file.id}`} />)}
      <div className="message-actions-row">{reuse ? <MessageReuseActions {...reuse} text={value.description} existingConversation /> : <CopyButton text={value.description} label={t('复制这条消息')} />}</div>
    </article>
    <WorkflowActivity value={value} nodeName={nodeName} showStep={showStep} expanded={expanded} processID={processID} processTrigger={processTrigger} closeProcess={closeProcess} />
    {attentionExecutions.map(entry => <section className="workflow-step-attention" key={entry.attempt.executionID}>
      <p>{entry.step.title} · {nodeName(entry.attempt.nodeID)}</p><ExecutionActions local={entry.local} remote={entry.remote} data={data} busy={busy} perform={perform} />
    </section>)}
    {[value.planner, ...value.steps].flatMap(step => step.attempts.map(attempt => ({ step, attempt, local: records(attempt).local })))
      .filter(entry => entry.local).map(({ step, attempt, local }) => <TaskTrace key={attempt.executionID} task={local!}
        label={`${step.title} · ${nodeName(attempt.nodeID)}${step.attempts.length > 1 ? ` #${attempt.number}` : ''}`} />)}
    {recentExecutions.filter(entry => !entry.local).map(entry => <WorkflowRecentOutput key={entry.attempt.executionID} entry={entry} nodeName={nodeName} showStep={showStep} />)}
    <section className={`workflow-overview ${value.state}`} aria-label={complete ? t('最终结果') : t('任务进展')}>
      {(complete || results.length > 0) && <div className="workflow-results">
        <div className="chat-message-byline workflow-answer-byline"><strong>Rivloom</strong></div>
        {!complete && <p className="workflow-partial-label">{t('已完成的部分')}</p>}
        {results.map(({ step, attempt, summary }) => <article className="workflow-result" key={step.id} tabIndex={-1}
          data-search-target={searchTargetID({ kind: 'response', roundID, stepID: step.id, attempt: attempt.number })}>
          {results.length > 1 && <h3>{step.title}</h3>}
          {summary && <div className="workflow-result-response"><MessageMarkdown text={summary} searchQuery={searchQuery} /></div>}
          {summary && <div className="message-actions-row">{reuse ? <MessageReuseActions {...reuse} text={summary} existingConversation allowReuse={false} /> : <CopyButton text={summary} label={t('复制执行结果')} />}</div>}
        </article>)}
        {!results.length && <p className="muted">{t('步骤已完成，可打开执行详情查看记录。')}</p>}
      </div>}
      {!!deliveries.length && <div className="workflow-deliveries" aria-label={t('交付成果')}>
        {deliveries.map(({ step, attempt }) => <div key={attempt.executionID}>
          {deliveries.length > 1 && <h3>{step.title}</h3>}
          <TaskFilesPanel scope={attempt.kind} taskID={attempt.executionID} resultsOnly nodeName={nodeName} />
        </div>)}
      </div>}
      {!complete && !historical && <WorkflowDiagnostics value={value} data={data} busy={busy} nodeName={nodeName} compact={compactDiagnostics}
        showStep={showStep} editStep={edit} retry={(step) => void retry(step)} navigate={navigateDiagnostics} />}
      {!complete && historical && <>
        <div className="workflow-current-work">{steps.filter((step) => terminal ? step.state === 'failed' || step.state === 'blocked' : step.state === 'running').map((step) =>
          <div className="workflow-work-row" key={step.id}>
            <button type="button" onClick={() => showStep(step)}><small>{workflowStepLabel(step, step.attempts.at(-1))}</small><span>{step.title}</span><ChevronRight size={14} /></button>
            {!historical && canRetryWorkflowStep(value, step) && <Button disabled={busy} onClick={() => void retry(step)}><Play size={12} />{t('重试此步骤')}</Button>}
          </div>)}</div>
      </>}
      {!terminal && <div className="workflow-controls">
        <Button disabled={busy || value.state === 'stopping'} onClick={() => void perform(() => api(`/workflows/${value.id}/control`, { action: value.state === 'paused' ? 'resume' : 'pause' }))}>
          {value.state === 'paused' ? <Play size={13} /> : <Pause size={13} />}{value.state === 'paused' ? t('继续派发') : t('暂停派发')}</Button>
        <Button disabled={busy || value.state === 'stopping'} onClick={() => void perform(() => api(`/workflows/${value.id}/control`, { action: 'stop' }))}><Square size={12} />{t('停止整个任务')}</Button>
        <small>{t('已进入 Node 队列的执行会继续；暂停后不再派发新步骤。')}</small>
      </div>}
      {value.error && <p className="workflow-error" role="alert">{workflowError(value.error)}</p>}
      {!historical && canRetryWorkflowPlanning(value) && <div className="workflow-controls"><Button disabled={busy}
        onClick={() => void perform(() => api(`/workflows/${value.id}/control`, { action: 'retry_planning' }))}><Play size={13} />{t('重新规划')}</Button>
        <small>{t('保留原规划记录，重新分析这条需求。')}</small></div>}
    </section>
    {value.pendingConfirmation && <section className="chat-approval workflow-confirmation" role="status">
      <h3>{t('确认目标 Node 的队列')}</h3><p>{t('{{node}} 当前已有 {{count}} 项排队或执行中的工作。是否继续提交到这台设备？', { node: nodeName(value.pendingConfirmation.nodeID), count: value.pendingConfirmation.waitingCount })}</p>
      <Button variant="primary" disabled={busy} onClick={() => void perform(() => api(`/workflows/${value.id}/confirm`, { nodeID: value.pendingConfirmation!.nodeID }))}>{t('确认继续排队')}</Button>
    </section>}
    <section className="workflow-map-section" hidden={!expanded}>
      {expanded && <button type="button" className="workflow-map-toggle" aria-expanded={expanded} aria-controls={processID} onClick={closeProcess}>
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}<GitBranch size={16} /><strong>{status}</strong><span>{t('执行过程')}</span>
        <span>{value.planVersion ? t('{{done}} / {{total}} 步骤完成', { done: value.steps.filter((s) => s.state === 'completed').length, total: value.steps.length }) : t('规划过程')}
          {value.handoffs.length ? ` · ${t('{{count}} 次转交', { count: value.handoffs.length })}` : ''}</span>
      </button>}
      <div id={processID} hidden={!expanded}>
      {expanded && <>
      {value.target.mode !== 'automatic' && <p className="workflow-detail-meta">{value.target.mode === 'locked' ? '@@' : '@'} {nodeName(value.target.nodeID)} · {value.target.mode === 'locked' ? t('全部执行锁定在此 Node') : t('优先在此 Node 执行')}</p>}
      {value.summary && <div className="workflow-plan-summary" tabIndex={-1} data-search-target={searchTargetID({ kind: 'plan', roundID })}><h3>{t('计划说明')}</h3><p><SearchText text={value.summary} query={searchQuery} /></p></div>}
      {value.events.some((e) => e.kind === 'query') && <details className="workflow-query-log"><summary><FileText size={14} />{t('资源查询记录')}<span>{value.events.filter((e) => e.kind === 'query').length}</span></summary>
        {value.events.filter((e) => e.kind === 'query').map((event) => <p key={event.id}>{event.text}</p>)}</details>}
      {complex && <WorkflowGraph value={value} nodeName={nodeName} select={choose} selected={selectedStep ? `${selectedStep.id}:${selectedAttempt?.number || 0}` : null} />}
    {selectedStep && <section ref={selectedDetail} tabIndex={-1} className="workflow-selected-step" aria-label={t('步骤详情')}>
      <div className="workflow-detail-heading"><div><small>{selectedStep.id === 'planner' ? t('规划过程') : t('步骤详情')}</small><h3>{selectedStep.title}</h3></div>
        {!selectedStep.attempts.length && !terminal && selectedStep.id !== 'planner' &&
          <Button disabled={busy} onClick={() => edit(selectedStep)}>{t('修改此步骤')}</Button>}
      </div>
      <p className="workflow-detail-meta">{workflowStepLabel(selectedStep, selectedAttempt)} · {selectedAttempt ? nodeName(selectedAttempt.nodeID) : t('待分配')}
        {selectedAttempt && ` · ${t('第 {{count}} 次执行', { count: selectedAttempt.number })}`}</p>
      {checkpoint && <article className="chat-message assistant" tabIndex={-1}
        data-search-target={searchTargetID({ kind: 'step', roundID, stepID: selectedStep.id, attempt: selectedAttempt?.number })}><div className="chat-message-byline"><strong>{t('本步骤的结果')}</strong></div>
        <MessageMarkdown text={checkpoint} searchQuery={searchQuery} /><div className="message-actions-row"><CopyButton text={checkpoint} label={t('复制执行结果')} /></div></article>}
      {selectedAttempt?.error && selectedAttempt.phase !== 'stopped' && <p className="workflow-error">{workflowError(selectedAttempt.error)}</p>}
      {current.local && <TaskTelemetryView task={current.local} />}
      <details className="workflow-execution-detail"><summary>{t('查看步骤要求与执行记录')}<ChevronDown size={14} /></summary>
        {selectedAttempt?.error && selectedAttempt.phase === 'stopped' && <p className="muted">{t('执行记录')}：{workflowError(selectedAttempt.error)}</p>}
        <p className="workflow-instructions">{selectedStep.instructions}</p>
        {value.handoffs.filter((h) => h.stepID === selectedStep.id).map((h) => <p key={h.id}>{t('执行转交')}：{nodeName(h.fromNodeID)} #{h.fromAttempt} → {nodeName(h.toNodeID)} #{h.toAttempt} · {h.reason}</p>)}
        {selectedStep.dependsOn.length > 0 && <p>{t('前置步骤')}：{selectedStep.dependsOn.map((id) => value.steps.find((s) => s.id === id)?.title || id).join(' · ')}</p>}
        {selectedStep.attempts.length > 1 && <label className="workflow-attempt-select">{t('执行记录')}<select value={selectedAttempt?.number || ''}
          onChange={(event) => setSelection({ stepID: selectedStep.id, attempt: Number(event.target.value) })}>
          {selectedStep.attempts.map((attempt) => <option key={attempt.number} value={attempt.number}>#{attempt.number} · {nodeName(attempt.nodeID)}</option>)}
        </select></label>}
        {(current.local?.messages || []).filter((message) => message.role === 'assistant').map((message) => <div key={message.id}>
          <MessageTrace message={message} showText={false} active={current.local?.state === 'running'} />
          {message.text && <details className="chat-tool"><summary>{t('模型回复原文')}</summary><pre>{message.text}</pre></details>}
        </div>)}
        {!current.local && current.remote?.executionSummary && <pre>{current.remote.executionSummary}</pre>}
        {selectedAttempt && <small className="workflow-execution-id">{t('执行标识')}：{selectedAttempt.executionID}</small>}
      </details>
      {(current.local || current.remote) && <TaskFilesPanel key={selectedAttempt!.executionID} scope={current.remote ? 'remote' : 'local'} taskID={selectedAttempt!.executionID} nodeName={nodeName} />}
    </section>}
      </>}
      </div>
    </section>
    {editing && <Modal title={t('修改尚未开始的步骤')} close={() => setEditing(null)} subtitle={t('依赖关系会重新检查；已开始的执行保留原要求。')}>
      <form className="workflow-step-editor" onSubmit={(event) => { event.preventDefault();
        void perform(() => api(`/workflows/${value.id}/steps`, { version: editingVersion, step: editing })).then((ok) => { if (ok) setEditing(null); }); }}>
        <Field label={t('步骤名称')}><input required maxLength={160} value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></Field>
        <Field label={t('步骤要求')}><textarea required rows={5} maxLength={12000} value={editing.instructions} onChange={(e) => setEditing({ ...editing, instructions: e.target.value })} /></Field>
        <Field label={t('首选执行 Node')}><select disabled={value.target.mode === 'locked'} value={editing.nodeID || ''} onChange={(e) => setEditing({ ...editing, nodeID: e.target.value || null })}>
          <option value="">{t('自动选择')}</option>{[...(data.network.local ? [data.network.local] : []), ...(data.network.paired || [])].map((node) => <option key={node.id} value={node.id}>{nodeName(node.id)}</option>)}
        </select></Field>
        <fieldset><legend>{t('前置步骤')}</legend>{value.steps.filter((s) => s.id !== editing.id).map((step) => <label key={step.id}>
          <input type="checkbox" checked={editing.dependsOn.includes(step.id)} onChange={(e) => setEditing({ ...editing,
            dependsOn: e.target.checked ? [...editing.dependsOn, step.id] : editing.dependsOn.filter((id) => id !== step.id) })} />{step.title}
        </label>)}</fieldset><Button type="submit" variant="primary" disabled={busy}>{t('保存修改')}</Button>
      </form>
    </Modal>}
  </div>;
}
