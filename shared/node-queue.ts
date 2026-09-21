/** Node-local metadata. Never send an entire queue to another Node. */
export type NodeQueueSource =
  | { kind: 'local'; taskID: string }
  | {
      kind: 'remote';
      remoteTaskID: string;
      ownerNodeID: string;
      ownerBrainID: string;
      brainTaskID?: string;
    };

export type NodeQueueState = 'waiting' | 'held' | 'admitted' | 'ended';
export type NodeQueueReasonCode =
  | 'queue'
  | 'slot'
  | 'queue_paused'
  | 'execution_paused'
  | 'model_unavailable'
  | 'project_unavailable'
  | 'hardware_unavailable'
  | 'engine_unavailable'
  | 'peer_unavailable'
  | 'acceptance_pending'
  | 'attachments_pending'
  | 'held'
  | 'state_unknown'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'trust_revoked'
  | 'completed'
  | 'stopped'
  | 'failed';
export type NodeQueueReason = { code: NodeQueueReasonCode; message?: string };
export type NodeQueueAdmissionPhase = 'reserved' | 'bound' | 'starting' | 'started';

export type NodeQueueEntry = {
  id: string;
  source: NodeQueueSource;
  /** Reserved before creating a remote business Task; immutable once admitted. */
  localTaskID: string | null;
  receivedSequence: number;
  order: number;
  state: NodeQueueState;
  version: number;
  blockReason: NodeQueueReason | null;
  endReason: NodeQueueReason | null;
  admissionPhase: NodeQueueAdmissionPhase | null;
  createdAt: string;
  updatedAt: string;
};
export type NodeQueueItem = NodeQueueEntry & { position: number | null };
export type NodeQueueSnapshot = {
  version: number;
  paused: boolean;
  updatedAt: string;
  entries: NodeQueueItem[];
};
export type NodeQueueAction = 'up' | 'down' | 'hold' | 'resume' | 'reject' | 'cancel';
export type NodeQueueControl = {
  operationID: string;
  itemID: string;
  expectedVersion: number;
  /** Required for ordering changes, whose meaning depends on neighboring entries. */
  expectedQueueVersion?: number;
  action: NodeQueueAction;
  reason?: string;
};
export type NodeQueueOperationResult = {
  operationID: string;
  queueVersion: number;
  paused: boolean;
  entry: NodeQueueEntry | null;
};

/** A candidate position is not an estimate of when execution will start. */
export function isNodeQueueCandidate(entry: NodeQueueEntry) {
  return (
    entry.state === 'waiting' &&
    (!entry.blockReason || ['queue', 'slot'].includes(entry.blockReason.code))
  );
}

export function firstNodeQueueCandidate(entries: readonly NodeQueueEntry[], source: NodeQueueSource['kind']) {
  return entries.find((entry) => entry.source.kind === source && isNodeQueueCandidate(entry));
}
