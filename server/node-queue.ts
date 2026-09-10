import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  isNodeQueueCandidate,
  type NodeQueueControl,
  type NodeQueueEntry,
  type NodeQueueOperationResult,
  type NodeQueueReason,
  type NodeQueueSnapshot,
  type NodeQueueSource,
} from '../shared/node-queue.ts';

export class NodeQueueError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const reason = (value: NodeQueueReason | null) => (value ? JSON.stringify(value) : null);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const pending = (entry: NodeQueueEntry) => ['waiting', 'held'].includes(entry.state);
function sourceKey(source: NodeQueueSource) {
  return source.kind === 'local' ? `local:${source.taskID}` : `remote:${source.remoteTaskID}`;
}
function normalizeSource(source: NodeQueueSource): NodeQueueSource {
  if (source.kind === 'local' && typeof source.taskID === 'string' && source.taskID.length)
    return { kind: 'local', taskID: source.taskID };
  if (
    source.kind === 'remote' &&
    [source.remoteTaskID, source.ownerNodeID, source.ownerBrainID].every(
      (value) => typeof value === 'string' && value.length > 0,
    )
  )
    return {
      kind: 'remote',
      remoteTaskID: source.remoteTaskID,
      ownerNodeID: source.ownerNodeID,
      ownerBrainID: source.ownerBrainID,
      ...(source.brainTaskID ? { brainTaskID: source.brainTaskID } : {}),
    };
  throw new NodeQueueError(400, '队列来源无效。');
}

/**
 * Uses the application's SQLite connection. The asynchronous authorization/admission
 * checks must run under WorkerAdmissionGate; each synchronous mutation is atomic here.
 * No JSON store write or engine call is claimed to participate in this transaction.
 */
export class NodeQueueStore {
  private readonly db: DatabaseSync;
  private readonly clock: () => number;

  constructor(db: DatabaseSync, options: { clock?: () => number } = {}) {
    this.db = db;
    this.clock = options.clock || Date.now;
    db.exec(`
      CREATE TABLE IF NOT EXISTS node_queue (
        id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        local_task_id TEXT UNIQUE,
        received_sequence INTEGER NOT NULL UNIQUE,
        sort_order INTEGER NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('waiting','held','admitted','ended')),
        version INTEGER NOT NULL,
        block_reason TEXT,
        end_reason TEXT,
        admission_phase TEXT CHECK(admission_phase IN ('reserved','bound','starting','started')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS node_queue_metadata (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        version INTEGER NOT NULL,
        next_sequence INTEGER NOT NULL,
        paused INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS node_queue_operations (
        operation_id TEXT PRIMARY KEY,
        request TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS node_queue_state_order ON node_queue(state,sort_order);
    `);
    db.prepare('INSERT OR IGNORE INTO node_queue_metadata VALUES(1,0,1,0,?)').run(this.now());
  }

  private now() {
    return new Date(this.clock()).toISOString();
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = operation();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private metadata() {
    return this.db.prepare('SELECT * FROM node_queue_metadata WHERE singleton=1').get() as {
      version: number;
      next_sequence: number;
      paused: number;
      updated_at: string;
    };
  }

  private touch() {
    this.db
      .prepare('UPDATE node_queue_metadata SET version=version+1,updated_at=? WHERE singleton=1')
      .run(this.now());
  }

  private decode(row: Record<string, unknown>): NodeQueueEntry {
    return {
      id: String(row.id),
      source: JSON.parse(String(row.source)),
      localTaskID: row.local_task_id === null ? null : String(row.local_task_id),
      receivedSequence: Number(row.received_sequence),
      order: Number(row.sort_order),
      state: row.state as NodeQueueEntry['state'],
      version: Number(row.version),
      blockReason: row.block_reason === null ? null : JSON.parse(String(row.block_reason)),
      endReason: row.end_reason === null ? null : JSON.parse(String(row.end_reason)),
      admissionPhase: row.admission_phase as NodeQueueEntry['admissionPhase'],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  list(): NodeQueueEntry[] {
    return this.db
      .prepare('SELECT * FROM node_queue ORDER BY sort_order')
      .all()
      .map((row) => this.decode(row));
  }

  get(id: string): NodeQueueEntry | null {
    const row = this.db.prepare('SELECT * FROM node_queue WHERE id=?').get(id);
    return row ? this.decode(row) : null;
  }

  findBySource(source: NodeQueueSource): NodeQueueEntry | null {
    const row = this.db
      .prepare('SELECT * FROM node_queue WHERE source_key=?')
      .get(sourceKey(source));
    return row ? this.decode(row) : null;
  }

  private requireEntry(id: string) {
    const entry = this.get(id);
    if (!entry) throw new NodeQueueError(404, '队列项不存在。');
    return entry;
  }

  snapshot(): NodeQueueSnapshot {
    const metadata = this.metadata();
    const position = { local: 0, remote: 0 };
    return {
      version: metadata.version,
      paused: !!metadata.paused,
      updatedAt: metadata.updated_at,
      entries: this.list().map((entry) => ({
        ...entry,
        position: !metadata.paused && isNodeQueueCandidate(entry) ? ++position[entry.source.kind] : null,
      })),
    };
  }

  enqueue(input: NodeQueueSource, persistSource: () => void = () => {}): NodeQueueEntry {
    const source = normalizeSource(input);
    return this.transaction(() => {
      const existing = this.findBySource(source);
      if (existing) {
        if (!same(existing.source, source))
          throw new NodeQueueError(409, '同一队列来源引用不能改换任务归属。');
        return existing;
      }
      const sequence = this.metadata().next_sequence;
      persistSource();
      const id = randomUUID();
      const timestamp = this.now();
      this.db
        .prepare('INSERT INTO node_queue VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(
          id,
          sourceKey(source),
          JSON.stringify(source),
          source.kind === 'local' ? source.taskID : null,
          sequence,
          sequence,
          'waiting',
          1,
          null,
          null,
          null,
          timestamp,
          timestamp,
        );
      this.db
        .prepare('UPDATE node_queue_metadata SET next_sequence=next_sequence+1 WHERE singleton=1')
        .run();
      this.touch();
      return this.requireEntry(id);
    });
  }

  private update(entry: NodeQueueEntry, patch: Partial<NodeQueueEntry>) {
    const next = { ...entry, ...patch, version: entry.version + 1, updatedAt: this.now() };
    this.db
      .prepare(
        `UPDATE node_queue SET local_task_id=?,sort_order=?,state=?,version=?,block_reason=?,
          end_reason=?,admission_phase=?,updated_at=? WHERE id=?`,
      )
      .run(
        next.localTaskID,
        next.order,
        next.state,
        next.version,
        reason(next.blockReason),
        reason(next.endReason),
        next.admissionPhase,
        next.updatedAt,
        entry.id,
      );
    this.touch();
    return next;
  }

  /** Change facts, not order. Repeated observations don't manufacture newer receipts. */
  setBlockReason(id: string, blockReason: NodeQueueReason | null) {
    return this.transaction(() => {
      const entry = this.requireEntry(id);
      if (entry.state === 'ended' || same(entry.blockReason, blockReason)) return entry;
      return this.update(entry, { blockReason });
    });
  }

  private operation(
    operationID: string,
    request: unknown,
    apply: () => NodeQueueEntry | null,
  ): NodeQueueOperationResult {
    if (!operationID || operationID.length > 128)
      throw new NodeQueueError(400, '队列操作标识无效。');
    return this.transaction(() => {
      const canonical = JSON.stringify(request);
      const existing = this.db
        .prepare('SELECT request,result FROM node_queue_operations WHERE operation_id=?')
        .get(operationID);
      if (existing) {
        if (existing.request !== canonical)
          throw new NodeQueueError(409, '同一操作标识不能用于不同的队列操作。');
        return JSON.parse(String(existing.result)) as NodeQueueOperationResult;
      }
      const entry = apply();
      const metadata = this.metadata();
      const result = {
        operationID,
        queueVersion: metadata.version,
        paused: !!metadata.paused,
        entry,
      };
      this.db
        .prepare('INSERT INTO node_queue_operations VALUES(?,?,?,?)')
        .run(operationID, canonical, JSON.stringify(result), this.now());
      return result;
    });
  }

  control(input: NodeQueueControl, onRejected: (entry: NodeQueueEntry) => void = () => {}) {
    const request: NodeQueueControl = {
      operationID: input.operationID,
      itemID: input.itemID,
      expectedVersion: input.expectedVersion,
      ...(input.expectedQueueVersion !== undefined
        ? { expectedQueueVersion: input.expectedQueueVersion }
        : {}),
      action: input.action,
      ...(input.reason !== undefined ? { reason: input.reason.trim() } : {}),
    };
    return this.operation(request.operationID, request, () => {
      const entry = this.requireEntry(request.itemID);
      if (entry.version !== request.expectedVersion || !pending(entry))
        throw new NodeQueueError(409, '队列项已变化或已经准入，请刷新后再操作。');
      if (request.action === 'up' || request.action === 'down') {
        if (request.expectedQueueVersion !== this.metadata().version)
          throw new NodeQueueError(409, '队列顺序已变化，请刷新后再排序。');
        const entries = this.list().filter(pending);
        const index = entries.findIndex((candidate) => candidate.id === entry.id);
        const neighbor = entries[index + (request.action === 'up' ? -1 : 1)];
        if (!neighbor) return entry;
        // Avoid violating the UNIQUE sort_order while swapping two persistent positions.
        this.db.prepare('UPDATE node_queue SET sort_order=-1 WHERE id=?').run(entry.id);
        this.update(neighbor, { order: entry.order });
        return this.update(entry, { order: neighbor.order });
      }
      if (request.action === 'reject') {
        if (!request.reason || request.reason.length > 500)
          throw new NodeQueueError(400, '请填写 1–500 字的拒绝原因。');
        onRejected(entry);
        return this.update(entry, {
          state: 'ended',
          blockReason: null,
          endReason: { code: 'rejected', message: request.reason },
        });
      }
      if (request.action === 'hold') {
        if (entry.state === 'held') return entry;
        return this.update(entry, { state: 'held', blockReason: { code: 'held' } });
      }
      if (request.action === 'resume') {
        if (entry.state !== 'held') return entry;
        return this.update(entry, { state: 'waiting', blockReason: null });
      }
      throw new NodeQueueError(400, '不支持的队列操作。');
    });
  }

  setPaused(input: { operationID: string; expectedVersion: number; paused: boolean }) {
    const request = {
      operationID: input.operationID,
      expectedVersion: input.expectedVersion,
      paused: input.paused,
    };
    return this.operation(input.operationID, request, () => {
      const current = this.metadata();
      if (request.expectedVersion !== current.version)
        throw new NodeQueueError(409, '队列已经变化，请刷新后再操作。');
      if (!!current.paused !== request.paused) {
        this.db
          .prepare('UPDATE node_queue_metadata SET paused=? WHERE singleton=1')
          .run(request.paused ? 1 : 0);
        this.touch();
      }
      return null;
    });
  }

  /** Final checks and this reservation must share the application's admission gate. */
  admit(id: string, expectedVersion: number, localTaskID: string) {
    return this.transaction(() => {
      const entry = this.requireEntry(id);
      if (!localTaskID) throw new NodeQueueError(400, '本机任务标识无效。');
      if (entry.state === 'admitted' && entry.localTaskID === localTaskID) return entry;
      if (
        entry.version !== expectedVersion ||
        !isNodeQueueCandidate(entry) ||
        this.metadata().paused ||
        (entry.localTaskID !== null && entry.localTaskID !== localTaskID)
      )
        throw new NodeQueueError(409, '队列项已变化或暂时不能准入。');
      return this.update(entry, {
        state: 'admitted',
        localTaskID,
        admissionPhase: entry.source.kind === 'local' ? 'bound' : 'reserved',
        blockReason: null,
      });
    });
  }

  /** Reconcile proof of an already accepted M3.4 reservation, never a new allocation. */
  restoreAdmission(id: string, localTaskID: string) {
    return this.transaction(() => {
      const entry = this.requireEntry(id);
      if (entry.state === 'admitted' && entry.localTaskID === localTaskID) return entry;
      if (
        entry.state !== 'waiting' ||
        (entry.localTaskID !== null && entry.localTaskID !== localTaskID)
      )
        throw new NodeQueueError(409, '旧准入证明与队列终态或绑定冲突。');
      return this.update(entry, {
        state: 'admitted',
        localTaskID,
        admissionPhase: 'reserved',
        blockReason: null,
      });
    });
  }

  /** persistTask must be synchronous and use this same SQLite connection. */
  bindTask(id: string, localTaskID: string, persistTask: () => void = () => {}) {
    return this.transaction(() => {
      const entry = this.requireEntry(id);
      if (entry.state !== 'admitted' || entry.localTaskID !== localTaskID)
        throw new NodeQueueError(409, '队列任务绑定与准入记录不匹配。');
      if (entry.admissionPhase !== 'reserved') return entry;
      persistTask();
      return this.update(entry, { admissionPhase: 'bound' });
    });
  }

  /** Persist before any session.create call; an interrupted starting phase is uncertain. */
  markStarting(id: string) {
    return this.transaction(() => {
      const entry = this.requireEntry(id);
      if (entry.state !== 'admitted' || entry.admissionPhase !== 'bound')
        throw new NodeQueueError(409, '已有启动意图，不能重复自动创建引擎会话。');
      return this.update(entry, { admissionPhase: 'starting' });
    });
  }

  markStarted(id: string) {
    return this.transaction(() => {
      const entry = this.requireEntry(id);
      if (entry.state !== 'admitted') throw new NodeQueueError(409, '队列项不能再启动。');
      if (entry.admissionPhase === 'started') return entry;
      if (entry.admissionPhase !== 'starting') throw new NodeQueueError(409, '缺少持久启动意图。');
      return this.update(entry, { admissionPhase: 'started' });
    });
  }

  /** Only call for an authoritative terminal fact; never infer it from disconnects. */
  end(id: string, endReason: NodeQueueReason, persistTerminal: () => void = () => {}) {
    return this.transaction(() => {
      const entry = this.requireEntry(id);
      if (entry.state === 'ended') return entry;
      if (
        ![
          'rejected',
          'cancelled',
          'expired',
          'trust_revoked',
          'completed',
          'stopped',
          'failed',
        ].includes(endReason.code)
      )
        throw new NodeQueueError(400, '队列终止原因无效。');
      if (
        entry.state === 'admitted' &&
        ['starting', 'started'].includes(entry.admissionPhase || '') &&
        ['rejected', 'cancelled', 'expired', 'trust_revoked'].includes(endReason.code)
      )
        throw new NodeQueueError(
          409,
          '执行已经开始或状态未知，请先确认停止，不能作为未执行项终止。',
        );
      persistTerminal();
      return this.update(entry, { state: 'ended', endReason, blockReason: null });
    });
  }
}

export function canReleaseUnboundReservation(
  entry: NodeQueueEntry,
  facts: { localTaskExists: boolean; remoteLocalTaskID: string | null; executionSequence: number },
) {
  return (
    entry.state === 'admitted' &&
    entry.admissionPhase === 'reserved' &&
    !facts.localTaskExists &&
    !facts.remoteLocalTaskID &&
    facts.executionSequence === 0
  );
}

export type NodeQueueRecoveryFacts = {
  source: 'live' | 'missing' | 'terminal';
  endReason?: NodeQueueReason;
  task: { id: string; state: string; sessionID: string | null; error?: string | null; collaboration?: { role: string } } | null;
};
export type NodeQueueRecoveryDecision =
  | { action: 'none' | 'reconcile_binding' | 'resume_binding' | 'dispatch' | 'retain_execution' }
  | { action: 'wait' | 'interrupt' | 'end'; reason: NodeQueueReason };

/** Recovery is evidence driven; no active or uncertain execution becomes a fresh attempt. */
export function nodeQueueRecoveryDecision(
  entry: NodeQueueEntry,
  facts: NodeQueueRecoveryFacts,
): NodeQueueRecoveryDecision {
  if (entry.state === 'ended') return { action: 'none' };
  if (entry.state === 'admitted' && facts.task) {
    if (facts.task.id !== entry.localTaskID)
      return { action: 'interrupt', reason: { code: 'state_unknown' } };
    // Task reaches stopped only after the existing stop flow confirms termination.
    // Reconcile persisted rows too; a restart must never re-dispatch this execution.
    if (facts.task.state === 'stopped')
      return { action: 'end', reason: { code: 'stopped' } };
    if (facts.task.state === 'accepted')
      return {
        action: 'end',
        reason: {
          code: 'completed',
        },
      };
    if (facts.task.state === 'failed' && facts.task.collaboration?.role === 'planner' && facts.task.error === 'workflow_invalid_outcome')
      return { action: 'end', reason: { code: 'failed' } };
    if (entry.admissionPhase === 'started') return { action: 'retain_execution' };
    if (entry.admissionPhase === 'starting' || facts.task.sessionID)
      return facts.task.state === 'ready'
        ? { action: 'interrupt', reason: { code: 'state_unknown' } }
        : { action: 'retain_execution' };
    if (facts.task.state !== 'ready') return { action: 'retain_execution' };
  }
  if (facts.source === 'terminal') {
    // A revoked/cancelled source must use the existing stop flow after engine launch.
    if (entry.state === 'admitted' && ['starting', 'started'].includes(entry.admissionPhase || ''))
      return { action: 'interrupt', reason: { code: 'state_unknown' } };
    return { action: 'end', reason: facts.endReason || { code: 'cancelled' } };
  }
  if (facts.source === 'missing') return { action: 'wait', reason: { code: 'state_unknown' } };
  if (entry.state !== 'admitted') return { action: 'dispatch' };
  if (!facts.task) {
    return entry.admissionPhase === 'reserved'
      ? { action: 'resume_binding' }
      : { action: 'interrupt', reason: { code: 'state_unknown' } };
  }
  if (entry.admissionPhase === 'reserved') return { action: 'reconcile_binding' };
  if (entry.admissionPhase === 'bound') return { action: 'dispatch' };
  return { action: 'retain_execution' };
}
