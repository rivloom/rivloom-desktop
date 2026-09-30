import type { Workflow, WorkflowAttempt, WorkflowStep } from '../shared/workflows.ts';
import { language, t } from '../shared/i18n.ts';
import { workflowStepLabel } from './workflow-graph-data.ts';

export type WorkflowActivityItem = {
  role: 'planner' | 'executor';
  step: WorkflowStep;
  attempt: WorkflowAttempt | undefined;
  nodeID: string | null;
  durationMilliseconds: number | null;
};

/** A recorded terminal attempt interval includes queueing, execution and receipt processing. */
export function workflowAttemptDuration(attempt: WorkflowAttempt | undefined): number | null {
  if (!attempt || !['completed', 'failed', 'stopped'].includes(attempt.phase)) return null;
  const start = Date.parse(attempt.createdAt), end = Date.parse(attempt.updatedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

export function workflowActivityItems(value: Pick<Workflow, 'planVersion' | 'steps' | 'planner'>): WorkflowActivityItem[] {
  return (value.planVersion ? value.steps : [value.planner]).map(step => {
    const attempt = step.attempts.at(-1);
    // A planned preference is not evidence that a Node has accepted execution.
    return { role: value.planVersion ? 'executor' : 'planner', step, attempt,
      nodeID: attempt?.nodeID || null, durationMilliseconds: workflowAttemptDuration(attempt) };
  });
}

export function workflowActivityStepLabel(role: WorkflowActivityItem['role'], step: WorkflowStep, attempt?: WorkflowAttempt) {
  const label = workflowStepLabel(step, attempt);
  if (role !== 'planner') return label;
  // Keep the observed transport/attention state instead of suggesting active planning.
  if (attempt && ['intent', 'queued', 'waiting', 'unknown'].includes(attempt.phase)) return label;
  // A selected old planning attempt retains its own result after retries.
  if (attempt && attempt !== step.attempts.at(-1)) {
    if (attempt.phase === 'stopped') return t('规划已停止');
    if (attempt.phase === 'failed') return t('规划失败');
    if (attempt.phase === 'completed') return attempt.outcome?.kind === 'handoff' ? t('规划转交') : t('规划已完成');
    return t('正在分析与规划');
  }
  if (step.state === 'cancelled' || attempt?.phase === 'stopped') return t('规划已停止');
  if (step.state === 'failed' || attempt?.phase === 'failed') return t('规划失败');
  if (step.state === 'completed' && attempt?.phase === 'completed') return t('规划已完成');
  if (step.state === 'running') return t('正在分析与规划');
  return t('等待规划条件');
}

/** Planning attempts use the same transport, but are not business execution. */
export function workflowActivityPresentation(item: WorkflowActivityItem, node: string) {
  const { role, step, attempt, durationMilliseconds } = item;
  const planning = role === 'planner';
  const completed = step.state === 'completed' && attempt?.phase === 'completed';
  const label = workflowActivityStepLabel(role, step, attempt);
  const attribution = planning
    ? node ? completed ? t('由 {{node}} 完成规划', { node }) : t('规划 Node：{{node}}', { node }) : t('待分配规划 Node')
    : node ? completed ? t('由 {{node}} 完成', { node }) : t('执行 Node：{{node}}', { node }) : t('待分配');
  const duration = durationMilliseconds === null ? null : workflowDurationLabel(durationMilliseconds, language());
  const elapsed = duration === null ? planning ? t('规划详情') : t('执行详情')
    : planning ? t('本次规划用时 {{duration}}', { duration }) : t('本次用时 {{duration}}', { duration });
  return { label, attribution, elapsed, completed,
    detailsTitle: planning ? t('查看规划状态与记录') : t('查看状态、步骤进度与执行记录') };
}

function priority(item: WorkflowActivityItem) {
  if (item.step.state === 'failed' || item.attempt?.phase === 'failed') return 0;
  if (item.step.state === 'blocked' || item.attempt?.phase === 'unknown') return 1;
  if (item.step.state === 'running' || item.attempt && ['intent', 'queued', 'waiting', 'running'].includes(item.attempt.phase)) return 2;
  if (item.step.state === 'ready') return 3;
  if (item.step.state === 'waiting') return 4;
  return 5;
}

/** Pick the few most useful rows, then retain their original plan order. */
export function visibleWorkflowActivity(items: readonly WorkflowActivityItem[], limit = 3): WorkflowActivityItem[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) return [];
  if (items.length <= limit) return [...items];
  return items.map((item, index) => ({ item, index })).sort((a, b) => {
    const byPriority = priority(a.item) - priority(b.item);
    if (byPriority) return byPriority;
    const time = (item: WorkflowActivityItem) => {
      const result = item.attempt ? Date.parse(item.attempt.updatedAt) : NaN;
      return Number.isFinite(result) ? result : 0;
    };
    return time(b.item) - time(a.item) || b.index - a.index;
  }).slice(0, limit).sort((a, b) => a.index - b.index).map(({ item }) => item);
}

export function workflowDurationLabel(milliseconds: number, locale: string) {
  const unit = (value: number, name: 'second' | 'minute' | 'hour') => new Intl.NumberFormat(locale,
    { style: 'unit', unit: name, unitDisplay: 'narrow', maximumFractionDigits: 1 }).format(value);
  if (milliseconds < 60_000) return unit(Math.floor(milliseconds / 100) / 10, 'second');
  const seconds = Math.floor(milliseconds / 1000), minutes = Math.floor(seconds / 60);
  if (minutes < 60) return [unit(minutes, 'minute'), seconds % 60 ? unit(seconds % 60, 'second') : ''].filter(Boolean).join(' ');
  return [unit(Math.floor(minutes / 60), 'hour'), minutes % 60 ? unit(minutes % 60, 'minute') : ''].filter(Boolean).join(' ');
}
