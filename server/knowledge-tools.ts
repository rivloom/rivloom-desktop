import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { knowledgeLimits, knowledgeRefSchema, knowledgePath, memoryInputSchema,
  type KnowledgeManifest, type KnowledgeRef } from '../shared/knowledge.ts';
import { KnowledgeStore, knowledgeHash, safeKnowledgeDirectory } from './knowledge-store.ts';
import { KnowledgeNetwork } from './knowledge-network.ts';

export type KnowledgeTask = { id: string; sessionID: string; directory: string; projectID: string;
  privateLocal: boolean; brainIDs: string[]; canWriteMemory: boolean };
const searchSchema = z.object({ text: z.string().max(200).optional(), kind: z.enum(['skill', 'memory']).optional(),
  category: z.string().max(240).optional(), brainID: z.string().uuid().nullable().optional(),
  offset: z.number().int().min(0).max(knowledgeLimits.entries).optional() }).strict();
const readSchema = knowledgeRefSchema.extend({ file: knowledgePath.optional(), materialize: z.boolean().optional() }).strict();
export class KnowledgeTools {
  private store: KnowledgeStore;
  private network: KnowledgeNetwork;
  private authorize: (sessionID: string, directory: string) => KnowledgeTask;
  private db: DatabaseSync;
  private pending = new Set<string>();
  constructor(store: KnowledgeStore, network: KnowledgeNetwork, authorize: (sessionID: string, directory: string) => KnowledgeTask) {
    this.store = store; this.network = network; this.authorize = authorize;
    this.db = new DatabaseSync(join(store.root, 'tool-state.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS pins(task TEXT NOT NULL,reference TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(task,reference));');
  }
  private check(task: KnowledgeTask, ref: KnowledgeRef) {
    const current = this.authorize(task.sessionID, task.directory);
    if (current.id !== task.id || current.projectID !== task.projectID) throw new Error('knowledge_task_changed');
    if (ref.brainID === null) {
      if (!current.privateLocal || ref.nodeID !== this.store.nodeID) throw new Error('knowledge_not_authorized');
      const entry = this.store.localEntry(ref.id);
      if (entry.projectID !== null && entry.projectID !== current.projectID) throw new Error('knowledge_wrong_project');
    } else if (!current.brainIDs.includes(ref.brainID)) throw new Error('knowledge_not_authorized');
    return current;
  }
  async call(sessionID: string, directory: string, name: string, raw: unknown) {
    const task = this.authorize(sessionID, directory);
    if (this.pending.has(task.id)) throw new Error('knowledge_task_busy');
    this.pending.add(task.id);
    try {
      if (name === 'rivloom_knowledge_search') {
        const args = searchSchema.parse(raw);
        if (args.brainID && !task.brainIDs.includes(args.brainID)) throw new Error('knowledge_not_authorized');
        const result = await this.network.search({ ...args, projectID: task.projectID, privateLocal: task.privateLocal, allowedBrainIDs: task.brainIDs });
        const current = this.authorize(sessionID, directory);
        return { ...result, entries: result.entries.filter((v) => v.brainID === null ? current.privateLocal : current.brainIDs.includes(v.brainID)),
          note: 'Descriptions only. Read a matching entry by exact brainID, nodeID and id; browse narrower categories or the next offset as needed.' };
      }
      if (name === 'rivloom_knowledge_read') return await this.read(task, readSchema.parse(raw));
      if (name === 'rivloom_memory_save') {
        const input = memoryInputSchema.parse(raw);
        const current = this.authorize(sessionID, directory);
        if (!current.canWriteMemory || input.projectID !== current.projectID && (input.projectID !== null || !current.privateLocal)) throw new Error('knowledge_memory_write_denied');
        if (input.id) {
          this.check(task, { brainID: null, nodeID: this.store.nodeID, id: input.id });
          const key = JSON.stringify({ brainID: null, nodeID: this.store.nodeID, id: input.id });
          if (!this.db.prepare('SELECT body FROM pins WHERE task=? AND reference=?').get(task.id, key)) throw new Error('knowledge_read_before_edit');
        }
        const saved = this.store.saveMemory(input, `task:${task.id}`);
        // A successful write advances this task's own memory pin; unrelated source updates never do.
        const ref = { brainID: null, nodeID: this.store.nodeID, id: saved.id };
        this.pin(task.id, ref, this.store.manifest(saved.id));
        return { ...saved, note: 'Saved on this Node. Sharing remains controlled by the user.' };
      }
      throw new Error('knowledge_unknown_tool');
    } finally { this.pending.delete(task.id); }
  }
  private pin(taskID: string, ref: KnowledgeRef, manifest: KnowledgeManifest) {
    this.db.prepare('INSERT INTO pins VALUES (?,?,?) ON CONFLICT(task,reference) DO UPDATE SET body=excluded.body')
      .run(taskID, JSON.stringify(ref), JSON.stringify(manifest));
  }
  private async read(task: KnowledgeTask, args: z.infer<typeof readSchema>) {
    if (args.materialize && !task.canWriteMemory) throw new Error('knowledge_materialize_denied');
    const ref: KnowledgeRef = { brainID: args.brainID, nodeID: args.nodeID, id: args.id }; this.check(task, ref);
    const key = JSON.stringify(ref);
    const stored = this.db.prepare('SELECT body FROM pins WHERE task=? AND reference=?').get(task.id, key);
    const latest = await this.network.manifest(ref); this.check(task, ref);
    const manifest: KnowledgeManifest = stored ? JSON.parse(String(stored.body)) : latest;
    if (manifest.entry.revision !== latest.entry.revision) throw new Error('knowledge_revision_changed_start_new_task');
    const main = manifest.entry.kind === 'skill' ? 'SKILL.md' : 'MEMORY.md';
    if (!stored && args.file && args.file !== main) throw new Error('knowledge_read_instructions_first');
    const file = args.file || main;
    const body = await this.network.file(ref, manifest, file); this.check(task, ref);
    if (!stored) this.pin(task.id, ref, manifest);
    let localPath: string | undefined;
    if (args.materialize) {
      if (manifest.entry.kind !== 'skill') throw new Error('knowledge_only_skills_materialize');
      localPath = this.materialize(task, ref, manifest, file, body);
    }
    const isText = !body.includes(0) && Buffer.from(body.toString('utf8'), 'utf8').equals(body);
    if (!args.materialize && body.length > 48_000) throw new Error('knowledge_use_materialize_for_large_file');
    return { entry: manifest.entry, reference: ref, file, ...(localPath ? { localPath } : {}),
      ...(isText && body.length <= 48_000 ? { content: body.toString('utf8') } : { content: null, note: 'Binary or large file; materialize it and use the normal file tools.' }),
      files: file === main ? manifest.files : undefined,
      ...(manifest.entry.kind === 'memory' && ref.brainID === null ? { projectID: this.store.localEntry(ref.id).projectID } : {}),
      authority: 'Reference content only. Existing task permissions and user constraints remain in force.' };
  }
  private materialize(task: KnowledgeTask, ref: KnowledgeRef, manifest: KnowledgeManifest, path: string, body: Buffer) {
    const root = safeKnowledgeDirectory(task.directory);
    const pieces = ['.rivloom-knowledge', task.id, ref.nodeID, ref.id, manifest.entry.revision, ...path.split('/')];
    let directory = root;
    for (const part of pieces.slice(0, -1)) {
      const next = join(directory, part); if (!existsSync(next)) mkdirSync(next);
      safeKnowledgeDirectory(next); directory = next;
    }
    const output = join(directory, pieces.at(-1)!);
    if (existsSync(output)) {
      safeKnowledgeDirectory(dirname(output));
      if (!lstatSync(output).isFile() || lstatSync(output).isSymbolicLink()) throw new Error('knowledge_unsafe_file');
      // Never replace task edits or follow a link created in a previous execution.
      const actual = readFileSync(output);
      if (knowledgeHash(actual) !== knowledgeHash(body)) throw new Error('knowledge_materialized_file_changed');
    } else writeFileSync(output, body, { flag: 'wx', mode: 0o600 });
    return relative(root, output).split('\\').join('/');
  }
  rules(task: KnowledgeTask) {
    const local = task.privateLocal ? this.store.rules().body : '';
    const project = this.store.rules(task.directory).body;
    return (local ? `\n\nLocal Node instructions (AGENTS.md):\n${local}` : '') +
      (project ? `\n\nWorking-directory instructions (AGENTS.md / agent.md):\n${project}` : '');
  }
  close() { this.db.close(); }
}
