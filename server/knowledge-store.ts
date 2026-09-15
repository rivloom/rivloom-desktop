import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { lstat, readdir, open } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { knowledgeLimits, knowledgePath, knowledgeID, memoryInputSchema, safeKnowledgePath,
  type LocalKnowledgeEntry, type KnowledgeManifest, type KnowledgeFile, type KnowledgeListing,
  type MemoryInput, type MemoryOrganization } from '../shared/knowledge.ts';

export const knowledgeHash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type Stored = LocalKnowledgeEntry & { files: KnowledgeFile[]; body: string | null; origin: string };
const secret = /(^|[._-])(auth|credentials?|secrets?|tokens?)([._-]|$)|\.(pem|key|p12|pfx|kdbx|sqlite|db|log)$/i;
const excluded = new Set(['node_modules', 'vendor', 'target', 'dist', '__pycache__', 'opencode.json', 'opencode.jsonc']);
function permittedFile(path: string) {
  return safeKnowledgePath(path) && path.split('/').every((part) => !part.startsWith('.') && !secret.test(part) && !excluded.has(part.toLowerCase()));
}
export function safeKnowledgeDirectory(directory: string) {
  const full = resolve(directory);
  let current = full;
  while (true) {
    const info = lstatSync(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('knowledge_unsafe_directory');
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  return realpathSync(full);
}
export async function readKnowledgeFile(root: string, path: string) {
  if (!safeKnowledgePath(path)) throw new Error('knowledge_unsafe_path');
  const canonical = safeKnowledgeDirectory(root);
  const file = join(canonical, ...path.split('/'));
  const parent = safeKnowledgeDirectory(dirname(file));
  const rel = relative(canonical, parent);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(canonical, rel) !== parent) throw new Error('knowledge_unsafe_path');
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > knowledgeLimits.fileBytes) throw new Error('knowledge_unsafe_file');
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) throw new Error('knowledge_source_changed');
    const buffer = Buffer.alloc(stat.size); let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!result.bytesRead) throw new Error('knowledge_source_changed'); offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || (await lstat(file)).isSymbolicLink()) throw new Error('knowledge_source_changed');
    safeKnowledgeDirectory(dirname(file));
    return buffer;
  } finally { await handle.close(); }
}
function skillHeader(body: string, fallback: string) {
  const block = body.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!block) throw new Error('knowledge_skill_frontmatter_required');
  const value = (key: string) => {
    const raw = block.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))?.[1]?.trim() || '';
    if (/^[>|][+-]?$/.test(raw)) return block.match(new RegExp(`^${key}:.*\\r?\\n((?:[ \\t]+.*(?:\\r?\\n|$))+)`, 'm'))?.[1]?.trim().replace(/\s+/g, ' ') || '';
    return raw.replace(/^(['"])([\s\S]*)\1$/, '$2');
  };
  const name = value('name') || fallback; const description = value('description');
  if (!name || name.length > 120 || !description || description.length > 600) throw new Error('knowledge_skill_metadata_invalid');
  return { name, description };
}
function atomicText(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true }); safeKnowledgeDirectory(dirname(path));
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('knowledge_unsafe_path');
  const temp = `${path}.${randomUUID()}.tmp`; writeFileSync(temp, text, { flag: 'wx', mode: 0o600 }); renameSync(temp, path);
}
export class KnowledgeStore {
  readonly root: string;
  readonly nodeID: string;
  private db: DatabaseSync;
  private refreshes = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private onChange: () => void;
  constructor(root: string, nodeID: string, onChange = () => {}) {
    this.root = join(root, 'knowledge'); this.nodeID = nodeID; this.onChange = onChange;
    mkdirSync(this.root, { recursive: true }); safeKnowledgeDirectory(this.root);
    this.db = new DatabaseSync(join(this.root, 'library.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS entries(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS versions(id TEXT NOT NULL,revision TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,body TEXT NOT NULL);`);
  }
  private all(): Stored[] { return this.db.prepare('SELECT body FROM entries ORDER BY id').all().map((row) => JSON.parse(String(row.body))); }
  private get(id: string): Stored {
    const row = this.db.prepare('SELECT body FROM entries WHERE id=?').get(knowledgeID.parse(id));
    if (!row) throw new Error('knowledge_not_found'); return JSON.parse(String(row.body));
  }
  private meta(value: Stored) {
    const { id, nodeID, kind, name, description, category, revision, updatedAt } = value;
    return { id, nodeID, kind, name, description, category, revision, updatedAt };
  }
  private local(value: Stored): LocalKnowledgeEntry {
    return { ...this.meta(value), projectID: value.projectID, sharedBrains: value.sharedBrains, source: value.source, error: value.error };
  }
  private persist(value: Stored, history = false) {
    if (this.closed) throw new Error('knowledge_closed');
    if (!this.db.prepare('SELECT id FROM entries WHERE id=?').get(value.id) && this.all().length >= knowledgeLimits.entries) throw new Error('knowledge_catalog_full');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO entries VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(value.id, JSON.stringify(value));
      if (history) this.db.prepare('INSERT OR IGNORE INTO versions VALUES (?,?,?)').run(value.id, value.revision, JSON.stringify(value));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.onChange(); this.scheduleOrganization();
  }
  listLocal(projectID?: string | null) {
    return this.all().filter((v) => projectID === undefined || v.projectID === null || v.projectID === projectID).map((v) => this.local(v));
  }
  localEntry(id: string) { return this.local(this.get(id)); }
  listShared(brainID: string, offset = 0, generation?: string): KnowledgeListing {
    knowledgeID.parse(brainID);
    const all = this.all().filter((v) => v.sharedBrains.includes(brainID) && !v.error).map((v) => this.meta(v));
    const current = knowledgeHash(JSON.stringify(all));
    if (generation && generation !== current) throw new Error('knowledge_catalog_changed');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > all.length) throw new Error('knowledge_invalid_offset');
    return { entries: all.slice(offset, offset + knowledgeLimits.page),
      next: offset + knowledgeLimits.page < all.length ? offset + knowledgeLimits.page : null, generation: current };
  }
  share(id: string, brains: string[], expectedRevision: string, expectedUpdatedAt?: string) {
    if (!Array.isArray(brains) || brains.length > 32 || new Set(brains).size !== brains.length) throw new Error('knowledge_invalid_sharing');
    brains.forEach((b) => knowledgeID.parse(b)); const value = this.get(id);
    if (value.revision !== expectedRevision || expectedUpdatedAt && value.updatedAt !== expectedUpdatedAt) throw new Error('knowledge_revision_conflict');
    value.sharedBrains = [...brains].sort(); value.updatedAt = new Date(Math.max(Date.now(), Date.parse(value.updatedAt) + 1)).toISOString(); this.persist(value); return this.local(value);
  }
  shareMany(entries: { id: string; revision: string; updatedAt: string }[], brains: string[]) {
    if (!entries.length || entries.length > knowledgeLimits.entries || new Set(entries.map((v) => v.id)).size !== entries.length ||
      brains.length > 32 || new Set(brains).size !== brains.length) throw new Error('knowledge_invalid_sharing');
    brains.forEach((id) => knowledgeID.parse(id));
    const values = entries.map((input) => {
      const value = this.get(input.id);
      if (value.revision !== input.revision || value.updatedAt !== input.updatedAt) throw new Error('knowledge_revision_conflict');
      return { ...value, sharedBrains: [...brains].sort(), updatedAt: new Date(Math.max(Date.now(), Date.parse(value.updatedAt) + 1)).toISOString() };
    });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const value of values) this.db.prepare('UPDATE entries SET body=? WHERE id=?').run(JSON.stringify(value), value.id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.onChange(); return values.map((v) => this.local(v));
  }
  saveMemory(raw: MemoryInput, origin: string) {
    const input = memoryInputSchema.parse(raw); const previous = input.id ? this.get(input.id) : null;
    if (previous && (previous.kind !== 'memory' || previous.revision !== input.expectedRevision)) throw new Error('knowledge_revision_conflict');
    const bytes = Buffer.from(input.body, 'utf8');
    const files = [{ path: 'MEMORY.md', bytes: bytes.length, sha256: knowledgeHash(bytes) }];
    const revision = knowledgeHash(JSON.stringify([input.name, input.description, input.category, input.projectID, files]));
    const value: Stored = { id: input.id || randomUUID(), nodeID: this.nodeID, kind: 'memory', name: input.name,
      description: input.description, category: input.category, projectID: input.projectID, body: input.body,
      files, revision, source: 'wiki', origin, updatedAt: new Date().toISOString(), sharedBrains: previous?.sharedBrains || [], error: null };
    this.persist(value, true); return this.local(value);
  }
  history(id: string) {
    this.get(id);
    return this.db.prepare('SELECT body FROM versions WHERE id=? ORDER BY rowid DESC').all(id).map((row) => {
      const value: Stored = JSON.parse(String(row.body)); return { ...this.meta(value), body: value.body, origin: value.origin };
    });
  }
  remove(id: string, revision: string) {
    const value = this.get(id); if (value.revision !== revision) throw new Error('knowledge_revision_conflict');
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.prepare('DELETE FROM entries WHERE id=?').run(id); this.db.prepare('DELETE FROM versions WHERE id=?').run(id); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.onChange(); this.scheduleOrganization();
  }
  async registerSkill(directory: string, projectID: string | null) {
    const source = safeKnowledgeDirectory(directory);
    if (projectID !== null) knowledgeID.parse(projectID);
    const existing = this.all().find((v) => v.kind === 'skill' && v.source.toLowerCase() === source.toLowerCase());
    if (existing) { await this.refresh(existing.id); return this.local(this.get(existing.id)); }
    const files = await this.scan(source);
    const header = skillHeader((await readKnowledgeFile(source, 'SKILL.md')).toString('utf8'), 'Skill');
    const value: Stored = { id: randomUUID(), nodeID: this.nodeID, kind: 'skill', ...header, category: 'Skills',
      projectID, source, origin: 'registered-folder', files, body: null, sharedBrains: [], error: null,
      updatedAt: new Date().toISOString(), revision: knowledgeHash(JSON.stringify([header, files])) };
    this.persist(value); return this.local(value);
  }
  private async scan(root: string) {
    const files: KnowledgeFile[] = []; let bytes = 0;
    const visit = async (directory: string, prefix: string, depth: number) => {
      if (depth > 12) throw new Error('knowledge_skill_too_deep');
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = prefix + entry.name; if (!permittedFile(path)) continue;
        const info = await lstat(join(directory, entry.name));
        if (info.isSymbolicLink()) throw new Error('knowledge_unsafe_file');
        if (info.isDirectory()) { await visit(join(directory, entry.name), `${path}/`, depth + 1); continue; }
        if (!info.isFile()) throw new Error('knowledge_unsafe_file');
        if (files.length >= knowledgeLimits.files || info.size > knowledgeLimits.fileBytes || bytes + info.size > knowledgeLimits.bundleBytes) throw new Error('knowledge_skill_too_large');
        const body = await readKnowledgeFile(root, path); bytes += body.length;
        files.push({ path, bytes: body.length, sha256: knowledgeHash(body) });
      }
    };
    await visit(root, '', 0); files.sort((a, b) => a.path.localeCompare(b.path));
    if (!files.some((f) => f.path === 'SKILL.md') || new Set(files.map((f) => f.path.toLowerCase())).size !== files.length) throw new Error('knowledge_skill_manifest_invalid');
    return files;
  }
  async refresh(id: string) {
    const pending = this.refreshes.get(id); if (pending) return pending;
    const operation = (async () => {
      const before = this.get(id); if (before.kind !== 'skill') return;
      try {
        const files = await this.scan(before.source);
        const header = skillHeader((await readKnowledgeFile(before.source, 'SKILL.md')).toString('utf8'), before.name);
        const current = this.get(id); // Do not overwrite a concurrent share or removal.
        const revision = knowledgeHash(JSON.stringify([header, files]));
        if (revision !== current.revision || current.error) this.persist({ ...current, ...header, files, revision, error: null, updatedAt: new Date().toISOString() });
      } catch (error) {
        if (!this.closed) {
          try { const current = this.get(id); if (!current.error) this.persist({ ...current, error: 'knowledge_source_unavailable' }); } catch { /* removed */ }
        }
        throw error;
      }
    })().finally(() => this.refreshes.delete(id));
    this.refreshes.set(id, operation); return operation;
  }
  async refreshAll() { for (const value of this.all()) if (value.kind === 'skill') await this.refresh(value.id).catch(() => undefined); }
  manifest(id: string, brainID?: string): KnowledgeManifest {
    const value = this.get(id);
    if (brainID && !value.sharedBrains.includes(brainID)) throw new Error('knowledge_not_shared');
    if (value.error) throw new Error(value.error);
    return { entry: this.meta(value), files: value.files };
  }
  async refreshManifest(id: string, brainID?: string) {
    // Check a grant even when the source has an error; refresh is allowed to recover it.
    if (brainID && !this.get(id).sharedBrains.includes(brainID)) throw new Error('knowledge_not_shared');
    await this.refresh(id); return this.manifest(id, brainID);
  }
  async chunk(id: string, revision: string, path: string, offset: number, brainID?: string) {
    knowledgePath.parse(path);
    // Scan the bundle at download start; each chunk checks its own bytes and grant.
    // The receiver refreshes the manifest again after the final chunk.
    const manifest = offset === 0 ? await this.refreshManifest(id, brainID) : this.manifest(id, brainID);
    if (manifest.entry.revision !== revision) throw new Error('knowledge_revision_changed');
    const file = manifest.files.find((f) => f.path === path); if (!file) throw new Error('knowledge_file_not_found');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.bytes) throw new Error('knowledge_invalid_offset');
    const value = this.get(id);
    const bytes = value.kind === 'memory' ? Buffer.from(value.body!, 'utf8') : await readKnowledgeFile(value.source, path);
    const latest = this.manifest(id, brainID);
    if (latest.entry.revision !== revision || bytes.length !== file.bytes || knowledgeHash(bytes) !== file.sha256) throw new Error('knowledge_revision_changed');
    const end = Math.min(bytes.length, offset + knowledgeLimits.chunkBytes);
    return { id, revision, path, offset, data: bytes.subarray(offset, end).toString('base64'), next: end < bytes.length ? end : null };
  }
  readMemory(id: string) { const v = this.get(id); if (v.kind !== 'memory') throw new Error('knowledge_not_memory'); return { ...this.local(v), body: v.body!, origin: v.origin }; }
  rules(directory?: string) {
    const root = directory ? safeKnowledgeDirectory(directory) : this.root;
    const filename = directory && !existsSync(join(root, 'AGENTS.md')) && existsSync(join(root, 'agent.md')) ? 'agent.md' : 'AGENTS.md';
    const path = join(root, filename);
    if (!existsSync(path)) return { body: '', revision: knowledgeHash(''), path };
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > knowledgeLimits.rulesChars * 4) throw new Error('knowledge_rules_invalid');
    const body = readFileSync(path, 'utf8'); if (body.length > knowledgeLimits.rulesChars) throw new Error('knowledge_rules_too_large');
    return { body, revision: knowledgeHash(body), path };
  }
  saveRules(body: string, expectedRevision: string, directory?: string) {
    if (typeof body !== 'string' || body.length > knowledgeLimits.rulesChars || body.includes('\0')) throw new Error('knowledge_rules_invalid');
    const current = this.rules(directory); if (current.revision !== expectedRevision) throw new Error('knowledge_revision_conflict');
    atomicText(current.path, body); this.onChange(); return this.rules(directory);
  }
  scheduleOrganization() {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => { this.timer = null; if (!this.closed) { try { this.organize(); } catch { /* retry on next change/manual organize */ } } }, 60_000);
    this.timer.unref();
  }
  organization(): MemoryOrganization | null {
    const row = this.db.prepare("SELECT body FROM settings WHERE key='organization'").get(); return row ? JSON.parse(String(row.body)) : null;
  }
  organize(): MemoryOrganization {
    const entries = this.all().filter((v) => v.kind === 'memory'); const categories = new Map<string, Stored[]>();
    const duplicates = new Map<string, string[]>();
    for (const entry of entries) {
      const list = categories.get(entry.category) || []; list.push(entry); categories.set(entry.category, list);
      const key = knowledgeHash(JSON.stringify([entry.projectID, entry.body?.trim()]));
      const group = duplicates.get(key) || []; group.push(entry.id); duplicates.set(key, group);
    }
    // Rebuild navigation only. Originals and all revisions remain in SQLite; no body is silently merged/deleted.
    const lines = ['# Wiki', '', ...[...categories].sort(([a], [b]) => a.localeCompare(b)).flatMap(([category, values]) =>
      [`## ${category.replace(/[\r\n]/g, ' ')}`, ...values.map((v) => `- ${v.name.replace(/[\r\n]/g, ' ')} (${v.id}) — ${v.description.replace(/[\r\n]/g, ' ')}`), ''])];
    atomicText(join(this.root, 'wiki', 'INDEX.md'), lines.join('\n'));
    const report = { at: new Date().toISOString(), entries: entries.length, categories: categories.size,
      duplicates: [...duplicates.values()].filter((v) => v.length > 1) };
    this.db.prepare("INSERT INTO settings VALUES ('organization',?) ON CONFLICT(key) DO UPDATE SET body=excluded.body").run(JSON.stringify(report));
    this.onChange(); return report;
  }
  close() { this.closed = true; if (this.timer) clearTimeout(this.timer); this.db.close(); }
}
