import { useEffect, useState } from 'react';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { language, systemText, t } from '../shared/i18n.ts';
import { matchesWorkflowDiagnostic, workflowDiagnosticSummary, type WorkflowDiagnosticSnapshot, type WorkflowStepDiagnostic } from '../shared/workflow-diagnostics.ts';
import { canRetryWorkflowStep, type Workflow, type WorkflowStep } from '../shared/workflows.ts';
import type { Bootstrap } from '../shared/types.ts';
import { api } from './api';
import { Button } from './ui';
import { CopyButton } from './copy-button';
import { queueReasonLabel } from './task-receipts';
import { diagnosticPhaseLabel, diagnosticReasonLabel, diagnosticRecoveryLabel } from './workflow-diagnostic-labels';

export type WorkflowDiagnosticNavigation = (target: 'diagnostics' | 'models' | 'queue' | 'network', nodeID?: string) => void;
function time(value: string | null) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(language()) : t('尚无可确认的报告时间');
}
export function WorkflowDiagnostics({ value, data, busy, nodeName, showStep, editStep, retry, navigate }: {
  value: Workflow; data: Bootstrap; busy: boolean; nodeName: (id: string | null) => string;
  showStep: (step: WorkflowStep) => void; editStep: (step: WorkflowStep) => void; retry: (step: WorkflowStep) => void;
  navigate?: WorkflowDiagnosticNavigation;
}) {
  const [snapshot, setSnapshot] = useState<WorkflowDiagnosticSnapshot | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const round = value.roundRequestID || value.requestID;
  const terminal = ['completed', 'failed', 'stopped'].includes(value.state);
  useEffect(() => {
    let disposed = false, generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined;
    const stop = () => { generation++; clearTimeout(timer); controller?.abort(); };
    const read = async () => {
      if (disposed || document.hidden) return;
      const request = ++generation;
      controller = new AbortController();
      try {
        const result = await api<WorkflowDiagnosticSnapshot>(`/workflows/${value.id}/diagnostics`, undefined,
          { signal: controller.signal, timeoutMilliseconds: 5000 });
        if (!disposed && request === generation) {
          if (matchesWorkflowDiagnostic(value, result)) { setSnapshot(result); setUnavailable(false); }
          else setUnavailable(true);
        }
      } catch {
        if (!disposed && request === generation) setUnavailable(true);
      } finally {
        if (!disposed && request === generation && !document.hidden && !terminal) timer = setTimeout(() => void read(), 5000);
      }
    };
    const visibility = () => { stop(); if (!document.hidden) void read(); };
    document.addEventListener('visibilitychange', visibility);
    void read();
    return () => { disposed = true; stop(); document.removeEventListener('visibilitychange', visibility); };
  }, [value.id, round, value.version, terminal, refresh]);

  const current = snapshot && matchesWorkflowDiagnostic(value, snapshot) ? snapshot : null;
  const steps = value.planVersion ? value.steps : [value.planner];
  const ordered = [...(current?.steps || [])].sort((a, b) => priority(a) - priority(b));
  const shown = expanded ? ordered : ordered.slice(0, 4);
  return <section className="workflow-diagnostics" aria-label={t('步骤状态与等待原因')}>
    <div className="workflow-diagnostics-heading"><strong>{t('步骤状态')}</strong>
      <button type="button" className="workflow-diagnostics-refresh" onClick={() => setRefresh((n) => n + 1)} aria-label={t('刷新步骤状态')}>
        <RefreshCw size={13} />{t('刷新状态')}</button></div>
    {unavailable && <p className="muted" role="status">{t('最新状态暂时无法确认；下方如有记录，仅供参考。')}</p>}
    {!current && !unavailable && <p className="muted">{t('正在读取步骤状态…')}</p>}
    {!current && unavailable && <div className="workflow-diagnostic-actions">{steps.filter((s) => s.state !== 'completed').map((step) =>
      <Button key={step.id} onClick={() => showStep(step)}>{step.title}</Button>)}</div>}
    {shown.map((item) => {
      const step = steps.find((s) => s.id === item.stepID);
      if (!step) return null;
      const blocked = item.nodes.filter((n) => n.reasons.length);
      const eligible = item.nodes.some((n) => !n.reasons.length);
      const label = item.phase === 'placement' && !eligible ? t('当前没有满足要求的设备') : diagnosticPhaseLabel(item.phase);
      const ownID = data.network.local?.id;
      const nodeID = item.nodeID || (blocked.length === 1 ? blocked[0].nodeID : undefined);
      const reasons = item.nodes.filter((n) => n.nodeID === ownID).flatMap((n) => n.reasons);
      const recovery = diagnosticRecoveryLabel(item);
      const needsDetail = !['running', 'completed', 'stopped'].includes(item.phase);
      return <article className={`workflow-diagnostic-step ${item.phase}`} key={item.stepID}>
        <div className="workflow-diagnostic-title"><button type="button" onClick={() => showStep(step)}>{step.title}</button><span>{label}</span></div>
        <p className="workflow-diagnostic-device">{item.nodeID ? nodeName(item.nodeID) : t('尚未分配设备')}
          {item.observedAt && <span> · {t('最近记录：{{time}}', { time: time(item.observedAt) })}</span>}</p>
        {!!item.dependencies.length && <p>{t('等待：{{steps}}', { steps: item.dependencies.map((id) => steps.find((s) => s.id === id)?.title || id).join('、') })}</p>}
        {item.queue && ['queued', 'held', 'admitted', 'rejected'].includes(item.phase) && <p>
          {item.phase === 'queued' && <>{item.queue.position !== null ? t('最近回执排位：{{position}}', { position: item.queue.position }) : t('当前排位待确认')} · </>}
          {item.queue.code ? queueReasonLabel(item.queue.code) : item.queue.reason ? systemText(item.queue.reason) : t('已收到设备回执')}
          <small> · {time(item.queue.observedAt)}</small></p>}
        {blocked.length === 1 && blocked[0].reasons[0] && <p>{nodeName(blocked[0].nodeID)}：{diagnosticReasonLabel(blocked[0].reasons[0])}</p>}
        {needsDetail && recovery && <p className="muted">{recovery}</p>}
        {!!blocked.length && <details className="workflow-diagnostic-evidence"><summary>{t('查看设备条件')}<ChevronDown size={12} /></summary>
          {blocked.map((node) => <div key={node.nodeID}><strong>{nodeName(node.nodeID)}</strong>
            {node.reasons.map((reason, index) => <p key={`${reason.code}:${index}`}>{diagnosticReasonLabel(reason)}
              <small> · {reason.certainty === 'unknown' ? t('待确认') : t('已确认')} · {time(reason.observedAt)}</small></p>)}
            {navigate && <Button onClick={() => navigate('diagnostics', node.nodeID === ownID ? undefined : node.nodeID)}>{t('查看连接诊断')}</Button>}
          </div>)}
        </details>}
        {needsDetail && <div className="workflow-diagnostic-actions">
          {navigate && nodeID && <Button onClick={() => navigate('diagnostics', nodeID === ownID ? undefined : nodeID)}>{t('查看连接诊断')}</Button>}
          {navigate && data.user.owner && reasons.some((r) => ['project_unavailable', 'model_unavailable', 'engine_unavailable'].includes(r.code)) &&
            <Button onClick={() => navigate('models')}>{t('打开模型与执行设置')}</Button>}
          {navigate && data.user.owner && (item.queue?.local || reasons.some((r) => r.code === 'queue_unavailable')) &&
            <Button onClick={() => navigate('queue')}>{t('查看本机队列')}</Button>}
          {!step.attempts.length && !terminal && step.id !== 'planner' && value.state !== 'stopping' &&
            <Button disabled={busy || unavailable} onClick={() => editStep(step)}>{t('修改此步骤')}</Button>}
          {canRetryWorkflowStep(value, step) && <Button disabled={busy || unavailable} onClick={() => retry(step)}>{t('重试此步骤')}</Button>}
          <Button onClick={() => showStep(step)}>{t('查看步骤')}</Button>
        </div>}
      </article>;
    })}
    {ordered.length > 4 && <button className="workflow-diagnostics-more" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
      {expanded ? t('收起步骤状态') : t('查看全部 {{count}} 个步骤', { count: ordered.length })}</button>}
    {current && <small className="workflow-diagnostics-sampled">{t('本次检查：{{time}}', { time: time(current.sampledAt) })}</small>}
    {current && <details className="workflow-diagnostic-summary"><summary>{t('诊断摘要')}</summary>
      <p className="muted">{t('包含状态、时间和匿名设备编号；步骤编号按计划顺序排列。')}</p>
      <CopyButton text={workflowDiagnosticSummary(current, unavailable)} label={t('复制诊断摘要')} />
      <pre tabIndex={0}>{workflowDiagnosticSummary(current, unavailable)}</pre>
    </details>}
  </section>;
}
function priority(step: WorkflowStepDiagnostic) {
  if (['failed', 'unknown', 'confirmation', 'attention', 'held', 'rejected'].includes(step.phase)) return 0;
  if (['placement', 'queued', 'admitted', 'materials'].includes(step.phase)) return 1;
  if (step.phase === 'completed') return 3;
  return 2;
}
