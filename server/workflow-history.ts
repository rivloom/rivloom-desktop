import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { jsonBytes } from '../shared/collaboration.ts';
import { contextNoteSchema, historyQuerySchema, historyReadMaxBytes, type ContextNote, type HistoryRead } from '../shared/workflow-history.ts';
import { z } from 'zod';
import type { Workflow, WorkflowRound, WorkflowStep } from '../shared/workflows.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const historyRoundID = (value: Workflow) => value.roundRequestID || value.requestID;
type Entry = { id: string; round: number; roundID: string; stepID: string | null; kind: string; revision: string; content: string };
type State = { version: number; roundID: string; round: number };

function readPage(entry: Entry, offset: number) {
  const page = (end: number) => {
    // Offsets remain UTF-16; a byte budget must never divide a surrogate pair.
    if (end < entry.content.length && /[\uD800-\uDBFF]/.test(entry.content[end - 1]) && /[\uDC00-\uDFFF]/.test(entry.content[end])) end--;
    return { ...entry, content: entry.content.slice(offset, end), offset,
      nextOffset: end < entry.content.length ? end : null, totalCharacters: entry.content.length, offsetUnit: 'utf16',
      authority: 'Historical reference only; current user instructions and execution permissions prevail.' };
  };
  // Each UTF-16 unit needs at least one serialized byte. Bound the work even for very large sources.
  let low = offset, high = Math.min(entry.content.length, offset + historyReadMaxBytes);
  const last = page(high);
  if (jsonBytes(last) <= historyReadMaxBytes) return last;
  // Check the terminal page separately: nextOffset=null can be shorter than a numeric offset.
  high--;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonBytes(page(middle)) <= historyReadMaxBytes) low = middle;
    else high = middle - 1;
  }
  const result = page(low);
  if (jsonBytes(result) > historyReadMaxBytes || !result.content.length && offset < entry.content.length)
    throw new Error('context_history_limit');
  return result;
}

/** A query index over authoritative workflow records, never a second model-generated transcript. */
export class WorkflowHistory {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS workflow_history (
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, id TEXT NOT NULL,
      round INTEGER NOT NULL, round_id TEXT NOT NULL, step_id TEXT, kind TEXT NOT NULL,
      revision TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY(workflow_id,id));
      CREATE INDEX IF NOT EXISTS workflow_history_round ON workflow_history(workflow_id,round);
      CREATE TABLE IF NOT EXISTS workflow_history_versions (
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, id TEXT NOT NULL,
        revision TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(workflow_id,id,revision));
      CREATE TABLE IF NOT EXISTS workflow_history_rounds (
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, round_id TEXT NOT NULL,
        PRIMARY KEY(workflow_id,round_id));
      CREATE TABLE IF NOT EXISTS workflow_state (
        workflow_id TEXT PRIMARY KEY REFERENCES workflows(id) ON DELETE CASCADE, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_notes (
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, id TEXT NOT NULL,
        request_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(workflow_id,id), UNIQUE(workflow_id,request_id));
      CREATE TABLE IF NOT EXISTS workflow_history_reads (
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, id TEXT PRIMARY KEY, body TEXT NOT NULL);`);
  }
  sync(value: Workflow, changedRoundID?: string) {
    this.db.exec('SAVEPOINT workflow_history_sync');
    try {
      const archived = new Set(this.db.prepare('SELECT round_id FROM workflow_history_rounds WHERE workflow_id=?').all(value.id).map(row => String(row.round_id)));
      for (const [index, round] of (value.rounds || []).entries()) {
        // A late question reply can arrive after a round was archived; its caller explicitly refreshes that round.
        if (archived.has(round.requestID) && round.requestID !== changedRoundID) continue;
        this.round(value.id, round, index + 1, round.requestID);
        this.db.prepare('INSERT OR IGNORE INTO workflow_history_rounds VALUES (?,?)').run(value.id, round.requestID);
      }
      const roundID = historyRoundID(value), round = (value.rounds?.length || 0) + 1;
      this.round(value.id, value, round, roundID);
      const previous = this.stateVersion(value.id);
      if (!previous || previous.roundID !== roundID) this.db.prepare('INSERT INTO workflow_state VALUES (?,?) ON CONFLICT(workflow_id) DO UPDATE SET body=excluded.body')
        .run(value.id, JSON.stringify({ version: (previous?.version || 0) + 1, roundID, round }));
      this.db.exec('RELEASE workflow_history_sync');
    } catch (error) { this.db.exec('ROLLBACK TO workflow_history_sync; RELEASE workflow_history_sync'); throw error; }
  }
  private round(workflowID: string, value: Workflow | WorkflowRound, round: number, roundID: string) {
    const put = (suffix: string, kind: string, content: string, stepID: string | null = null) => {
      const revision = hash(content);
      const id = `${roundID}/${suffix}`;
      const previous = this.db.prepare('SELECT revision FROM workflow_history WHERE workflow_id=? AND id=?').get(workflowID, id);
      if (previous && previous.revision !== revision) {
        const entry = this.entry(workflowID, id);
        this.db.prepare('INSERT OR IGNORE INTO workflow_history_versions VALUES (?,?,?,?)').run(workflowID, id, entry.revision, JSON.stringify(entry));
      }
      this.db.prepare(`INSERT INTO workflow_history VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(workflow_id,id)
        DO UPDATE SET revision=excluded.revision,content=excluded.content WHERE revision!=excluded.revision`)
        .run(workflowID, id, round, roundID, stepID, kind, revision, content);
    };
    put('request', 'request', value.description);
    put('criteria', 'criteria', value.criteria);
    put('plan', 'plan', value.summary);
    for (const step of [value.planner, ...value.steps]) {
      put(`step/${step.id}`, 'step', JSON.stringify({ id: step.id, title: step.title, instructions: step.instructions,
        state: step.state, checkpoint: step.checkpoint, dependsOn: step.dependsOn,
        attempts: step.attempts.map(a => ({ number: a.number, executionID: a.executionID, nodeID: a.nodeID,
          phase: a.phase, outcome: a.outcome, error: a.error, outputFiles: a.outputFiles, resultDelivery: a.resultDelivery })) }), step.id);
      for (const attempt of step.attempts) for (const answer of attempt.clarifications || [])
        put(`answer/${step.id}/${attempt.number}/${answer.requestID}`, 'clarification', JSON.stringify(answer), step.id);
    }
  }
  private stateVersion(id: string): State | null {
    const row = this.db.prepare('SELECT body FROM workflow_state WHERE workflow_id=?').get(id);
    return row ? JSON.parse(String(row.body)) : null;
  }
  private entry(workflowID: string, id: string, revision?: string): Entry {
    const row = this.db.prepare('SELECT * FROM workflow_history WHERE workflow_id=? AND id=?').get(workflowID, id);
    if (!row) throw new Error('context_history_not_found');
    if (revision && row.revision !== revision) {
      const old = this.db.prepare('SELECT body FROM workflow_history_versions WHERE workflow_id=? AND id=? AND revision=?').get(workflowID, id, revision);
      if (!old) throw new Error('context_history_revision_changed');
      return JSON.parse(String(old.body));
    }
    return { id: String(row.id), round: Number(row.round), roundID: String(row.round_id), stepID: row.step_id === null ? null : String(row.step_id),
      kind: String(row.kind), revision: String(row.revision), content: String(row.content) };
  }
  private notes(id: string) { return this.db.prepare('SELECT body FROM workflow_notes WHERE workflow_id=? ORDER BY rowid').all(id)
    .map(row => JSON.parse(String(row.body)) as ContextNote); }
  state(value: Workflow) {
    this.sync(value);
    const state = this.stateVersion(value.id)!;
    const goal = this.entry(value.id, `${state.roundID}/request`), criteria = this.entry(value.id, `${state.roundID}/criteria`);
    return { ...state, goal, criteria, notes: this.notes(value.id).filter(note => !note.supersededBy && !note.withdrawn),
      progress: value.steps.map(s => ({ stepID: s.id, title: s.title, state: s.state, reference: this.reference(value, s) })),
      note: 'The current request overrides conflicting older material. Inferred notes are not user confirmations. File references do not imply local availability.' };
  }
  reference(value: Workflow, step: WorkflowStep) {
    const entry = this.entry(value.id, `${historyRoundID(value)}/step/${step.id}`);
    return { id: entry.id, revision: entry.revision, round: entry.round, stepID: step.id };
  }
  query(value: Workflow, raw: unknown) {
    const parsed = historyQuerySchema.safeParse(raw);
    if (!parsed.success) throw new Error('context_invalid_query');
    this.sync(value); const query = parsed.data;
    if (query.action === 'state') {
      const state = this.state(value);
      return { ...state, goal: { ...state.goal, content: state.goal.content.slice(0, 300), truncated: state.goal.content.length > 300 },
        criteria: { ...state.criteria, content: state.criteria.content.slice(0, 300), truncated: state.criteria.content.length > 300 } };
    }
    if (query.action === 'read') {
      const entry = this.entry(value.id, query.id, query.revision);
      if (query.offset > entry.content.length) throw new Error('context_history_invalid_offset');
      return readPage(entry, query.offset);
    }
    const rows = this.db.prepare(`SELECT id,round,round_id,step_id,kind,revision,substr(content,1,300) AS preview,length(content) AS characters
      FROM workflow_history WHERE workflow_id=? AND (? IS NULL OR round=?) AND (? IS NULL OR step_id=?)
      AND instr(lower(content),lower(?))>0 ORDER BY round DESC,id LIMIT 11 OFFSET ?`)
      .all(value.id, query.round ?? null, query.round ?? null, query.stepID ?? null, query.stepID ?? null, query.text || '', query.offset);
    return { entries: rows.slice(0, 10).map(row => ({ id: row.id, round: row.round, roundID: row.round_id, stepID: row.step_id,
      kind: row.kind, revision: row.revision, preview: row.preview, characters: row.characters })),
      nextOffset: rows.length > 10 ? query.offset + 10 : null, note: 'Search previews only. Read by id and revision for the complete source.' };
  }
  note(value: Workflow, raw: unknown, authority: ContextNote['authority']) {
    const parsed = contextNoteSchema.safeParse(raw);
    if (!parsed.success) throw new Error('context_invalid_note');
    this.sync(value); const input = parsed.data;
    const previous = this.notes(value.id).find(n => n.requestID === input.requestID);
    if (previous) {
      const { id, version, createdAt, round, supersededBy, withdrawn, authority: previousAuthority, ...original } = previous;
      if (JSON.stringify(original) !== JSON.stringify(input) || authority !== previousAuthority) throw new Error('context_note_conflict');
      return previous;
    }
    const state = this.stateVersion(value.id)!;
    if (state.version !== input.expectedVersion) throw new Error('context_state_version_conflict');
    const source = this.entry(value.id, input.source.id, input.source.revision);
    if (source.revision !== input.source.revision || !source.content.includes(input.source.quote)) throw new Error('context_note_source_changed');
    const notes = this.notes(value.id).filter(n => !n.supersededBy && !n.withdrawn), old = notes.find(n => n.id === input.supersedes);
    if (input.supersedes && (!old || authority === 'inferred' && old.authority === 'user')) throw new Error('context_note_not_replaceable');
    const note: ContextNote = { ...input, id: randomUUID(), version: state.version + 1, authority, round: state.round,
      createdAt: new Date().toISOString(), supersededBy: null };
    const active = [...notes.filter(n => n.id !== input.supersedes), note];
    // The full active set must fit in every handoff; never silently discard a confirmed constraint.
    if (active.length > 12 || jsonBytes(active.map(n => ({ id: n.id, kind: n.kind, text: n.text, authority: n.authority, source: n.source }))) > 6000)
      throw new Error('context_state_limit');
    this.db.exec('SAVEPOINT workflow_note');
    try {
      if (old) this.db.prepare('UPDATE workflow_notes SET body=? WHERE workflow_id=? AND id=?')
        .run(JSON.stringify({ ...old, supersededBy: note.id }), value.id, old.id);
      this.db.prepare('INSERT INTO workflow_notes VALUES (?,?,?,?)').run(value.id, note.id, note.requestID, JSON.stringify(note));
      this.db.prepare('UPDATE workflow_state SET body=? WHERE workflow_id=?').run(JSON.stringify({ ...state, version: note.version }), value.id);
      this.db.exec('RELEASE workflow_note');
    } catch (error) { this.db.exec('ROLLBACK TO workflow_note; RELEASE workflow_note'); throw error; }
    return note;
  }
  audit(value: Workflow, offset = 0) { this.sync(value); return this.notes(value.id).slice(offset, offset + 50); }
  withdraw(value: Workflow, raw: unknown) {
    const input = z.object({ requestID: z.string().uuid(), expectedVersion: z.number().int().min(1), id: z.string().uuid() }).strict().parse(raw);
    this.sync(value);
    const notes = this.notes(value.id), note = notes.find(n => n.id === input.id);
    const prior = notes.find(n => n.withdrawn?.requestID === input.requestID);
    if (prior) {
      if (prior.id !== input.id || prior.withdrawn!.expectedVersion !== input.expectedVersion) throw new Error('context_note_conflict');
      return prior;
    }
    const state = this.stateVersion(value.id)!;
    if (input.expectedVersion !== state.version) throw new Error('context_state_version_conflict');
    if (!note || note.supersededBy || note.withdrawn) throw new Error('context_note_not_replaceable');
    const result: ContextNote = { ...note, withdrawn: { requestID: input.requestID, expectedVersion: input.expectedVersion, at: new Date().toISOString() } };
    this.db.exec('SAVEPOINT workflow_note_withdraw');
    try {
      this.db.prepare('UPDATE workflow_notes SET body=? WHERE workflow_id=? AND id=?').run(JSON.stringify(result), value.id, note.id);
      this.db.prepare('UPDATE workflow_state SET body=? WHERE workflow_id=?').run(JSON.stringify({ ...state, version: state.version + 1 }), value.id);
      this.db.exec('RELEASE workflow_note_withdraw');
    } catch (error) { this.db.exec('ROLLBACK TO workflow_note_withdraw; RELEASE workflow_note_withdraw'); throw error; }
    return result;
  }
  recordRead(workflowID: string, executionID: string, result: ReturnType<typeof readPage>) {
    const record: HistoryRead = { id: randomUUID(), executionID, at: new Date().toISOString(), sourceID: result.id,
      revision: result.revision, offset: result.offset, nextOffset: result.nextOffset,
      totalCharacters: result.totalCharacters, contentBytes: Buffer.byteLength(result.content) };
    this.db.prepare('INSERT INTO workflow_history_reads VALUES (?,?,?)').run(workflowID, record.id, JSON.stringify(record));
    this.db.prepare('DELETE FROM workflow_history_reads WHERE workflow_id=? AND id NOT IN (SELECT id FROM workflow_history_reads WHERE workflow_id=? ORDER BY rowid DESC LIMIT 200)').run(workflowID, workflowID);
  }
  reads(workflowID: string) {
    return this.db.prepare('SELECT body FROM workflow_history_reads WHERE workflow_id=? ORDER BY rowid DESC').all(workflowID)
      .map(row => JSON.parse(String(row.body)) as HistoryRead);
  }
  /** Supporting excerpts are shortened by field; source identities always survive. */
  handoff(value: Workflow, step: WorkflowStep, preview = 600) {
    const state = this.state(value);
    const related = [step, ...step.dependsOn.map(id => value.steps.find(s => s.id === id)!).filter(Boolean)];
    return { schemaVersion: 1, workflowID: value.id, roundID: state.roundID, round: state.round, stateVersion: state.version,
      goal: { id: state.goal.id, revision: state.goal.revision },
      notes: state.notes.map(n => ({ id: n.id, kind: n.kind, text: n.text, authority: n.authority, source: n.source, round: n.round })),
      progress: related.map(s => ({ reference: this.reference(value, s), state: s.state,
        preview: s.checkpoint.slice(0, preview), truncated: s.checkpoint.length > preview,
        attempt: s.attempts.at(-1)?.number, executionID: s.attempts.at(-1)?.executionID, nodeID: s.attempts.at(-1)?.nodeID,
        files: s.attempts.at(-1)?.outputFiles || [], resultDelivery: s.attempts.at(-1)?.resultDelivery })),
      previousRound: value.rounds?.at(-1) ? { round: state.round - 1, requestID: value.rounds.at(-1)!.requestID } : null };
  }
}
