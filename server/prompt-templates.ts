import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { maximumPromptTemplates, validPromptTemplateInput, type PromptTemplate, type PromptTemplateErrorCode, type PromptTemplateInput } from '../shared/prompt-templates.ts';

export class PromptTemplateError extends Error {
  readonly status: number;
  readonly code: PromptTemplateErrorCode;
  constructor(code: PromptTemplateErrorCode) {
    super(code); this.name = 'PromptTemplateError';
    this.code = code;
    this.status = code === 'prompt_template_invalid' ? 400 : code === 'prompt_template_missing' ? 404 : 409;
  }
}
const invalid = () => { throw new PromptTemplateError('prompt_template_invalid'); };
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const identity = (userID: string, id?: string) => { if (typeof userID !== 'string' || !userID.trim() || (id !== undefined && !uuid(id))) invalid(); };
const version = (revision: number) => { if (!Number.isSafeInteger(revision) || revision < 1) invalid(); };
function input(value: PromptTemplateInput) { if (!validPromptTemplateInput(value)) invalid(); return { title: value.title.trim(), text: value.text }; }

/** Only an injected database is used. Importing this module never opens application data. */
export class PromptTemplateStore {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  constructor(db: DatabaseSync, now: () => string = () => new Date().toISOString()) {
    this.db = db; this.now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS prompt_templates (
      user_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL,
      revision INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id,id))`);
  }
  private read(row: Record<string, unknown>): PromptTemplate {
    return { id: String(row.id), title: String(row.title), text: String(row.text), revision: Number(row.revision), updatedAt: String(row.updated_at) };
  }
  list(userID: string): PromptTemplate[] {
    identity(userID);
    return this.db.prepare('SELECT id,title,text,revision,updated_at FROM prompt_templates WHERE user_id=? ORDER BY updated_at DESC,id').all(userID).map(row => this.read(row));
  }
  get(userID: string, id: string): PromptTemplate {
    identity(userID, id);
    const row = this.db.prepare('SELECT id,title,text,revision,updated_at FROM prompt_templates WHERE user_id=? AND id=?').get(userID, id);
    if (!row) throw new PromptTemplateError('prompt_template_missing');
    return this.read(row);
  }
  create(userID: string, value: PromptTemplateInput, id: string = randomUUID()): PromptTemplate {
    identity(userID, id); const normalized = input(value);
    // One statement enforces the per-user limit even across database connections.
    const result = this.db.prepare(`INSERT INTO prompt_templates(user_id,id,title,text,revision,updated_at)
      SELECT ?,?,?,?,1,? WHERE (SELECT COUNT(*) FROM prompt_templates WHERE user_id=?) < ?
      ON CONFLICT(user_id,id) DO NOTHING`).run(userID, id, normalized.title, normalized.text, this.now(), userID, maximumPromptTemplates);
    if (!result.changes) {
      const existing = this.db.prepare('SELECT id,title,text,revision,updated_at FROM prompt_templates WHERE user_id=? AND id=?').get(userID, id);
      if (!existing) throw new PromptTemplateError('prompt_template_limit');
      if (existing.title !== normalized.title || existing.text !== normalized.text) throw new PromptTemplateError('prompt_template_conflict');
      return this.read(existing); // A lost creation response can be retried with the same ID.
    }
    return this.get(userID, id);
  }
  update(userID: string, id: string, revision: number, value: PromptTemplateInput): PromptTemplate {
    identity(userID, id); version(revision); const normalized = input(value);
    const result = this.db.prepare('UPDATE prompt_templates SET title=?,text=?,revision=revision+1,updated_at=? WHERE user_id=? AND id=? AND revision=?')
      .run(normalized.title, normalized.text, this.now(), userID, id, revision);
    if (!result.changes) { this.get(userID, id); throw new PromptTemplateError('prompt_template_conflict'); }
    return this.get(userID, id);
  }
  delete(userID: string, id: string, revision: number): void {
    identity(userID, id); version(revision);
    const result = this.db.prepare('DELETE FROM prompt_templates WHERE user_id=? AND id=? AND revision=?').run(userID, id, revision);
    if (!result.changes) { this.get(userID, id); throw new PromptTemplateError('prompt_template_conflict'); }
  }
}
