import { t } from './i18n.ts';
export const taskFileCapability = 'task-files-v1';
export const taskFileChunkBytes = 32 * 1024;
export const taskFileMaximumBytes = 20 * 1024 * 1024;
export const taskFileBatchBytes = 50 * 1024 * 1024;
export const taskFileMaximumCount = 10;
export const taskFileStorageBytes = 512 * 1024 * 1024;
export const taskFileIDPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type TaskFileDescriptor = {
  id: string;
  name: string;
  bytes: number;
  sha256: string;
  mime: string;
};
export type TaskFileScope = 'local' | 'remote' | 'brain';
export type TaskFilePurpose = 'input' | 'result';
export type TaskFileRoute = { scope: TaskFileScope; taskID: string; purpose: TaskFilePurpose };
export type TaskFileState = 'receiving' | 'complete' | 'failed';
export type TaskFileDelivery = {
  peerNodeID: string;
  state: 'waiting' | 'sending' | 'complete' | 'failed';
  bytes: number;
  error: string | null;
};
export type TaskFileView = TaskFileDescriptor & {
  state: TaskFileState;
  receivedBytes: number;
  error: string | null;
  updatedAt: string;
  deliveries: TaskFileDelivery[];
};
export type TaskFileConversation = {
  inputs: TaskFileView[];
  results: TaskFileView[];
  canPublish: boolean;
  canSave: boolean;
  canRetry: boolean;
};
export type TaskFileMessage = {
  type: 'task-file';
  version: 1;
  requestID: string;
  route: TaskFileRoute;
  file: TaskFileDescriptor;
  offset?: number;
  data?: string;
};
export type TaskFileResponse = {
  type: 'task-file-response';
  version: 1;
  requestID: string;
  route: TaskFileRoute;
  fileID: string;
  sha256: string;
  receivedBytes: number;
  state: 'receiving' | 'complete' | 'failed';
  failure?: 'integrity' | 'unavailable';
};
export function sameTaskFile(a: TaskFileDescriptor, b: TaskFileDescriptor) {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.bytes === b.bytes &&
    a.sha256 === b.sha256 &&
    a.mime === b.mime
  );
}
export function sameTaskFileManifest(a: TaskFileDescriptor[] = [], b: TaskFileDescriptor[] = []) {
  return a.length === b.length && a.every((file, index) => sameTaskFile(file, b[index]));
}
export function inputFileFields(files?: TaskFileDescriptor[]) {
  return files?.length ? { inputFiles: structuredClone(files) } : {};
}

export function taskFileNameError(name: unknown): string | null {
  if (
    typeof name !== 'string' ||
    !name ||
    name.length > 180 ||
    name !== name.trim() ||
    /[<>:"/\\|?*\x00-\x1f\x7f]/.test(name) ||
    /[. ]$/.test(name) ||
    name === '.' ||
    name === '..' ||
    /[\u202a-\u202e\u2066-\u2069]/.test(name)
  )
    return t('文件名包含不支持的路径或控制字符。');
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name))
    return t('文件名是 Windows 保留名称。');
  if (
    /^\.env(?:\.|$)|(?:^|[._-])(?:auth|credentials?|secrets?|tokens?)(?:[._-]|$)|\.(?:pem|key|p12|pfx|kdbx)$/i.test(
      name,
    ) ||
    /^(id_rsa|id_ed25519|id_ecdsa|node-identity|trusted-nodes)(?:\.|$)/i.test(name)
  )
    return t('此类凭据或身份文件不能作为任务附件传送。');
  return null;
}
export function taskFileMime(name: string) {
  const extension = name.toLowerCase().split('.').pop();
  return (
    (
      {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        gif: 'image/gif',
      } as Record<string, string>
    )[extension || ''] || 'application/octet-stream'
  );
}
export function validTaskFileDescriptor(value: unknown): value is TaskFileDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).length === 5 &&
    !taskFileNameError(v.name) &&
    typeof v.id === 'string' &&
    taskFileIDPattern.test(v.id) &&
    Number.isSafeInteger(v.bytes) &&
    Number(v.bytes) >= 0 &&
    Number(v.bytes) <= taskFileMaximumBytes &&
    typeof v.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(v.sha256) &&
    v.mime === taskFileMime(String(v.name))
  );
}
export function validTaskFileManifest(value: unknown): value is TaskFileDescriptor[] {
  return (
    Array.isArray(value) &&
    value.length <= taskFileMaximumCount &&
    value.every(validTaskFileDescriptor) &&
    new Set(value.map((f) => f.id)).size === value.length &&
    value.reduce((sum, f) => sum + f.bytes, 0) <= taskFileBatchBytes
  );
}
export function validTaskFileRoute(value: unknown): value is TaskFileRoute {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).length === 3 &&
    ['local', 'remote', 'brain'].includes(String(v.scope)) &&
    typeof v.taskID === 'string' &&
    taskFileIDPattern.test(v.taskID) &&
    ['input', 'result'].includes(String(v.purpose))
  );
}
export function validTaskFileMessage(value: unknown): value is TaskFileMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (k) => !['type', 'version', 'requestID', 'route', 'file', 'offset', 'data'].includes(k),
    )
  )
    return false;
  if (
    v.type !== 'task-file' ||
    v.version !== 1 ||
    typeof v.requestID !== 'string' ||
    !taskFileIDPattern.test(v.requestID) ||
    !validTaskFileRoute(v.route) ||
    v.route.scope === 'local' ||
    !validTaskFileDescriptor(v.file)
  )
    return false;
  return (
    (v.offset === undefined && v.data === undefined) ||
    (Number.isSafeInteger(v.offset) &&
      Number(v.offset) >= 0 &&
      typeof v.data === 'string' &&
      v.data.length > 0 &&
      v.data.length <= Math.ceil(taskFileChunkBytes / 3) * 4 &&
      (v.data.length / 4) * 3 - (v.data.endsWith('==') ? 2 : v.data.endsWith('=') ? 1 : 0) <=
        taskFileChunkBytes &&
      Number(v.offset) +
        (v.data.length / 4) * 3 -
        (v.data.endsWith('==') ? 2 : v.data.endsWith('=') ? 1 : 0) <=
        v.file.bytes &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.data))
  );
}
export function validTaskFileResponse(
  value: unknown,
  request: TaskFileMessage,
): value is TaskFileResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as TaskFileResponse;
  return (
    Object.keys(v).length === (v.state === 'failed' ? 9 : 8) &&
    v.type === 'task-file-response' &&
    v.version === 1 &&
    v.requestID === request.requestID &&
    validTaskFileRoute(v.route) &&
    v.route.scope === request.route.scope &&
    v.route.taskID === request.route.taskID &&
    v.route.purpose === request.route.purpose &&
    v.fileID === request.file.id &&
    v.sha256 === request.file.sha256 &&
    Number.isSafeInteger(v.receivedBytes) &&
    v.receivedBytes >= 0 &&
    v.receivedBytes <= request.file.bytes &&
    ((v.state === 'receiving' && v.receivedBytes < request.file.bytes) ||
      (v.state === 'complete' && v.receivedBytes === request.file.bytes) ||
      (v.state === 'failed' && ['integrity', 'unavailable'].includes(v.failure!)))
  );
}
export function taskFileBytesLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
