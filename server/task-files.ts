import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  taskFileBatchBytes,
  taskFileChunkBytes,
  taskFileIDPattern,
  taskFileMaximumCount,
  taskFileUploadCount,
  taskFileNameError,
  taskFileStorageBytes,
  validTaskFileDescriptor,
  validTaskFileManifest,
  validTaskFileRoute,
  sameTaskFile,
  type TaskFileDescriptor,
  type TaskFileRoute,
  type TaskFileState,
  type TaskFileView,
} from '../shared/task-files.ts';

export class TaskFileError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'TaskFileError';
    this.status = status;
  }
}
function check(value: unknown, status: number, message: string): asserts value {
  if (!value) throw new TaskFileError(status, message);
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const samePath = (a: string, b: string) =>
  process.platform === 'win32'
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);

/** Reject reparse/symlink traversal inside a caller-owned directory before using a path. */
function within(root: string, path: string) {
  const part = relative(root, path);
  check(
    part !== '' && !part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part),
    400,
    '文件路径超出指定目录。',
  );
  let current = root;
  for (const segment of part.split(sep)) {
    current = join(current, segment);
    if (existsSync(current)) {
      check(!lstatSync(current).isSymbolicLink(), 409, '文件目录包含符号链接，已停止写入。');
      check(samePath(realpathSync(current), current), 409, '文件目录被重定向，已停止写入。');
    }
  }
}
type FileRecord = TaskFileDescriptor & {
  origin: string;
  state: TaskFileState;
  receivedBytes: number;
  error: string | null;
  updatedAt: string;
};
type Delivery = {
  route: TaskFileRoute;
  fileID: string;
  peerNodeID: string;
  state: string;
  bytes: number;
  error: string | null;
};

export class TaskFileStore {
  private root: string;
  private db: DatabaseSync | null = null;
  private quota: number;
  constructor(root: string, quota = taskFileStorageBytes) {
    this.root = resolve(root, 'task-files');
    this.quota = quota;
  }
  get active() {
    return this.db !== null || existsSync(join(this.root, 'files.sqlite'));
  }
  private database() {
    if (this.db) return this.db;
    const parent = dirname(this.root);
    mkdirSync(parent, { recursive: true });
    check(samePath(realpathSync(parent), parent), 409, '任务数据目录被重定向，不能保存文件。');
    within(parent, this.root);
    mkdirSync(this.root, { recursive: true });
    const blobs = join(this.root, 'blobs');
    within(this.root, blobs);
    mkdirSync(blobs, { recursive: true });
    const path = join(this.root, 'files.sqlite');
    within(this.root, path);
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY,body TEXT NOT NULL,bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bindings (scope TEXT NOT NULL,task_id TEXT NOT NULL,purpose TEXT NOT NULL,file_id TEXT NOT NULL,
        PRIMARY KEY(scope,task_id,purpose,file_id));
      CREATE TABLE IF NOT EXISTS file_locations (file_id TEXT PRIMARY KEY,path TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (scope TEXT NOT NULL,task_id TEXT NOT NULL,purpose TEXT NOT NULL,file_id TEXT NOT NULL,peer_id TEXT NOT NULL,
        state TEXT NOT NULL,bytes INTEGER NOT NULL,error TEXT,PRIMARY KEY(scope,task_id,purpose,file_id,peer_id));`);
    return this.db;
  }
  close() {
    this.db?.close();
    this.db = null;
  }
  historyFiles(members: { local: string[]; remote: string[]; brain: string[]; workflow: string[] }): string[] {
    if (!this.active) return [];
    const db = this.database(), result = new Set<string>();
    for (const scope of ['local', 'remote', 'brain'] as const) for (const id of members[scope])
      for (const row of db.prepare('SELECT file_id FROM bindings WHERE scope=? AND task_id=?').all(scope, id)) result.add(String(row.file_id));
    // Exports interrupted before binding are still owned by the same execution.
    for (const row of db.prepare('SELECT body FROM files').all()) {
      const file = JSON.parse(String(row.body)) as FileRecord;
      if (members.local.some((id) => file.origin.startsWith(`user:workflow-output:${id}:`)) ||
        members.workflow.some((id) => file.origin.startsWith(`user:workflow-relay:${id}:`))) result.add(file.id);
    }
    return [...result];
  }
  /** Remove app-owned copies only. User exports and project paths are never unlinked. */
  purgeHistory(members: { local: string[]; remote: string[]; brain: string[] }, fileIDs: string[], protectedIDs: Set<string>) {
    if (!this.active) return;
    const db = this.database(), candidates = new Set(fileIDs);
    for (const scope of ['local', 'remote', 'brain'] as const) for (const id of members[scope]) {
      for (const row of db.prepare('SELECT file_id FROM bindings WHERE scope=? AND task_id=?').all(scope, id)) candidates.add(String(row.file_id));
      db.prepare('DELETE FROM deliveries WHERE scope=? AND task_id=?').run(scope, id);
      db.prepare('DELETE FROM bindings WHERE scope=? AND task_id=?').run(scope, id);
    }
    for (const id of candidates) {
      if (protectedIDs.has(id) || db.prepare('SELECT 1 FROM bindings WHERE file_id=? LIMIT 1').get(id)) continue;
      const record = this.record(id);
      if (!record) continue;
      const received = join(this.root, 'received', id, record.name);
      within(this.root, received);
      if (existsSync(received)) {
        const stat = lstatSync(received);
        check(stat.isFile() && stat.nlink === 1, 409, '文件存储类型异常，已停止清理。');
        unlinkSync(received);
      }
      const blob = this.path(id);
      if (existsSync(blob)) {
        const stat = lstatSync(blob);
        check(stat.isFile() && stat.nlink === 1, 409, '文件存储类型异常，已停止清理。');
        unlinkSync(blob);
      }
      db.prepare('DELETE FROM file_locations WHERE file_id=?').run(id);
      db.prepare('DELETE FROM deliveries WHERE file_id=?').run(id);
      db.prepare('DELETE FROM files WHERE id=?').run(id);
    }
  }
  private path(id: string) {
    check(taskFileIDPattern.test(id), 400, '文件 ID 无效。');
    const path = join(this.root, 'blobs', `${id}.blob`);
    within(this.root, path);
    return path;
  }
  private record(id: string): FileRecord | null {
    const row = this.database().prepare('SELECT body FROM files WHERE id=?').get(id);
    return row ? JSON.parse(String(row.body)) : null;
  }
  private save(value: FileRecord) {
    this.database()
      .prepare(
        'INSERT INTO files VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,bytes=excluded.bytes',
      )
      .run(value.id, JSON.stringify(value), value.bytes);
  }
  private descriptor(value: FileRecord): TaskFileDescriptor {
    const { id, name, bytes, sha256, mime } = value;
    return { id, name, bytes, sha256, mime };
  }
  descriptorFor(id: string) {
    const value = this.record(id);
    check(value, 404, '文件记录不存在。');
    return this.descriptor(value);
  }
  private reserve(file: TaskFileDescriptor, origin: string) {
    check(
      validTaskFileDescriptor(file),
      400,
      taskFileNameError(file.name) || '文件大小、类型或校验信息无效。',
    );
    const previous = this.record(file.id);
    if (previous) {
      check(
        previous.origin === origin && sameTaskFile(previous, file),
        409,
        '文件 ID 已绑定其他来源或内容。',
      );
      return previous;
    }
    const used = Number(
      this.database().prepare('SELECT COALESCE(SUM(bytes),0) AS total FROM files').get()!.total,
    );
    check(
      Number(this.database().prepare('SELECT COUNT(*) AS count FROM files').get()!.count) < 4096,
      409,
      '任务文件数量已达到上限。',
    );
    check(
      used + file.bytes <= this.quota,
      409,
      '任务文件存储空间已达到上限，请移除未发送文件后再试。',
    );
    const value: FileRecord = {
      ...file,
      origin,
      state: 'receiving',
      receivedBytes: 0,
      error: null,
      updatedAt: new Date().toISOString(),
    };
    // Record expected size before creating a blob; startup/retry can create a missing empty blob.
    this.save(value);
    return value;
  }
  private ensureBlob(record: FileRecord) {
    const path = this.path(record.id);
    if (!existsSync(path)) {
      check(record.receivedBytes === 0, 409, '部分文件数据缺失，请重新选择文件发送。');
      const fd = openSync(path, 'wx', 0o600);
      closeSync(fd);
    }
    const stat = lstatSync(path);
    check(stat.isFile() && stat.nlink === 1, 409, '文件存储类型异常，已停止读取。');
    return path;
  }
  private finish(record: FileRecord) {
    const path = this.ensureBlob(record);
    if (statSync(path).size !== record.bytes) {
      record.state = 'failed';
      record.error = '文件长度校验失败，请重新选择原文件发送。';
      record.updatedAt = new Date().toISOString();
      this.save(record);
      throw new TaskFileError(409, record.error);
    }
    const content = readFileSync(path);
    if (content.length !== record.bytes || sha(content) !== record.sha256) {
      record.state = 'failed';
      record.error = '文件完整性校验失败，请重新选择原文件发送。';
      record.updatedAt = new Date().toISOString();
      this.save(record);
      throw new TaskFileError(409, record.error);
    }
    if (record.mime.startsWith('image/')) {
      const valid =
        record.mime === 'image/png'
          ? content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : record.mime === 'image/jpeg'
            ? content.length >= 3 && content[0] === 255 && content[1] === 216 && content[2] === 255
            : record.mime === 'image/gif'
              ? ['GIF87a', 'GIF89a'].includes(content.subarray(0, 6).toString())
              : record.mime === 'image/webp'
                ? content.subarray(0, 4).toString() === 'RIFF' &&
                  content.subarray(8, 12).toString() === 'WEBP'
                : false;
      if (!valid) {
        record.state = 'failed';
        record.error = '图片格式与文件扩展名不一致。';
        this.save(record);
        throw new TaskFileError(400, record.error);
      }
    }
    record.state = 'complete';
    record.error = null;
    record.receivedBytes = record.bytes;
    record.updatedAt = new Date().toISOString();
    this.save(record);
    return record;
  }
  beginUpload(userID: string, file: TaskFileDescriptor) {
    const value = this.reserve(file, `user:${userID}`);
    this.ensureBlob(value);
    if (value.bytes === 0 && value.state !== 'complete') this.finish(value);
    return this.view(value.id);
  }
  private writeChunk(id: string, offset: number, data: string) {
    const value = this.record(id);
    check(value, 404, '文件记录不存在。');
    check(value.state !== 'failed', 409, value.error || '文件传输已失败。');
    check(Number.isSafeInteger(offset) && offset >= 0, 400, '文件块偏移无效。');
    const chunk = Buffer.from(data, 'base64');
    check(
      chunk.length > 0 && chunk.length <= taskFileChunkBytes && chunk.toString('base64') === data,
      400,
      '文件块内容无效。',
    );
    check(offset + chunk.length <= value.bytes, 400, '文件块超过声明长度。');
    check(offset <= value.receivedBytes, 409, '文件块尚未按顺序到达。');
    const path = this.ensureBlob(value);
    const fd = openSync(path, 'r+');
    try {
      check(fstatSync(fd).isFile() && fstatSync(fd).nlink === 1, 409, '文件存储类型异常。');
      if (offset < value.receivedBytes || value.state === 'complete') {
        check(offset + chunk.length <= value.receivedBytes, 409, '文件块与已确认进度重叠。');
        const saved = Buffer.alloc(chunk.length);
        check(
          readSync(fd, saved, 0, saved.length, offset) === saved.length && saved.equals(chunk),
          409,
          '重复文件块与原内容冲突。',
        );
        return this.view(id);
      }
      let written = 0;
      while (written < chunk.length) {
        const count = writeSync(fd, chunk, written, chunk.length - written, offset + written);
        check(count > 0, 503, '未能写入完整文件块。');
        written += count;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Bytes are durable before progress acknowledgement; a crash here safely replays the same block.
    value.receivedBytes = offset + chunk.length;
    value.updatedAt = new Date().toISOString();
    this.save(value);
    if (value.receivedBytes === value.bytes) this.finish(value);
    return this.view(id);
  }
  uploadChunk(userID: string, id: string, offset: number, data: string) {
    check(this.record(id)?.origin === `user:${userID}`, 403, '你不能修改此上传。');
    return this.writeChunk(id, offset, data);
  }
  uploaded(userID: string, ids: string[]) {
    check(
      ids.length <= taskFileUploadCount && new Set(ids).size === ids.length,
      400,
      '每批最多选择 10 个不同文件。',
    );
    const files = ids.map((id) => {
      const value = this.record(id);
      check(value && value.origin === `user:${userID}`, 403, '附件不属于当前操作者。');
      check(value.state === 'complete', 409, '附件尚未上传并校验完成。');
      return this.descriptor(value);
    });
    check(validTaskFileManifest(files), 400, '这一批文件超过 1000 MiB。');
    return files;
  }
  private bind(route: TaskFileRoute, files: TaskFileDescriptor[]) {
    check(validTaskFileRoute(route) && validTaskFileManifest(files), 400, '任务文件绑定无效。');
    const existing = this.manifest(route);
    const combined = [...new Map([...existing, ...files].map((f) => [f.id, f])).values()];
    check(
      combined.length <= taskFileMaximumCount &&
        combined.reduce((n, f) => n + f.bytes, 0) <= taskFileBatchBytes,
      409,
      '此任务同类文件最多 10 个、合计 1000 MiB。',
    );
    const statement = this.database().prepare('INSERT OR IGNORE INTO bindings VALUES (?,?,?,?)');
    for (const file of files) statement.run(route.scope, route.taskID, route.purpose, file.id);
  }
  bindUploaded(route: TaskFileRoute, userID: string, ids: string[]) {
    const files = this.uploaded(userID, ids);
    this.bind(route, files);
    return files;
  }
  bindExisting(route: TaskFileRoute, files: TaskFileDescriptor[]) {
    for (const file of files) {
      const value = this.record(file.id);
      check(
        value && value.state === 'complete' && sameTaskFile(value, file),
        409,
        '中转文件尚未完整。',
      );
    }
    this.bind(route, files);
  }
  expectIncoming(route: TaskFileRoute, files: TaskFileDescriptor[], peerNodeID: string) {
    check(validTaskFileRoute(route) && validTaskFileManifest(files), 400, '接收文件清单无效。');
    // Reserve the whole manifest atomically; failed capacity checks leave no half-bound batch.
    const db = this.database();
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const file of files) this.reserve(file, `peer:${peerNodeID}`);
      this.bind(route, files);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  /** Explicit retrieval retry may discard only a failed cache of the exact bound remote file. */
  retryIncoming(route: TaskFileRoute, file: TaskFileDescriptor, peerNodeID: string) {
    const value = this.record(file.id);
    check(value && value.origin === `peer:${peerNodeID}` && sameTaskFile(value, file) &&
      this.manifest(route).some((item) => sameTaskFile(item, file)), 403, '文件来源与任务绑定不一致。');
    if (value.state !== 'failed') return;
    const fd = openSync(this.ensureBlob(value), 'r+');
    try {
      const stat = fstatSync(fd); check(stat.isFile() && stat.nlink === 1, 409, '文件存储类型异常，已停止读取。');
      ftruncateSync(fd, 0); fsyncSync(fd);
    } finally { closeSync(fd); }
    this.save({ ...value, state: 'receiving', receivedBytes: 0, error: null, updatedAt: new Date().toISOString() });
  }
  receive(
    route: TaskFileRoute,
    peerNodeID: string,
    file: TaskFileDescriptor,
    offset?: number,
    data?: string,
  ) {
    check(
      this.manifest(route).some((f) => sameTaskFile(f, file)),
      403,
      '文件不属于该任务清单。',
    );
    const value = this.record(file.id);
    check(value?.origin === `peer:${peerNodeID}`, 403, '文件来源与任务绑定不一致。');
    check(value.state !== 'failed', 409, value.error || '文件接收已失败。');
    this.ensureBlob(value);
    if (value.bytes === 0 && value.state !== 'complete') this.finish(value);
    if (data !== undefined && offset !== undefined) return this.writeChunk(file.id, offset, data);
    return this.view(file.id);
  }
  manifest(route: TaskFileRoute): TaskFileDescriptor[] {
    check(validTaskFileRoute(route), 400, '任务文件路由无效。');
    return this.database()
      .prepare(
        'SELECT f.body FROM bindings b JOIN files f ON f.id=b.file_id WHERE scope=? AND task_id=? AND purpose=? ORDER BY b.rowid',
      )
      .all(route.scope, route.taskID, route.purpose)
      .map((row) => this.descriptor(JSON.parse(String(row.body))));
  }
  complete(route: TaskFileRoute, expected: TaskFileDescriptor[]) {
    const bound = this.manifest(route);
    return expected.every(
      (file) =>
        bound.some((b) => sameTaskFile(b, file)) && this.record(file.id)?.state === 'complete',
    );
  }
  view(id: string, route?: TaskFileRoute): TaskFileView {
    const value = this.record(id);
    check(value, 404, '文件记录不存在。');
    const deliveries = route
      ? this.database()
          .prepare(
            `SELECT peer_id AS peerNodeID,state,bytes,error FROM deliveries
      WHERE scope=? AND task_id=? AND purpose=? AND file_id=?`,
          )
          .all(route.scope, route.taskID, route.purpose, id)
      : [];
    return {
      ...this.descriptor(value),
      state: value.state,
      receivedBytes: value.receivedBytes,
      error: value.error,
      updatedAt: value.updatedAt,
      deliveries: deliveries as TaskFileView['deliveries'],
    };
  }
  views(route: TaskFileRoute) {
    return this.manifest(route).map((file) => this.view(file.id, route));
  }
  queueDelivery(route: TaskFileRoute, fileID: string, peerNodeID: string) {
    check(
      this.manifest(route).some((file) => file.id === fileID),
      403,
      '文件未绑定此发送任务。',
    );
    this.database()
      .prepare('INSERT OR IGNORE INTO deliveries VALUES (?,?,?,?,?,?,?,?)')
      .run(route.scope, route.taskID, route.purpose, fileID, peerNodeID, 'waiting', 0, null);
  }
  deliveries(): Delivery[] {
    return this.database()
      .prepare("SELECT * FROM deliveries WHERE state IN ('waiting','sending') ORDER BY rowid")
      .all()
      .map((row) => ({
        route: { scope: row.scope, taskID: row.task_id, purpose: row.purpose } as TaskFileRoute,
        fileID: String(row.file_id),
        peerNodeID: String(row.peer_id),
        state: String(row.state),
        bytes: Number(row.bytes),
        error: row.error as string | null,
      }));
  }
  deliveryState(
    route: TaskFileRoute,
    id: string,
    peer: string,
    state: TaskFileView['deliveries'][number]['state'],
    bytes: number,
    error: string | null = null,
  ) {
    this.database()
      .prepare(
        'UPDATE deliveries SET state=?,bytes=?,error=? WHERE scope=? AND task_id=? AND purpose=? AND file_id=? AND peer_id=?',
      )
      .run(state, bytes, error, route.scope, route.taskID, route.purpose, id, peer);
  }
  retry(route: TaskFileRoute, fileID?: string) {
    this.database()
      .prepare(
        "UPDATE deliveries SET state='waiting',error=NULL WHERE scope=? AND task_id=? AND purpose=? AND state='failed' AND (? IS NULL OR file_id=?)",
      )
      .run(route.scope, route.taskID, route.purpose, fileID ?? null, fileID ?? null);
  }
  readChunk(id: string, offset: number) {
    const value = this.record(id);
    check(value?.state === 'complete', 409, '文件尚未校验完成。');
    check(
      Number.isSafeInteger(offset) && offset >= 0 && offset < value.bytes,
      400,
      '读取偏移无效。',
    );
    const path = this.ensureBlob(value);
    const fd = openSync(path, 'r');
    try {
      const chunk = Buffer.alloc(Math.min(taskFileChunkBytes, value.bytes - offset));
      check(readSync(fd, chunk, 0, chunk.length, offset) === chunk.length, 409, '源文件数据缺失。');
      return chunk.toString('base64');
    } finally {
      closeSync(fd);
    }
  }
  previewBytes(id: string, offset: number, length: number) {
    const value = this.record(id);
    check(value?.state === 'complete', 409, '文件尚未校验完成。');
    check(Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0 &&
      length <= 20 * 1024 * 1024 && offset + length <= value.bytes, 400, '读取范围无效。');
    const fd = openSync(this.ensureBlob(value), 'r');
    try {
      check(fstatSync(fd).size === value.bytes, 409, '本机文件长度与声明不一致。');
      const bytes = Buffer.alloc(length);
      check(readSync(fd, bytes, 0, length, offset) === length, 409, '源文件数据缺失。');
      return bytes;
    } finally { closeSync(fd); }
  }
  content(id: string) {
    const value = this.record(id);
    check(value?.state === 'complete', 409, '文件尚未完整接收。');
    const path = this.ensureBlob(value);
    check(statSync(path).size === value.bytes, 409, '本机文件长度与声明不一致。');
    const content = readFileSync(path);
    check(
      content.length === value.bytes && sha(content) === value.sha256,
      409,
      '本机文件完整性校验失败。',
    );
    return content;
  }
  discardUpload(userID: string, id: string) {
    const value = this.record(id);
    check(value?.origin === `user:${userID}`, 403, '你不能移除此上传。');
    check(
      !this.database().prepare('SELECT 1 FROM bindings WHERE file_id=?').get(id),
      409,
      '文件已绑定任务，不能作为草稿移除。',
    );
    const path = this.path(id);
    if (existsSync(path)) unlinkSync(path);
    this.database().prepare('DELETE FROM files WHERE id=?').run(id);
  }
  materialize(route: TaskFileRoute, expected: TaskFileDescriptor[], projectDirectory: string) {
    check(this.complete(route, expected), 409, '任务附件尚未完整接收。');
    if (!expected.length) return [];
    const root = realpathSync(projectDirectory);
    check(statSync(root).isDirectory(), 400, '执行文件夹不存在。');
    const base = join(root, '.rivloom-inputs', route.taskID);
    within(root, base);
    mkdirSync(base, { recursive: true });
    const paths: string[] = [];
    for (const file of expected) {
      const folder = join(base, file.id);
      within(root, folder);
      mkdirSync(folder, { recursive: true });
      const destination = join(folder, file.name);
      within(root, destination);
      const bytes = this.content(file.id);
      if (existsSync(destination)) {
        check(
          lstatSync(destination).isFile() &&
            lstatSync(destination).nlink === 1 &&
            statSync(destination).size === bytes.length &&
            sha(readFileSync(destination)) === sha(bytes),
          409,
          '附件目标已有不同内容，未覆盖。',
        );
      } else {
        const fd = openSync(destination, 'wx', 0o600);
        try {
          let offset = 0;
          while (offset < bytes.length) {
            const n = writeSync(fd, bytes, offset, bytes.length - offset);
            check(n > 0, 503, '附件写入失败。');
            offset += n;
          }
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
      paths.push(relative(root, destination).split(sep).join('/'));
      this.rememberLocation(file.id, destination);
    }
    return paths;
  }
  exportFile(id: string, destination: string) {
    check(
      isAbsolute(destination) && !destination.split(/[\\/]/).includes('..'),
      400,
      '请选择绝对保存路径。',
    );
    const nameError = taskFileNameError(basename(destination));
    check(!nameError, 400, nameError || '保存文件名无效。');
    const parent = dirname(resolve(destination));
    check(existsSync(parent) && statSync(parent).isDirectory(), 400, '保存文件夹不存在。');
    check(samePath(realpathSync(parent), parent), 409, '保存文件夹包含重定向，请选择实际文件夹。');
    check(!existsSync(destination), 409, '目标文件已存在，请换一个名称；原文件未覆盖。');
    this.content(id);
    try {
      copyFileSync(this.path(id), destination, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new TaskFileError(409, '目标文件已存在，未覆盖。');
      throw new TaskFileError(503, '文件未能保存，请检查目标文件夹权限和空间。');
    }
    check(
      sha(readFileSync(destination)) === this.descriptorFor(id).sha256,
      503,
      '保存后的文件校验失败，请检查目标磁盘。',
    );
    this.rememberLocation(id, resolve(destination));
    return { path: destination, bytes: this.descriptorFor(id).bytes };
  }
  private rememberLocation(id: string, path: string) {
    this.database()
      .prepare(
        'INSERT INTO file_locations VALUES (?,?) ON CONFLICT(file_id) DO UPDATE SET path=excluded.path',
      )
      .run(id, path);
  }
  /** Local paths never enter a manifest or peer message. Callers supply only known task paths. */
  async location(id: string, candidates: { root: string; path: string }[] = []) {
    const value = this.record(id);
    check(value?.state === 'complete', 409, '任务文件尚未完整接收。');
    const matches = async (root: string, path: string) => {
      try {
        check(isAbsolute(path) && samePath(realpathSync(root), root), 409, '文件路径无效。');
        within(root, path);
        const before = lstatSync(path);
        if (!before.isFile() || before.nlink !== 1 || before.size !== value.bytes) return false;
        const digest = createHash('sha256');
        let bytes = 0;
        for await (const chunk of createReadStream(path)) {
          bytes += chunk.length;
          if (bytes > value.bytes) return false;
          digest.update(chunk);
        }
        within(root, path);
        const after = lstatSync(path);
        return (
          after.isFile() &&
          after.nlink === 1 &&
          before.ino === after.ino &&
          before.dev === after.dev &&
          before.mtimeMs === after.mtimeMs &&
          before.ctimeMs === after.ctimeMs &&
          after.size === value.bytes &&
          bytes === value.bytes &&
          digest.digest('hex') === value.sha256
        );
      } catch {
        return false;
      }
    };
    const saved = this.database()
      .prepare('SELECT path FROM file_locations WHERE file_id=?')
      .get(id);
    const known = [...candidates];
    if (saved) known.push({ root: dirname(String(saved.path)), path: String(saved.path) });
    for (const candidate of known)
      if (await matches(candidate.root, candidate.path)) return { path: candidate.path };
    // A received file gets its real filename, isolated by ID so equal names never overwrite each other.
    const destination = join(this.root, 'received', id, value.name);
    within(this.root, destination);
    if (!existsSync(destination)) {
      mkdirSync(dirname(destination), { recursive: true });
      this.exportFile(id, destination);
    }
    check(await matches(this.root, destination), 409, '本机文件副本已改变，请另存文件后重试。');
    return { path: destination };
  }
}
