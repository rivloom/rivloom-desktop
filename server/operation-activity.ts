import { randomUUID } from 'node:crypto';
import { knowledgeActivityActions, type KnowledgeActivityAction, type OperationActivity } from '../shared/operation-activity.ts';

export type OperationOutcome = { status: 'completed' | 'partial' | 'failed'; error?: unknown };
const completedLifetime = 8_000;
function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : error;
  return typeof message === 'string' && /^knowledge_[a-z_]{1,80}$/.test(message) ? message : 'knowledge_request_failed';
}

/** At most three records per action: active, recently completed, and unresolved failure.
 * Active work is counted rather than evicted, so an arbitrarily long operation remains visible.
 * Errors are deliberately not cleared by an unrelated successful operation of the same kind.
 */
export class OperationActivityRegistry {
  private active = new Map<KnowledgeActivityAction, OperationActivity>();
  private completed = new Map<KnowledgeActivityAction, OperationActivity>();
  private issues = new Map<KnowledgeActivityAction, OperationActivity>();
  private now: () => number;
  private onChange: () => void;
  constructor(onChange = () => {}, now = Date.now) { this.onChange = onChange; this.now = now; }
  private changed() { try { this.onChange(); } catch { /* Observability must not alter operation results. */ } }
  snapshot(): OperationActivity[] {
    const now = this.now();
    for (const [action, item] of this.completed) if (now - item.completedAt! >= completedLifetime) this.completed.delete(action);
    return [...this.active.values(), ...this.issues.values(), ...this.completed.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt).map((item) => ({ ...item }));
  }
  dismiss(id: string) {
    for (const collection of [this.issues, this.completed]) for (const [action, item] of collection) {
      if (item.id === id) { collection.delete(action); this.changed(); return true; }
    }
    return false;
  }
  begin(action: KnowledgeActivityAction) {
    if (!knowledgeActivityActions.includes(action)) throw new Error('knowledge_invalid_request');
    const startedAt = this.now();
    const group = this.active.get(action) || { id: randomUUID(), action, status: 'running' as const, startedAt, updatedAt: startedAt, activeCount: 0 };
    group.activeCount!++; group.updatedAt = startedAt; this.active.set(action, group); this.changed();
    let finished = false;
    return { finish: (outcome: OperationOutcome = { status: 'completed' }) => {
      if (finished) return; finished = true;
      const now = this.now(); group.activeCount!--; group.updatedAt = now;
      if (!group.activeCount) this.active.delete(action);
      if (outcome.status === 'completed') {
        this.completed.set(action, { id: randomUUID(), action, status: 'completed', startedAt, updatedAt: now, completedAt: now });
      } else {
        const previous = this.issues.get(action);
        this.issues.set(action, { id: previous?.id || randomUUID(), action, status: outcome.status,
          startedAt: previous?.startedAt ?? startedAt, updatedAt: now, completedAt: now,
          occurrences: Math.min(1_000_000, (previous?.occurrences || 0) + 1), error: safeError(outcome.error) });
      }
      this.changed();
    } };
  }
  trackSync<T>(action: KnowledgeActivityAction, run: () => T, outcome?: (value: T) => OperationOutcome): T {
    const operation = this.begin(action);
    try { const value = run(); operation.finish(outcome?.(value)); return value; }
    catch (error) { operation.finish({ status: 'failed', error }); throw error; }
  }
  async track<T>(action: KnowledgeActivityAction, run: () => Promise<T>, outcome?: (value: T) => OperationOutcome): Promise<T> {
    const operation = this.begin(action);
    try { const value = await run(); operation.finish(outcome?.(value)); return value; }
    catch (error) { operation.finish({ status: 'failed', error }); throw error; }
  }
}
