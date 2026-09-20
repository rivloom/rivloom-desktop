import type { Bootstrap, Message, RemoteTaskInvite, Task } from '../shared/types.ts';
import type { Workflow, WorkflowAttempt, WorkflowStep } from '../shared/workflows.ts';
import type { WorkflowDiagnosticSnapshot } from '../shared/workflow-diagnostics.ts';

export type WorkflowLatestExecution = { step: WorkflowStep; attempt: WorkflowAttempt; local?: Task; remote?: RemoteTaskInvite };
export type WorkflowRecentExecution = WorkflowLatestExecution & { text: string; tools: { key: string; tool: Message['tools'][number] }[] };

export function workflowLatestExecutions(value: Pick<Workflow, 'planVersion' | 'steps' | 'planner'>, data: Pick<Bootstrap, 'tasks' | 'network'>, historical = false): WorkflowLatestExecution[] {
  if (historical) return [];
  return (value.planVersion ? value.steps : [value.planner]).flatMap(step => {
    const attempt = step.attempts.at(-1);
    if (!attempt) return [];
    return [{ step, attempt,
      local: attempt.kind === 'local' ? data.tasks.find(task => task.id === attempt.executionID) : undefined,
      remote: attempt.kind === 'remote' ? data.network.remoteTasks.find(task => task.id === attempt.executionID) : undefined }];
  });
}

export function workflowExecutionAttention(entry: WorkflowLatestExecution) {
  if (['completed', 'failed', 'stopped'].includes(entry.attempt.phase)) return false;
  return !!(entry.local?.approvals.length || entry.local?.questions.length || entry.remote?.remoteApprovals.length || entry.remote?.remoteQuestions.length);
}

export function workflowAttentionExecutions(entries: readonly WorkflowLatestExecution[], state: Workflow['state']) {
  return ['completed', 'failed', 'stopped'].includes(state) ? [] : entries.filter(workflowExecutionAttention);
}

export function recentWorkflowExecutions(entries: readonly WorkflowLatestExecution[], state: Workflow['state']): WorkflowRecentExecution[] {
  if (['completed', 'failed', 'stopped'].includes(state)) return [];
  return entries.filter(entry => !['completed', 'failed', 'stopped'].includes(entry.attempt.phase)).flatMap(entry => {
    const messages = entry.local?.messages || [];
    const text = entry.local ? messages.findLast(message => message.role === 'assistant' && message.text.trim())?.text || '' : entry.remote?.executionSummary || '';
    const tools: WorkflowRecentExecution['tools'] = [];
    for (let i = messages.length - 1; i >= 0 && tools.length < 2; i--) {
      if (messages[i].role !== 'assistant') continue;
      for (let j = messages[i].tools.length - 1; j >= 0 && tools.length < 2; j--)
        tools.unshift({ key: `${messages[i].id}:${j}`, tool: messages[i].tools[j] });
    }
    return text.trim() || tools.length ? [{ ...entry, text, tools }] : [];
  }).sort((a, b) => Number(workflowExecutionAttention(b)) - Number(workflowExecutionAttention(a)) ||
    (Date.parse(b.attempt.updatedAt) || 0) - (Date.parse(a.attempt.updatedAt) || 0)).slice(0, 2);
}

/** Collapse only a complete healthy diagnostic response; unknown or adverse evidence remains visible. */
export function healthyWorkflowDiagnostics(snapshot: WorkflowDiagnosticSnapshot | null, unavailable: boolean) {
  return !!snapshot && !unavailable && snapshot.steps.length > 0 && snapshot.steps.every(step =>
    ['running', 'completed'].includes(step.phase) && step.recovery === 'none' &&
    step.nodes.every(node => node.reasons.length === 0) &&
    (!step.queue || step.queue.state === 'admitted' && !step.queue.code && !step.queue.reason));
}
