import type { Workflow, WorkflowAttempt, WorkflowStep } from '../shared/workflows.ts';

export type WorkflowActivityItem = {
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
    return { step, attempt, nodeID: attempt?.nodeID || null, durationMilliseconds: workflowAttemptDuration(attempt) };
  });
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
