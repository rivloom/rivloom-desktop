import { realpath, lstat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { HttpError, requireThat } from './store.ts';
import type { Artifact } from '../shared/types.ts';
import { redact } from '../shared/redaction.ts';
export { redact, sanitize } from '../shared/redaction.ts';

export async function validateProject(directory: string) {
  let canonical: string;
  try {
    canonical = await realpath(resolve(directory));
  } catch {
    throw new HttpError(400, '项目目录不存在或当前系统用户无法访问');
  }
  requireThat((await lstat(canonical)).isDirectory(), 400, '需要选择一个文件夹');
  return canonical;
}
type OpenCodeFileDiff = {
  file?: string;
  patch?: string;
  additions: number;
  deletions: number;
  status?: 'added' | 'deleted' | 'modified';
};

function safePatch(diff: OpenCodeFileDiff) {
  const file = redact(diff.file || '未命名文件');
  const sensitive = /(^\.env($|\.)|\.(pem|key|p12)$|^auth\.json$|^credentials)/i.test(
    basename(file),
  );
  if (sensitive || diff.patch?.includes('\0')) return '[敏感或二进制文件内容未展示；请在本机检查]';
  return redact(diff.patch || '[OpenCode 未返回补丁正文；请在本机检查]');
}

/** Convert only the official OpenCode session diff; Rivloom does not scan or hash the folder. */
export function openCodeArtifacts(diffs: OpenCodeFileDiff[] | undefined): Artifact[] {
  return (diffs || []).map((diff) => ({
    file: redact(diff.file || '未命名文件'),
    patch: safePatch(diff),
    additions: diff.additions,
    deletions: diff.deletions,
    status: diff.status || 'modified',
  }));
}
