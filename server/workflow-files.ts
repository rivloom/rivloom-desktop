import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { taskFileChunkBytes, taskFileMime, validTaskFileDescriptor, sameTaskFile, type TaskFileDescriptor } from '../shared/task-files.ts';
import { validWorkflowOutputPath, type Workflow } from '../shared/workflows.ts';
import type { Task } from '../shared/types.ts';
import { discoverablePath } from './resource-catalog.ts';
import type { TaskFileStore } from './task-files.ts';

type ExportRecord = { key: string; taskID: string; phase: 'preparing' | 'complete' | 'failed'; files: TaskFileDescriptor[]; error: string | null; revisions: Record<string, string> };
const samePath = (a: string, b: string) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const stamp = (value: { size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number }) =>
  JSON.stringify([value.size, value.mtimeMs, value.ctimeMs, value.ino, value.dev]);
function fileID(key: string) {
  const hash = createHash('sha256').update(key).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-b${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export function importConversationContext(files: TaskFileStore, value: Workflow): TaskFileDescriptor {
  const rounds = [...(value.rounds || []), value];
  const transcript = rounds.map((round, i) => ({ round: i + 1, request: round.description, criteria: round.criteria, state: round.state,
    clarifications: [round.planner, ...round.steps].flatMap((s) => s.attempts.flatMap((a) => a.clarifications || [])),
    plan: round.summary, results: round.steps.map((s) => ({ title: s.title, state: s.state, summary: s.checkpoint,
      files: s.attempts.at(-1)?.outputFiles || [] })), inputs: round.inputFiles.filter((f) => !f.name.startsWith('rivloom-conversation-')) }));
  const bytes = Buffer.from(JSON.stringify(transcript, null, 2));
  const descriptor: TaskFileDescriptor = { id: fileID(`conversation:${value.id}:${value.roundRequestID || value.requestID}`),
    name: `rivloom-conversation-${rounds.length}.json`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mime: 'application/octet-stream' };
  const owner = `workflow-context:${value.id}`;
  let view = files.beginUpload(owner, descriptor);
  while (view.receivedBytes < bytes.length) view = files.uploadChunk(owner, descriptor.id, view.receivedBytes,
    bytes.subarray(view.receivedBytes, view.receivedBytes + taskFileChunkBytes).toString('base64'));
  if (view.state !== 'complete') throw new Error('workflow_context_failed');
  return descriptor;
}
/** Each remote attempt has its own transfer identities, preserving the store's original-source binding. */
export async function relayWorkflowInputs(files: TaskFileStore, key: string, input: TaskFileDescriptor[],
  mayRead: () => boolean = () => true): Promise<TaskFileDescriptor[]> {
  const result: TaskFileDescriptor[] = [];
  for (const source of input) {
    if (!mayRead()) throw new Error('workflow_input_cancelled');
    if (!sameTaskFile(files.descriptorFor(source.id), source) || files.view(source.id).state !== 'complete')
      throw new Error('workflow_input_not_complete');
    const descriptor = { ...source, id: fileID(`relay:${key}:${source.id}:${source.sha256}`) };
    const owner = `workflow-relay:${key}`;
    let view = files.beginUpload(owner, descriptor);
    while (view.receivedBytes < descriptor.bytes) {
      if (!mayRead()) throw new Error('workflow_input_cancelled');
      view = files.uploadChunk(owner, descriptor.id, view.receivedBytes, files.readChunk(source.id, view.receivedBytes));
      await yieldLoop();
    }
    if (view.state !== 'complete') throw new Error('workflow_input_not_complete');
    result.push(descriptor);
  }
  return result;
}
/** Export only explicit, verified business files; a model path is never filesystem authority. */
export async function importWorkflowOutput(files: TaskFileStore, key: string, directory: string, path: string,
  mayRead: () => boolean = () => true, pin: (revision: string) => void = () => {}): Promise<TaskFileDescriptor> {
  if (!validWorkflowOutputPath(path) || !discoverablePath(path.replaceAll('\\', '/'))) throw new Error('workflow_output_not_exportable');
  const root = await realpath(directory); const destination = resolve(root, path);
  const part = relative(root, destination);
  if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error('workflow_output_outside_project');
  let current = root;
  for (const segment of part.split(sep)) {
    current = join(current, segment); const info = await lstat(current);
    if (info.isSymbolicLink() || !samePath(await realpath(current), current)) throw new Error('workflow_output_redirected');
  }
  const before = await lstat(destination);
  if (!before.isFile() || before.nlink !== 1) throw new Error('workflow_output_not_file');
  const handle = await open(destination, 'r');
  try {
    const initial = await handle.stat();
    const verify = async () => {
      if (!mayRead() || !samePath(await realpath(directory), root) || !samePath(await realpath(destination), destination) ||
        stamp(await handle.stat()) !== stamp(initial) || stamp(await lstat(destination)) !== stamp(initial)) throw new Error('workflow_output_changed');
    };
    if (stamp(before) !== stamp(initial)) throw new Error('workflow_output_changed');
    pin(stamp(initial));
    // Reject the size before hashing so an oversized output never monopolizes the export worker.
    const descriptor = { id: fileID(`${key}:${path}:${stamp(initial)}`), name: basename(path), bytes: initial.size,
      sha256: '0'.repeat(64), mime: taskFileMime(path) };
    if (!validTaskFileDescriptor(descriptor)) throw new Error('workflow_output_limit');
    const buffer = Buffer.alloc(taskFileChunkBytes); const hash = createHash('sha256');
    for (let position = 0; position < initial.size;) {
      if (!mayRead()) throw new Error('workflow_output_cancelled');
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, initial.size - position), position);
      if (!bytesRead) throw new Error('workflow_output_changed');
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead; await yieldLoop();
    }
    await verify(); descriptor.sha256 = hash.digest('hex');
    const origin = `workflow-output:${key}`; let view = files.beginUpload(origin, descriptor);
    while (view.receivedBytes < descriptor.bytes) {
      if (!mayRead()) throw new Error('workflow_output_cancelled');
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, descriptor.bytes - view.receivedBytes), view.receivedBytes);
      if (!bytesRead) throw new Error('workflow_output_changed');
      view = files.uploadChunk(origin, descriptor.id, view.receivedBytes, buffer.subarray(0, bytesRead).toString('base64'));
      await yieldLoop();
    }
    await verify(); if (view.state !== 'complete') throw new Error('workflow_output_incomplete');
    return descriptor;
  } finally { await handle.close(); }
}
export class WorkflowOutputs {
  private db: DatabaseSync; private files: TaskFileStore;
  private jobs = new Map<string, Promise<void>>(); private closed = false; private changed: () => void;
  historyBusy(taskIDs: string[]) { return [...this.jobs.keys()].some((key) => taskIDs.some((id) => key.startsWith(`${id}:`))); }
  constructor(db: DatabaseSync, files: TaskFileStore, changed: () => void = () => {}) {
    this.db = db; this.files = files; this.changed = changed;
    db.exec('CREATE TABLE IF NOT EXISTS workflow_outputs (key TEXT PRIMARY KEY, task_id TEXT NOT NULL, body TEXT NOT NULL)');
  }
  private key(task: Task) { return `${task.id}:${task.sessionID}:${task.runAfter}`; }
  /** Recover original output locations from persisted export identities, including older tasks. */
  locations(taskID: string, id: string, directory: string) {
    const locations: { root: string; path: string }[] = [];
    for (const row of this.db.prepare('SELECT body FROM workflow_outputs WHERE task_id=?').all(taskID)) {
      const value = JSON.parse(String(row.body)) as ExportRecord;
      if (value.phase !== 'complete' || !value.files.some((file) => file.id === id)) continue;
      for (const [path, revision] of Object.entries(value.revisions || {})) {
        if (validWorkflowOutputPath(path) && discoverablePath(path.replaceAll('\\', '/')) && fileID(`${value.key}:${path}:${revision}`) === id)
          locations.push({ root: resolve(directory), path: resolve(directory, path) });
      }
    }
    return locations;
  }
  private read(key: string): ExportRecord | null {
    const row = this.db.prepare('SELECT body FROM workflow_outputs WHERE key=?').get(key);
    return row ? JSON.parse(String(row.body)) : null;
  }
  private save(value: ExportRecord) {
    this.db.prepare('INSERT INTO workflow_outputs VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body').run(value.key, value.taskID, JSON.stringify(value));
    this.changed();
  }
  ensure(task: Task, directory: string): ExportRecord {
    const key = this.key(task); let value = this.read(key);
    if (value) { if (value.phase === 'preparing') this.start(task, directory, value); return value; }
    if (task.state !== 'accepted' || !task.collaboration || !task.collaborationOutcome ||
      task.collaborationOutcome.attempt !== task.collaboration.attempt || task.collaborationOutcome.sessionID !== task.sessionID ||
      task.collaborationOutcome.runAfter !== task.runAfter) throw new Error('workflow_outcome_not_bound');
    value = { key, taskID: task.id, phase: 'preparing', files: [], error: null, revisions: {} }; this.save(value); this.start(task, directory, value); return value;
  }
  private start(task: Task, directory: string, value: ExportRecord) {
    if (this.closed || this.jobs.has(value.key) || this.jobs.size >= 2) return;
    const job = (async () => {
      try {
        const outcome = task.collaborationOutcome!.value;
        const paths = 'files' in outcome ? outcome.files : [];
        const outputs: TaskFileDescriptor[] = [];
        for (const path of paths) outputs.push(await importWorkflowOutput(this.files, value.key, directory, path, () => !this.closed, (revision) => {
          if (value.revisions[path] && value.revisions[path] !== revision) throw new Error('workflow_output_changed');
          value.revisions[path] = revision; this.save(value);
        }));
        if (this.closed) return;
        this.files.bindExisting({ scope: 'local', taskID: task.id, purpose: 'result' }, outputs);
        this.save({ ...value, files: outputs, phase: 'complete', error: null });
      } catch (error) {
        if (!this.closed) this.save({ ...value, phase: 'failed', error: error instanceof Error ? error.message.slice(0, 300) : 'workflow_output_failed' });
      }
    })().finally(() => this.jobs.delete(value.key));
    this.jobs.set(value.key, job);
  }
  async close() { this.closed = true; await Promise.allSettled([...this.jobs.values()]); }
}
