import type { DesktopUpdateBlockers } from '../shared/desktop-update.ts';
import type { Task, RemoteTaskInvite, BrainTask } from '../shared/types.ts';
import type { NodeQueueEntry } from '../shared/node-queue.ts';
import type { Workflow } from '../shared/workflows.ts';

export type UpdateReadiness = {
  tasks: readonly Pick<Task, 'state'>[];
  queues: readonly Pick<NodeQueueEntry, 'state'>[];
  workflows: readonly Pick<Workflow, 'state' | 'messages' | 'rounds' | 'roundRequestID' | 'queuePaused'>[];
  remoteTasks: readonly Pick<RemoteTaskInvite, 'status' | 'executionState' | 'controlPending' | 'deliveryPending'>[];
  brainTasks: readonly Pick<BrainTask, 'status' | 'deliveryPending'>[];
  transfers: number;
  operations: number;
  modelChecks: number;
};

/** Intake and coordinator/network dispatch must be fenced before reading this snapshot.
 * Saved queues and remote/coordinator state survive shutdown, including unknown
 * outcomes. Updating never declares them stopped or admits a replacement execution.
 * Actual local execution, asynchronous writes and transfers still have to drain.
 */
export function updateBlockers(input: UpdateReadiness): DesktopUpdateBlockers {
  return {
    tasks: input.tasks.filter((t) => ['running', 'waiting_approval', 'waiting_input', 'stopping', 'interrupted', 'review'].includes(t.state)).length,
    queues: 0,
    workflows: 0,
    remoteTasks: 0,
    brainTasks: 0,
    transfers: input.transfers,
    operations: input.operations,
    modelChecks: input.modelChecks,
  };
}
export function canPrepareUpdate(value: DesktopUpdateBlockers): boolean {
  return Object.values(value).every((count) => count === 0);
}

/** This temporary gate never changes persisted queue or execution policies. */
export class UpdateMaintenance {
  private held = false;
  private operations = 0;
  private expiresAt = 0;
  private sealed = false;
  private readonly clock: () => number;
  constructor(clock: () => number = Date.now) { this.clock = clock; }
  get active(): boolean {
    if (this.held && this.expiresAt && this.clock() >= this.expiresAt) this.release();
    return this.held;
  }
  get pending(): number { return this.operations; }
  get committed(): boolean { return this.sealed; }
  commit(): boolean {
    if (!this.active || this.sealed) return false;
    this.sealed = true; this.expiresAt = 0;
    return true;
  }
  enterOperation(): (() => void) | null {
    if (this.active) return null;
    this.operations++;
    let ended = false;
    return () => { if (!ended) { ended = true; this.operations--; } };
  }
  acquire(): boolean {
    if (this.active) return false;
    this.held = true;
    // A lost native caller must not leave a running service permanently paused.
    this.expiresAt = this.clock() + 120_000;
    return true;
  }
  release(): void { if (!this.sealed) { this.held = false; this.expiresAt = 0; } }
}
