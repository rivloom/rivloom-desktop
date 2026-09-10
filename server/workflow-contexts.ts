import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { integer, keys, record, uuid } from '../shared/collaboration.ts';
import { sameTaskFile, validTaskFileManifest, type TaskFileDescriptor } from '../shared/task-files.ts';
import { validWorkflowExecutionContext, type WorkflowExecutionContext } from '../shared/workflows.ts';
import type { RemoteTaskInvite } from '../shared/types.ts';

export type WorkflowContextRecord = { executionID: string; ownerNodeID: string; digest: string; context: WorkflowExecutionContext;
  inputFiles: TaskFileDescriptor[]; localTaskID: string | null; createdAt: string };
export function workflowContextDigest(context: WorkflowExecutionContext, inputFiles: TaskFileDescriptor[]) {
  return createHash('sha256').update(JSON.stringify([context.workflowID, context.stepID, context.attempt, context.role,
    context.target.mode, context.target.mode === 'automatic' ? null : context.target.nodeID,
    context.instructions, context.evidence, context.priorContext,
    inputFiles.map((f) => [f.id, f.name, f.bytes, f.sha256, f.mime])])).digest('hex');
}
/** Authenticated metadata is staged before the ordinary offer. Metadata alone can never create a Task. */
export class WorkflowContexts {
  private db: DatabaseSync;
  private ownNode: () => string | null;
  private remote: (id: string) => RemoteTaskInvite | null;
  constructor(db: DatabaseSync, ownNode: () => string | null, remote: (id: string) => RemoteTaskInvite | null) {
    this.db = db; this.ownNode = ownNode; this.remote = remote;
    db.exec('CREATE TABLE IF NOT EXISTS workflow_contexts (execution_id TEXT PRIMARY KEY, owner_node_id TEXT NOT NULL, body TEXT NOT NULL)');
  }
  get(executionID: string): WorkflowContextRecord | null {
    const row = this.db.prepare('SELECT body FROM workflow_contexts WHERE execution_id=?').get(executionID);
    return row ? JSON.parse(String(row.body)) : null;
  }
  receive(peer: string, payload: unknown) {
    if (!record(payload) || !keys(payload, ['executionID', 'context', 'inputFiles']) || !uuid(payload.executionID) ||
      !validWorkflowExecutionContext(payload.context) || !validTaskFileManifest(payload.inputFiles)) throw new Error('workflow_invalid_metadata');
    if (payload.context.target.mode === 'locked' && payload.context.target.nodeID !== this.ownNode()) throw new Error('workflow_locked_target');
    const digest = workflowContextDigest(payload.context, payload.inputFiles); const previous = this.get(payload.executionID);
    if (previous) {
      if (previous.ownerNodeID !== peer || previous.digest !== digest) throw new Error('workflow_metadata_conflict');
      return { executionID: previous.executionID, digest: previous.digest };
    }
    // A preexisting offer without this context belongs to another creation. Never retrofit execution authority.
    if (this.remote(payload.executionID)) throw new Error('workflow_execution_already_exists');
    const pending = this.db.prepare("SELECT COUNT(*) AS count FROM workflow_contexts WHERE owner_node_id=? AND json_extract(body,'$.localTaskID') IS NULL").get(peer)!;
    if (!integer(Number(pending.count), 127)) throw new Error('workflow_metadata_quota');
    const value: WorkflowContextRecord = { executionID: payload.executionID, ownerNodeID: peer, digest, context: payload.context,
      inputFiles: payload.inputFiles, localTaskID: null, createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO workflow_contexts VALUES (?,?,?)').run(value.executionID, peer, JSON.stringify(value));
    return { executionID: value.executionID, digest };
  }
  bind(remote: RemoteTaskInvite, localTaskID: string): WorkflowExecutionContext | null {
    const value = this.get(remote.id); if (!value) return null;
    if (remote.direction !== 'incoming' || value.ownerNodeID !== remote.ownerNodeID || remote.targetNodeID !== this.ownNode() ||
      value.localTaskID !== null && value.localTaskID !== localTaskID || value.inputFiles.length !== (remote.inputFiles || []).length ||
      !value.inputFiles.every((file, i) => sameTaskFile(file, remote.inputFiles![i]))) throw new Error('workflow_metadata_binding_conflict');
    if (value.context.target.mode === 'locked' && value.context.target.nodeID !== this.ownNode()) throw new Error('workflow_locked_target');
    value.localTaskID = localTaskID;
    this.db.prepare('UPDATE workflow_contexts SET body=? WHERE execution_id=?').run(JSON.stringify(value), remote.id);
    return value.context;
  }
  owned(peer: string, payload: unknown): WorkflowContextRecord {
    if (!record(payload) || !keys(payload, ['executionID', 'digest']) || !uuid(payload.executionID)) throw new Error('workflow_invalid_outcome_request');
    const value = this.get(payload.executionID);
    if (!value || value.ownerNodeID !== peer || value.digest !== payload.digest) throw new Error('workflow_outcome_not_authorized');
    return value;
  }
}
