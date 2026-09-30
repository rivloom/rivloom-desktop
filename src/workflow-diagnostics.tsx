import { useEffect, useState } from 'react';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { systemText, t } from '../shared/i18n.ts';
import { matchesWorkflowDiagnostic, type WorkflowDiagnosticSnapshot } from '../shared/workflow-diagnostics.ts';
import { canRetryWorkflowStep, type Workflow, type WorkflowStep } from '../shared/workflows.ts';
import { workflowError } from '../shared/workflow-errors.ts';
import type { Bootstrap } from '../shared/types.ts';
import { api } from './api';
import { Button } from './ui';
import { queueReasonLabel } from './task-receipts';
import { diagnosticPhaseLabel, diagnosticReasonLabel, diagnosticRecoveryLabel } from './workflow-diagnostic-labels';

export type WorkflowDiagnosticNavigation = (target: 'diagnostics' | 'models' | 'queue' | 'network', nodeID?: string) => void;
export function WorkflowRecovery({ value, data, busy, nodeName, showStep, editStep, retry, navigate }: {
  value: Workflow; data: Bootstrap; busy: boolean; nodeName: (id: string | null) => string;
  showStep: (step: WorkflowStep) => void; editStep: (step: WorkflowStep) => void; retry: (step: WorkflowStep) => void;
  navigate?: WorkflowDiagnosticNavigation;
}) {
  const [snapshot, setSnapshot] = useState<WorkflowDiagnosticSnapshot | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [refresh, setRefresh] = useState(0);
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
  const planning = !value.planVersion;
  const steps = value.planVersion ? value.steps : [value.planner];
  // Normal progress belongs to the activity and message trace. Only interruptions need another UI block.
  const shown = (current?.steps || []).filter(item => ['failed', 'unknown', 'held', 'rejected'].includes(item.phase) ||
    item.phase === 'placement' && !item.nodes.some(node => !node.reasons.length) ||
    item.phase === 'dependency' && item.recovery === 'user_action');
  if (!shown.length && !unavailable) return null;
  return <section className="workflow-recovery" aria-label={t('任务进展')}>
    {unavailable && <div className="workflow-recovery-unavailable"><p className="muted" role="status">{t('最新状态暂时无法确认；下方如有记录，仅供参考。')}</p>
      <Button onClick={() => setRefresh(n => n + 1)}><RefreshCw size={13} />{t('刷新状态')}</Button></div>}
    {shown.map((item) => {
      const step = steps.find((s) => s.id === item.stepID);
      if (!step) return null;
      const blocked = item.nodes.filter((n) => n.reasons.length);
      const eligible = item.nodes.some((n) => !n.reasons.length);
      const label = item.phase === 'placement' && !eligible ? t('当前没有满足要求的设备') : diagnosticPhaseLabel(item.phase, planning);
      const ownID = data.network.local?.id;
      const nodeID = item.nodeID || (blocked.length === 1 ? blocked[0].nodeID : undefined);
      const reasons = item.nodes.filter((n) => n.nodeID === ownID).flatMap((n) => n.reasons);
      const recovery = diagnosticRecoveryLabel(item);
      const error = item.phase === 'failed' ? step.attempts.at(-1)?.error : null;
      return <article className={`workflow-recovery-item ${item.phase}`} key={item.stepID}>
        {shown.length > 1 && <button className="workflow-recovery-title" type="button" onClick={() => showStep(step)}>{step.title}</button>}
        {(!error || error !== value.error) && <p className={item.phase === 'failed' ? 'workflow-error' : undefined}>{error ? workflowError(error) : label}</p>}
        {!!item.dependencies.length && <p>{t('等待：{{steps}}', { steps: item.dependencies.map((id) => steps.find((s) => s.id === id)?.title || id).join('、') })}</p>}
        {item.queue && ['held', 'rejected'].includes(item.phase) && (item.queue.code || item.queue.reason) && <p>
          {item.queue.code ? queueReasonLabel(item.queue.code) : systemText(item.queue.reason!)}</p>}
        {blocked.length === 1 && blocked[0].reasons[0] && <p>{nodeName(blocked[0].nodeID)}：{diagnosticReasonLabel(blocked[0].reasons[0])}</p>}
        {recovery && <p className="muted">{recovery}</p>}
        {(blocked.length > 1 || blocked[0]?.reasons.length > 1) && <details className="workflow-diagnostic-evidence"><summary>{t('查看设备条件')}<ChevronDown size={12} /></summary>
          {blocked.map((node) => <div key={node.nodeID}><strong>{nodeName(node.nodeID)}</strong>
            {node.reasons.map((reason, index) => <p key={`${reason.code}:${index}`}>{diagnosticReasonLabel(reason)}</p>)}
            {navigate && <Button onClick={() => navigate('diagnostics', node.nodeID === ownID ? undefined : node.nodeID)}>{t('查看连接诊断')}</Button>}
          </div>)}
        </details>}
        <div className="workflow-diagnostic-actions">
          {navigate && nodeID && <Button onClick={() => navigate('diagnostics', nodeID === ownID ? undefined : nodeID)}>{t('查看连接诊断')}</Button>}
          {navigate && data.user.owner && reasons.some((r) => ['project_unavailable', 'model_unavailable', 'engine_unavailable'].includes(r.code)) &&
            <Button onClick={() => navigate('models')}>{t('打开模型设置')}</Button>}
          {navigate && data.user.owner && (item.queue?.local || reasons.some((r) => r.code === 'queue_unavailable')) &&
            <Button onClick={() => navigate('queue')}>{t('查看本机队列')}</Button>}
          {!step.attempts.length && !terminal && step.id !== 'planner' && value.state !== 'stopping' &&
            <Button disabled={busy || unavailable} onClick={() => editStep(step)}>{t('修改此步骤')}</Button>}
          {canRetryWorkflowStep(value, step) && <Button disabled={busy || unavailable} onClick={() => retry(step)}>{t('重试此步骤')}</Button>}
          <Button onClick={() => showStep(step)}>{t('查看步骤')}</Button>
        </div>
      </article>;
    })}
  </section>;
}
