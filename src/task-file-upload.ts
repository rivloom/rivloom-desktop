import { t } from '../shared/i18n.ts';
import { api } from './api.ts';
import {
  taskFileNameError,
  taskFileMime,
  taskFileMaximumBytes,
  taskFileChunkBytes,
  type TaskFileDescriptor,
  type TaskFileView,
} from '../shared/task-files.ts';

export type DraftTaskFile = {
  id: string;
  file: File;
  state: 'preparing' | 'uploading' | 'complete' | 'failed';
  receivedBytes: number;
  error: string | null;
  descriptor?: TaskFileDescriptor;
};
export const draftFilesReady = (files: DraftTaskFile[] = []) =>
  files.every((file) => file.state === 'complete');
export async function uploadTaskFile(
  item: DraftTaskFile,
  progress: (value: Partial<DraftTaskFile>) => void,
  call: typeof api = api,
) {
  const error = taskFileNameError(item.file.name);
  if (error) throw new Error(error);
  if (item.file.size > taskFileMaximumBytes) throw new Error(t('单个文件最多 20 MiB。'));
  const buffer = await item.file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const descriptor: TaskFileDescriptor = {
    id: item.id,
    name: item.file.name,
    bytes: buffer.byteLength,
    sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''),
    mime: taskFileMime(item.file.name),
  };
  progress({ descriptor, state: 'uploading', error: null });
  let result = await call<TaskFileView>('/task-files/uploads', descriptor, {
    timeoutMilliseconds: 15000,
  });
  if (result.state === 'failed')
    throw new Error(result.error || t('文件校验失败，请移除此项后重新选择。'));
  progress({ receivedBytes: result.receivedBytes });
  while (result.state !== 'complete') {
    const offset = result.receivedBytes;
    const chunk = new Uint8Array(buffer.slice(offset, offset + taskFileChunkBytes));
    if (!chunk.length) throw new Error(t('服务器返回的文件进度无效。'));
    const data = btoa(String.fromCharCode(...chunk));
    result = await call<TaskFileView>(
      `/task-files/uploads/${item.id}/chunk`,
      { offset, data },
      { timeoutMilliseconds: 15000 },
    );
    if (
      result.receivedBytes !== offset + chunk.length ||
      !['receiving', 'complete'].includes(result.state)
    )
      throw new Error(t('上传进度未确认，请重试原文件。'));
    progress({ receivedBytes: result.receivedBytes });
  }
  progress({ state: 'complete', receivedBytes: descriptor.bytes, error: null, descriptor });
}
