import { z } from 'zod';
import { jsonBytes } from '../shared/collaboration.ts';
import type { RemoteTaskInvite } from '../shared/types.ts';
import type { Workflow, WorkflowAttempt } from '../shared/workflows.ts';
import { WorkflowStore } from './workflows.ts';
import { workflowContextDigest } from './workflow-contexts.ts';

const requestSchema = z.object({ workflowID: z.string().uuid(), executionID: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.enum(['rivloom_history', 'rivloom_context_note']), args: z.unknown() }).strict();
export type HistoryRemoteExecution = Pick<RemoteTaskInvite, 'direction' | 'targetNodeID' | 'status' | 'executionState' | 'controlPending'>;
export function historyAttempt(value: Workflow, executionID: string, digest: string) {
  const attempt = [value.planner, ...value.steps].map(s => s.attempts.at(-1)).find(a => a?.executionID === executionID);
  if (!attempt || !['planning', 'running'].includes(value.state) || attempt.handled ||
    !['intent', 'queued', 'running', 'waiting'].includes(attempt.phase) || workflowContextDigest(attempt.context, attempt.inputFiles) !== digest)
    throw new Error('context_execution_changed');
  return attempt;
}
export function historyOperation(store: WorkflowStore, value: Workflow, attempt: WorkflowAttempt, name: unknown, args: unknown) {
  if (name === 'rivloom_history') {
    const result = store.history.query(value, args);
    if ('content' in result) store.history.recordRead(value.id, attempt.executionID, result);
    return result;
  }
  if (name === 'rivloom_context_note' && attempt.context.role === 'planner') return store.history.note(value, args, 'inferred');
  throw new Error('context_history_not_authorized');
}
/** Only the authenticated target of this live, accepted execution may query its owning conversation. */
export class WorkflowHistoryAccess {
  private store: WorkflowStore;
  private remote: (id: string) => HistoryRemoteExecution | null;
  private trusted: (peer: string) => boolean;
  private available: (id: string) => boolean;
  constructor(store: WorkflowStore, remote: (id: string) => HistoryRemoteExecution | null, trusted: (peer: string) => boolean, available: (id: string) => boolean) {
    this.store = store; this.remote = remote; this.trusted = trusted; this.available = available;
  }
  handle(peer: string, raw: unknown) {
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success || jsonBytes(raw) > 12_000) throw new Error('context_invalid_request');
    const input = parsed.data;
    if (!this.trusted(peer) || !this.available(input.workflowID)) throw new Error('context_history_not_authorized');
    const value = this.store.get(input.workflowID);
    if (!value) throw new Error('context_history_not_available');
    const attempt = historyAttempt(value, input.executionID, input.digest), remote = this.remote(input.executionID);
    if (attempt.kind !== 'remote' || attempt.nodeID !== peer || !remote || remote.direction !== 'outgoing' ||
      remote.targetNodeID !== peer || remote.status !== 'accepted' || remote.controlPending ||
      ['accepted', 'failed', 'stopped', 'interrupted'].includes(remote.executionState)) throw new Error('context_history_not_authorized');
    const result = historyOperation(this.store, value, attempt, input.name, input.args);
    const reply = { workflowID: value.id, executionID: attempt.executionID, digest: input.digest, name: input.name, result };
    if (jsonBytes(reply) > 60_000) throw new Error('context_history_limit');
    return reply;
  }
}
