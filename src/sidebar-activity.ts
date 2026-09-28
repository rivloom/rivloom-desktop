import type { NodeModelActivitySnapshot } from '../shared/node-model-activity.ts';
import type { AttentionItem } from '../shared/task-attention.ts';
import type { OperationActivity } from '../shared/operation-activity.ts';

export function activityRate(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Missing coverage is not a zero, and a partial sum is not a Node total. */
export function visibleModelRates(snapshot: NodeModelActivitySnapshot | null) {
  return {
    inputTokensPerSecond: snapshot?.inputComplete && !snapshot.limited ? activityRate(snapshot.inputTokensPerSecond) : null,
    outputTokensPerSecond: snapshot?.outputComplete && !snapshot.limited ? activityRate(snapshot.outputTokensPerSecond) : null,
  };
}

export type ModelActivityState = 'loading' | 'unavailable' | 'partial' | 'idle' | 'waiting' | 'active' | 'recent';

/** Keep a truthful, inspectable state even when no rate can be shown. */
export function modelActivityState(snapshot: NodeModelActivitySnapshot | null, loading: boolean): ModelActivityState {
  if (!snapshot) return loading ? 'loading' : 'unavailable';
  if (snapshot.limited || !snapshot.countsComplete) return 'partial';
  const rates = visibleModelRates(snapshot);
  if (!snapshot.counts.active) return (rates.outputTokensPerSecond ?? 0) > 0 ? 'recent' : 'idle';
  if (rates.outputTokensPerSecond === null && !snapshot.counts.tools && !snapshot.counts.waiting) return 'waiting';
  return 'active';
}

export function activityRateText(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return value >= 100 ? Math.round(value).toString() : value.toFixed(1);
}

export function activityFresh(receivedAt: number, now: number, connected: boolean, visible: boolean) {
  return connected && visible && receivedAt > 0 && now >= receivedAt && now - receivedAt < 5000;
}

/** Seed the first snapshot; polling or changed details alone never trigger a bounce. */
export function attentionAdded(previous: readonly Pick<AttentionItem, 'key'>[] | null, next: readonly Pick<AttentionItem, 'key'>[]) {
  return previous !== null && next.length > previous.length && next.some(item => !previous.some(old => old.key === item.key));
}

/** Coalesced server failures can retain their ID while new occurrences arrive. */
export function knowledgeActivityVersion(item: Pick<OperationActivity, 'id' | 'updatedAt' | 'occurrences'>) {
  return `${item.id}:${item.updatedAt}:${item.occurrences || 0}`;
}
