import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, watch, type FSWatcher } from 'node:fs';
import { lstat, realpath, opendir, open, type FileHandle } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { resourceCatalogLimit, resourcePageSize, safeRelativeResourcePath, searchResources,
  validCatalogHead, validResourceEntry, type CatalogHead, type CatalogDelta, type ResourceEntry,
  type ResourceKind, type ResourceQuery, type ResourceReference, type SoftwareEvidence } from '../shared/resources.ts';
import { nodeID as validNodeID } from '../shared/collaboration.ts';
import { taskFileNameError } from '../shared/task-files.ts';

type Scope = { id: string; name: string; directory: string };
type Stored = { head: CatalogHead; entries: ResourceEntry[]; directory: string | null };
const excludedDirectories = new Set(['.git', '.svn', '.hg', 'node_modules', 'vendor', '.venv', 'venv', '__pycache__',
  '.cache', '.data', '.codex', '.agents', '.ssh', '.aws', '.azure', '.config', 'appdata', 'target', 'dist', 'build',
  '.next', '.nuxt', '.npm', '.pnpm-store', '.idea', '.vscode', '$recycle.bin', 'system volume information']);
export function discoverablePath(path: string) {
  if (!safeRelativeResourcePath(path)) return false;
  const segments = path.toLowerCase().split('/');
  return !segments.some((segment) => excludedDirectories.has(segment) || segment.startsWith('.') ||
    /(^|[._-])(auth|credentials?|secrets?|tokens?)([._-]|$)/.test(segment) ||
    /^(id_rsa|id_ed25519|known_hosts|authorized_keys|opencode\.jsonc?)$/.test(segment) ||
    /\.(pem|key|p12|pfx|kdbx|sqlite|db|log)$/.test(segment));
}
function kindFor(path: string): ResourceKind {
  const ext = extname(path).toLowerCase().slice(1);
  if (['md', 'txt', 'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'csv', 'rtf', 'odt'].includes(ext)) return 'document';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif', 'tif', 'tiff', 'bmp'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(ext)) return 'audio';
  if (['gguf', 'safetensors', 'onnx', 'pt', 'pth'].includes(ext)) return 'model';
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'c', 'cpp', 'h', 'cs', 'java', 'html', 'css', 'sh', 'ps1', 'sql'].includes(ext)) return 'code';
  return 'file';
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const samePath = (a: string, b: string) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const revisionOf = (stat: { size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number }) =>
  hash(JSON.stringify([stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino, stat.dev]));

/** Metadata only. The absolute scope path stays in this local database and never enters public records. */
export class ResourceCatalog {
  private db: DatabaseSync;
  private scope: Scope | null = null;
  private generation = 0;
  private value: Stored;
  private byID = new Map<string, ResourceEntry>();
  private deltas: CatalogDelta[] = [];
  private watcher: FSWatcher | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private reconcile: ReturnType<typeof setInterval> | null = null;
  private scanning: Promise<void> | null = null;
  private rescan = false;
  private closed = false;
  private options: { limit: number; batch: number; changed: () => void; capabilities: () => Promise<SoftwareEvidence[]> };
  constructor(root: string, ownerNodeID: string, options: Partial<ResourceCatalog['options']> = {}) {
    if (!validNodeID(ownerNodeID)) throw new Error('Invalid catalog owner');
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(join(root, 'resource-catalog.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS catalog (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
    this.options = { limit: resourceCatalogLimit, batch: 100, changed: () => {}, capabilities: async () => [], ...options };
    this.value = { head: { nodeID: ownerNodeID, epoch: randomUUID(), version: 0, workspaceID: null, workspaceName: null,
      state: 'unconfigured', count: 0, checkedAt: new Date().toISOString(), error: null, capabilities: [] }, entries: [], directory: null };
    const stored = this.db.prepare('SELECT body FROM catalog WHERE id=1').get();
    if (stored) {
      try {
        const parsed = JSON.parse(String(stored.body)) as Stored;
        if (validCatalogHead(parsed.head) && parsed.head.nodeID === ownerNodeID && Array.isArray(parsed.entries) &&
          parsed.entries.length === parsed.head.count && parsed.entries.every(validResourceEntry) &&
          parsed.entries.every((entry) => entry.nodeID === ownerNodeID && entry.workspaceID === parsed.head.workspaceID) &&
          (parsed.directory === null || typeof parsed.directory === 'string')) this.value = parsed;
      } catch { /* An invalid cache is rebuilt; it is never authority for filesystem access. */ }
    }
    this.byID = new Map(this.value.entries.map((entry) => [entry.id, entry]));
  }
  head(): CatalogHead { return structuredClone(this.value.head); }
  entries(): ResourceEntry[] { return structuredClone(this.value.entries); }
  entry(reference: ResourceReference): ResourceEntry | null {
    if (!this.scope) return null;
    const entry = this.byID.get(reference.id);
    return entry && entry.nodeID === reference.nodeID && entry.workspaceID === reference.workspaceID &&
      entry.revision === reference.revision ? structuredClone(entry) : null;
  }
  private persist() {
    this.byID = new Map(this.value.entries.map((entry) => [entry.id, entry]));
    this.db.prepare('INSERT INTO catalog VALUES (1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(JSON.stringify(this.value));
    this.options.changed();
  }
  async configure(scope: Scope | null) {
    if (this.closed) return;
    if (scope && this.scope?.id === scope.id && samePath(this.scope.directory, scope.directory)) return;
    this.generation++;
    const configuredGeneration = this.generation;
    this.watcher?.close(); this.watcher = null;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    this.scope = scope ? { ...scope, directory: resolve(scope.directory) } : null;
    const reusable = !!scope && scope.id === this.value.head.workspaceID && this.value.directory !== null && samePath(scope.directory, this.value.directory);
    this.value = { head: { ...this.value.head, version: this.value.head.version + 1, workspaceID: scope?.id || null,
      workspaceName: scope?.name || null, state: scope ? 'scanning' : 'unconfigured',
      count: reusable ? this.value.entries.length : 0, error: null, capabilities: [], checkedAt: new Date().toISOString() },
      entries: reusable ? this.value.entries : [], directory: this.scope?.directory || null };
    this.deltas = [];
    this.persist(); // Retire the old scope before any asynchronous traversal or probe.
    if (!scope) return;
    await this.refresh();
    if (!this.scope || configuredGeneration !== this.generation || this.closed) return;
    try {
      this.watcher = watch(this.scope.directory, { recursive: true, persistent: false }, (_event, filename) => {
        if (!filename || discoverablePath(filename.replaceAll('\\', '/'))) this.scheduleRefresh();
      });
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null; });
    } catch { /* Periodic reconciliation remains active on filesystems without recursive watching. */ }
    if (!this.reconcile) { this.reconcile = setInterval(() => this.scheduleRefresh(), 60_000); this.reconcile.unref(); }
  }
  scheduleRefresh() {
    if (this.closed || !this.scope || this.debounce) return;
    this.debounce = setTimeout(() => { this.debounce = null; void this.refresh(); }, 500);
    this.debounce.unref();
  }
  async refresh(): Promise<void> {
    if (this.scanning) { this.rescan = true; await this.scanning; return; }
    this.scanning = (async () => {
      do { this.rescan = false; await this.scan(); } while (this.rescan && !this.closed);
    })().finally(() => { this.scanning = null; });
    return this.scanning;
  }
  private async scan() {
    const scope = this.scope; const generation = this.generation;
    if (!scope || this.closed) return;
    const current = () => !this.closed && generation === this.generation;
    const old = this.value;
    const entries: ResourceEntry[] = [];
    let incomplete = false;
    let visited = 0;
    try {
      if ((await lstat(scope.directory)).isSymbolicLink() || !samePath(await realpath(scope.directory), scope.directory)) throw new Error('redirected_scope');
      const stack = [''];
      while (stack.length && current()) {
        const directory = stack.pop()!;
        const fullDirectory = join(scope.directory, directory);
        if (!samePath(await realpath(fullDirectory), fullDirectory)) { incomplete = true; continue; }
        let items;
        try { items = await opendir(fullDirectory, { bufferSize: this.options.batch }); }
        catch { incomplete = true; continue; }
        try { for await (const item of items) {
          if (!current()) return;
          const path = directory ? `${directory}/${item.name}` : item.name;
          if (!discoverablePath(path) || item.isSymbolicLink()) continue;
          if (++visited > this.options.limit * 5 || entries.length >= this.options.limit) { incomplete = true; stack.length = 0; break; }
          if (visited % this.options.batch === 0) await yieldLoop();
          const fullPath = join(scope.directory, path);
          try {
            const stat = await lstat(fullPath);
            if (stat.isSymbolicLink() || !samePath(await realpath(fullPath), fullPath)) continue;
            if (stat.isDirectory()) { stack.push(path); continue; }
            if (!stat.isFile() || stat.nlink !== 1) continue;
            const entry: ResourceEntry = { nodeID: old.head.nodeID, workspaceID: scope.id, id: hash(`${scope.id}/${path}`),
              revision: revisionOf(stat), name: basename(path), relativePath: path, kind: kindFor(path), bytes: stat.size,
              modifiedAt: stat.mtime.toISOString(), tags: [extname(path).slice(1).toLowerCase()].filter(Boolean).slice(0, 1),
              operations: stat.size <= 200 * 1024 * 1024 && !taskFileNameError(basename(path)) ? ['inspect', 'fetch'] : ['inspect'] };
            if (validResourceEntry(entry)) entries.push(entry); else incomplete = true;
          } catch { incomplete = true; }
        } } catch { incomplete = true; }
      }
      if (!current()) return;
      const capabilities = await this.options.capabilities();
      if (!current()) return;
      entries.sort((a, b) => a.id.localeCompare(b.id));
      const status = incomplete ? 'partial' : 'ready';
      const semanticCaps = (caps: SoftwareEvidence[]) => caps.map(({ checkedAt: _at, ...cap }) => cap);
      const changed = old.head.state !== status || JSON.stringify(entries) !== JSON.stringify(old.entries) ||
        JSON.stringify(semanticCaps(capabilities)) !== JSON.stringify(semanticCaps(old.head.capabilities));
      const head: CatalogHead = { ...old.head, state: status, count: entries.length, error: null,
        checkedAt: new Date().toISOString(), version: old.head.version + Number(changed), capabilities };
      this.value = { head, entries, directory: scope.directory };
      if (changed) {
        const previous = new Map(old.entries.map((entry) => [entry.id, entry]));
        const ids = new Set(entries.map((entry) => entry.id));
        const upsert = entries.filter((entry) => JSON.stringify(previous.get(entry.id)) !== JSON.stringify(entry));
        const removed = old.entries.filter((entry) => !ids.has(entry.id)).map((entry) => entry.id);
        if (upsert.length <= resourcePageSize && removed.length <= resourcePageSize)
          this.deltas.push({ head, fromVersion: old.head.version, upsert, removed });
        else this.deltas = [];
        this.deltas = this.deltas.slice(-8);
      }
      this.persist();
    } catch {
      if (!current()) return;
      this.value.head = { ...old.head, version: old.head.version + 1, state: 'error', error: 'Selected directory could not be indexed.', checkedAt: new Date().toISOString() };
      this.persist();
    }
  }
  page(epoch: string, version: number, offset: number) {
    const head = this.head();
    if (epoch !== head.epoch || version !== head.version || !Number.isSafeInteger(offset) || offset < 0 || offset > head.count)
      throw new Error('catalog_version_changed');
    const entries = this.value.entries.slice(offset, offset + resourcePageSize);
    return { head, offset, entries: structuredClone(entries), next: offset + entries.length < head.count ? offset + entries.length : null };
  }
  delta(epoch: string, fromVersion: number): CatalogDelta | null {
    const head = this.head();
    if (epoch !== head.epoch || fromVersion > head.version) return null;
    if (fromVersion === head.version) return { head, fromVersion, upsert: [], removed: [] };
    const changes = this.deltas.filter((delta) => delta.fromVersion >= fromVersion);
    let version = fromVersion;
    const upsert = new Map<string, ResourceEntry>(); const removed = new Set<string>();
    for (const delta of changes) {
      if (delta.fromVersion !== version) return null;
      for (const id of delta.removed) { upsert.delete(id); removed.add(id); }
      for (const entry of delta.upsert) { removed.delete(entry.id); upsert.set(entry.id, entry); }
      version = delta.head.version;
    }
    if (version !== head.version || upsert.size > resourcePageSize || removed.size > resourcePageSize) return null;
    return { head, fromVersion, upsert: [...upsert.values()], removed: [...removed] };
  }
  query(query: ResourceQuery) { return searchResources(this.head(), this.value.entries, query); }
  /** Open a currently indexed regular file, recheck every path segment and pin its identity to the handle. */
  async openResource(reference: ResourceReference): Promise<{ handle: FileHandle; entry: ResourceEntry; verify: () => Promise<void> }> {
    const generation = this.generation; const scope = this.scope;
    const entry = this.value.entries.find((entry) => entry.id === reference.id);
    if (!scope || !entry || !entry.operations.includes('fetch') || reference.nodeID !== this.value.head.nodeID ||
      reference.workspaceID !== scope.id || reference.revision !== entry.revision || !discoverablePath(entry.relativePath)) throw new Error('resource_unavailable');
    let path = scope.directory;
    for (const segment of ['', ...entry.relativePath.split('/')]) {
      path = join(path, segment);
      if ((await lstat(path)).isSymbolicLink() || !samePath(await realpath(path), path)) throw new Error('resource_scope_changed');
    }
    const rel = relative(scope.directory, path);
    if (isAbsolute(rel) || rel.startsWith(`..${sep}`) || rel === '..') throw new Error('resource_scope_changed');
    const handle = await open(path, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || revisionOf(stat) !== entry.revision || generation !== this.generation || this.closed ||
        !samePath(await realpath(path), path)) throw new Error('resource_version_changed');
      return { handle, entry: structuredClone(entry), verify: async () => {
        if (generation !== this.generation || this.closed || revisionOf(await handle.stat()) !== entry.revision)
          throw new Error('resource_version_changed');
      } };
    } catch (error) { await handle.close(); throw error; }
  }
  async close() {
    this.closed = true; this.generation++;
    this.watcher?.close();
    if (this.debounce) clearTimeout(this.debounce);
    if (this.reconcile) clearInterval(this.reconcile);
    await this.scanning;
    this.db.close();
  }
}
