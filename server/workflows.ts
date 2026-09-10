import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { uuid } from '../shared/collaboration.ts';
import { validWorkflowTarget, type Workflow, type WorkflowStep, type WorkflowStepPlan } from '../shared/workflows.ts';
import { validTaskFileDescriptor, type TaskFileDescriptor } from '../shared/task-files.ts';
import type { ApprovalMode } from '../shared/types.ts';
import { createHistorySchema, HistoryError } from './conversation-history.ts';

export type WorkflowRequest = {
  requestID: string; creatorID: string; title: string; description: string; projectID: string | null;
  model: string | null; approvalMode: ApprovalMode; target: Workflow['target']; inputFiles: TaskFileDescriptor[]; criteria?: string;
};
export function workflowStep(plan: WorkflowStepPlan): WorkflowStep {
  return { ...structuredClone(plan), state: plan.dependsOn.length ? 'waiting' : 'ready', attempts: [], checkpoint: '',
    queryRounds: 0, materials: [], evidence: '', continuation: null };
}
export function workflowEvent(value: Workflow, kind: Workflow['events'][number]['kind'], text: string, stepID: string | null = null) {
  value.events.push({ id: (value.events.at(-1)?.id || 0) + 1, kind, text: text.slice(0, 2000), stepID, at: new Date().toISOString() });
  if (value.events.length > 500) value.events.splice(0, value.events.length - 500);
}
/** Logical workflow persistence is independent of the execution engine and network delivery. */
export class WorkflowStore {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    createHistorySchema(db);
    db.exec(`CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, request_id TEXT NOT NULL, version INTEGER NOT NULL,
      body TEXT NOT NULL, UNIQUE(creator_id,request_id));`);
  }
  get(id: string): Workflow | null {
    const row = this.db.prepare('SELECT body FROM workflows WHERE id=?').get(id);
    return row ? JSON.parse(String(row.body)) : null;
  }
  list(creatorID?: string): Workflow[] {
    const rows = creatorID === undefined ? this.db.prepare('SELECT body FROM workflows ORDER BY rowid DESC').all() :
      this.db.prepare('SELECT body FROM workflows WHERE creator_id=? ORDER BY rowid DESC').all(creatorID);
    return rows.map((row) => JSON.parse(String(row.body)));
  }
  create(request: WorkflowRequest): Workflow {
    if (this.db.prepare("SELECT 1 FROM conversation_retired WHERE kind='requests' AND id=?").get(`${request.creatorID}:${request.requestID}`))
      throw new HistoryError(410, '此会话已移入回收站或已永久删除。');
    if (!uuid(request.requestID) || !request.creatorID || !request.title.trim() || request.title.length > 160 ||
      !request.description.trim() || request.description.length > 12_000 || !validWorkflowTarget(request.target) ||
      (request.criteria !== undefined && (typeof request.criteria !== 'string' || request.criteria.length > 4000)) ||
      !['ask', 'auto', 'full'].includes(request.approvalMode) || request.inputFiles.length > 10 ||
      !request.inputFiles.every(validTaskFileDescriptor)) throw new Error('invalid_workflow_request');
    // Explicit field order and normalized descriptors make retries independent of JSON key ordering.
    const contentDigest = createHash('sha256').update(JSON.stringify([
      request.title, request.description, request.criteria || '', request.projectID, request.model, request.approvalMode,
      request.target.mode, request.target.mode === 'automatic' ? null : request.target.nodeID,
      request.inputFiles.map((f) => [f.id, f.name, f.bytes, f.sha256, f.mime]),
    ])).digest('hex');
    const previous = this.db.prepare('SELECT body FROM workflows WHERE creator_id=? AND request_id=?').get(request.creatorID, request.requestID);
    if (previous) {
      const value = JSON.parse(String(previous.body)) as Workflow;
      if (value.contentDigest !== contentDigest) throw new Error('workflow_request_conflict');
      return value;
    }
    const at = new Date().toISOString();
    const value: Workflow = {
      ...structuredClone(request), criteria: request.criteria || '', id: randomUUID(), contentDigest, state: 'planning', version: 1, planVersion: 0,
      summary: '', planner: workflowStep({ id: 'planner', title: request.title, instructions: request.description + (request.criteria ? `\n\n完成要求：\n${request.criteria}` : ''),
        dependsOn: [], nodeID: null, resources: [], software: [], requirements: {} }),
      steps: [], events: [], handoffs: [], confirmations: [], pendingConfirmation: null,
      createdAt: at, updatedAt: at, error: null,
    };
    this.db.prepare('INSERT INTO workflows VALUES (?,?,?,?,?)').run(value.id, value.creatorID, value.requestID, value.version, JSON.stringify(value));
    return value;
  }
  /** Every mutation reads the latest value; an optional version fences stale UI edits. */
  update(id: string, mutate: (value: Workflow) => void, expectedVersion?: number): Workflow {
    if (this.db.prepare("SELECT 1 FROM conversation_retired WHERE kind='workflow' AND id=?").get(id))
      throw new HistoryError(410, '此会话已移入回收站或已永久删除。');
    const value = this.get(id);
    if (!value) throw new Error('workflow_not_found');
    if (expectedVersion !== undefined && value.version !== expectedVersion) throw new Error('workflow_version_conflict');
    const previousVersion = value.version;
    mutate(value); value.version++; value.updatedAt = new Date().toISOString();
    const result = this.db.prepare('UPDATE workflows SET version=?,body=? WHERE id=? AND version=?')
      .run(value.version, JSON.stringify(value), id, previousVersion);
    if (result.changes !== 1) throw new Error('workflow_version_conflict');
    return value;
  }
}
