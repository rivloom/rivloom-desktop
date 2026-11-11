import { t } from '../shared/i18n.ts';
import type { TaskFileState, TaskFileQuery } from './task-file-state.ts';
import { taskFileQueryKey } from './task-file-state.ts';
import type { Workflow } from '../shared/workflows.ts';
import { workflowAllSteps } from '../shared/workflows.ts';

export type ActivityTone = 'active' | 'waiting' | 'attention' | 'unavailable' | 'settled';
export type ActivityTransfer = {
  key: string; route: TaskFileQuery; fileID: string; name: string;
  peerNodeID: string | null; direction: 'send' | 'receive';
  state: 'sending' | 'receiving' | 'waiting' | 'complete' | 'failed';
  bytes: number; total: number; fresh: boolean;
};
export type ConversationActivitySummary = {
  label: string; detail: string; tone: ActivityTone;
  transfers: ActivityTransfer[]; transferring: number; waiting: number; failures: number;
};

/** A file's transport identity includes its destination. A remote manifest is not a receive. */
export function activityTransfers(states: readonly TaskFileState[]): ActivityTransfer[] {
  const result = new Map<string, ActivityTransfer>();
  for (const snapshot of states) {
    if (!snapshot.value) continue;
    for (const purpose of ['inputs', 'results'] as const) for (const file of snapshot.value[purpose]) {
      const base = { route: snapshot.route, fileID: file.id, name: file.name,
        total: Math.max(0, file.bytes), fresh: snapshot.fresh };
      const identity = `${taskFileQueryKey(snapshot.route)}:${purpose}:${file.id}`;
      // Local/prepared input files are not an incoming network transfer.
      if (file.state !== 'remote' && (file.sourceNodeID || file.state === 'receiving' || file.state === 'failed')) {
        const key = `${identity}:receive:${file.sourceNodeID || ''}`;
        result.set(key, { ...base, key, peerNodeID: file.sourceNodeID || null, direction: 'receive', state: file.state,
          bytes: Math.max(0, Math.min(file.receivedBytes, base.total)) });
      }
      for (const delivery of file.deliveries) {
        const key = `${identity}:send:${delivery.peerNodeID}`;
        result.set(key, { ...base, key, peerNodeID: delivery.peerNodeID, direction: 'send', state: delivery.state,
          bytes: Math.max(0, Math.min(delivery.bytes, base.total)) });
      }
    }
  }
  return [...result.values()];
}

/** Summary counts never turn a changing collection into an invented total percentage. */
export function conversationActivitySummary(input: {
  label: string; tone: ActivityTone; files: readonly TaskFileState[]; executionCount?: number; attentionCount?: number;
}): ConversationActivitySummary {
  const transfers = activityTransfers(input.files);
  const failures = transfers.filter(file => file.fresh && file.state === 'failed').length;
  const transferring = transfers.filter(file => file.fresh && ['sending', 'receiving'].includes(file.state)).length;
  const waiting = transfers.filter(file => file.fresh && file.state === 'waiting').length;
  const unavailable = input.files.some(file => !!file.error || !!file.value && !file.fresh);
  const loading = input.files.some(file => !file.value && file.loading);
  const detail: string[] = [];
  const attention = input.attentionCount || 0;
  if (attention) detail.push(t('{{count}} 项待处理', { count: attention }));
  if (failures) detail.push(t('{{count}} 项传输失败', { count: failures }));
  if (transferring) detail.push(t('{{count}} 项传输', { count: transferring }));
  if (waiting) detail.push(t('{{count}} 项等待传输', { count: waiting }));
  if ((input.executionCount || 0) > 1) detail.push(t('{{count}} 项执行', { count: input.executionCount }));
  if (unavailable) detail.push(t('文件状态待更新'));
  else if (loading) detail.push(t('正在读取文件状态'));
  const tone: ActivityTone = attention || failures || input.tone === 'attention' ? 'attention'
    : unavailable || input.tone === 'unavailable' ? 'unavailable'
      : transferring ? 'active' : waiting ? input.tone === 'active' ? 'active' : 'waiting'
        : loading && input.tone === 'settled' ? 'waiting' : input.tone;
  const label = input.tone === 'settled' && (transferring || waiting || failures || unavailable || loading)
    ? failures ? t('文件传输需要处理') : transferring ? t('正在传输文件') : waiting ? t('等待传输') : t('文件状态待更新')
    : input.label;
  return { label, detail: detail.join(' · '), tone, transfers, transferring, waiting, failures };
}

/** Current attempts plus explicitly requested historical retrievals, never arbitrary old receipts. */
export function workflowActivityFileRoutes(value: Workflow, requested: readonly TaskFileQuery[]): TaskFileQuery[] {
  const current = (value.planVersion ? value.steps : [value.planner]).flatMap(step => {
    const attempt = step.attempts.at(-1);
    return attempt && (attempt.inputFiles.length || attempt.outputFiles.length)
      ? [{ scope: attempt.kind, taskID: attempt.executionID }] : [];
  });
  const owned = new Set(workflowAllSteps(value).flatMap(step => step.attempts.map(attempt => `${attempt.kind}:${attempt.executionID}`)));
  return [...new Map([...current, ...requested.filter(route => owned.has(taskFileQueryKey(route)))]
    .map(route => [taskFileQueryKey(route), route])).values()];
}

/** A manually viewed planner/attempt remains addressable after business execution begins. */
export function workflowActivitySelection(value: Pick<Workflow, 'planVersion' | 'planner' | 'steps'>,
  selection: { stepID: string; attempt: number } | null) {
  const activeSteps = value.planVersion ? value.steps : [value.planner];
  const step = selection ? [value.planner, ...value.steps].find(item => item.id === selection.stepID)
    : activeSteps.find(item => ['running', 'failed', 'blocked'].includes(item.state)) || activeSteps.at(-1);
  const attempt = selection?.attempt ? step?.attempts.find(item => item.number === selection.attempt) : step?.attempts.at(-1);
  return { step, attempt, planning: step === value.planner };
}

/** Initialization/reconnection is a snapshot, not evidence of new movement. */
export function advancingTransfers(previous: readonly ActivityTransfer[], next: readonly ActivityTransfer[]): ActivityTransfer[] {
  const before = new Map(previous.map(file => [file.key, file]));
  return next.filter(file => {
    const old = before.get(file.key);
    return old?.fresh && file.fresh && ['sending', 'receiving'].includes(file.state) && file.bytes > old.bytes && file.total === old.total;
  });
}

/** Preserve the anchor at the top boundary, where the viewport cannot scroll any farther back. */
export function activityScrollCompensation(before: number, after: number, scrollTop: number, retainedBefore: number) {
  const target = scrollTop + after - before - retainedBefore;
  return { scrollTop: Math.max(0, target), beforeSpace: Math.max(0, -target) };
}
