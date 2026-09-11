import type { Workflow, WorkflowAttempt, WorkflowStep } from '../shared/workflows.ts';

export type WorkflowResult = { step: WorkflowStep; attempt: WorkflowAttempt; summary: string };

/** Final outputs belong to the current plan's terminal steps, independent of graph selection. */
export function workflowResults(value: Workflow): WorkflowResult[] {
  if (!['completed', 'failed', 'stopped'].includes(value.state)) return [];
  const dependencies = new Set(value.steps.flatMap((step) => step.dependsOn));
  return value.steps.flatMap((step) => {
    const attempt = step.attempts.at(-1);
    if (value.state === 'completed' && dependencies.has(step.id) || step.state !== 'completed' || !attempt || attempt.phase !== 'completed') return [];
    // A query, handoff or expansion checkpoint is never an overall completion response.
    if (attempt.outcome && attempt.outcome.kind !== 'completed') return [];
    const summary = attempt.outcome?.kind === 'completed' ? attempt.outcome.summary : step.checkpoint;
    return [{ step, attempt, summary }];
  });
}
