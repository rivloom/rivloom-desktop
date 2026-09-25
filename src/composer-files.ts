import { t } from '../shared/i18n.ts';
import { taskFileBatchBytes, taskFileBytesLabel, taskFileMaximumBytes, taskFileNameError, taskFileUploadCount } from '../shared/task-files.ts';

type SelectedFile = Pick<File, 'name' | 'size'>;

// Validate a whole selection before changing the draft or uploading anything.
export function composerFileSelectionError(existing: readonly SelectedFile[], selected: readonly SelectedFile[]) {
  if (existing.length + selected.length > taskFileUploadCount ||
      [...existing, ...selected].reduce((sum, file) => sum + file.size, 0) > taskFileBatchBytes)
    return t('每批最多 5 个文件，合计 1000 MiB。');
  for (const file of selected) {
    const nameError = taskFileNameError(file.name);
    if (nameError) return nameError;
    if (file.size > taskFileMaximumBytes)
      return t('文件 {{name}} 超过单个文件上限 {{size}}。', { name: file.name, size: taskFileBytesLabel(taskFileMaximumBytes) });
  }
  return '';
}

export function isFileTransfer(transfer: Pick<DataTransfer, 'types'> | null) {
  return !!transfer && Array.from(transfer.types).includes('Files');
}

export function containsDroppedDirectory(items: Pick<DataTransferItem, 'kind' | 'webkitGetAsEntry'>[]) {
  return items.some(item => item.kind === 'file' && item.webkitGetAsEntry?.()?.isDirectory);
}
