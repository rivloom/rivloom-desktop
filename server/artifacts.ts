import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath, lstat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { requireThat } from './store.ts';
import type { Artifact } from '../shared/types.ts';
const exec = promisify(execFile);
export async function git(directory: string, args: string[]) {
  return (
    await exec('git', ['-c', 'core.quotepath=false', ...args], {
      cwd: directory,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 15_000,
    })
  ).stdout;
}
export async function validateProject(directory: string) {
  const canonical = await realpath(resolve(directory));
  requireThat((await lstat(canonical)).isDirectory(), 400, '需要一个目录');
  const root = await realpath((await git(canonical, ['rev-parse', '--show-toplevel'])).trim());
  requireThat(canonical.toLowerCase() === root.toLowerCase(), 400, '请选择 Git 仓库根目录');
  await git(canonical, ['rev-parse', 'HEAD']);
  return canonical;
}
export function redact(text: string) {
  return text
    .replace(/\b(sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9]{16,})\b/g, '[REDACTED]')
    .replace(/(Bearer|Basic)\s+[a-zA-Z0-9_+/=.-]{10,}/gi, '$1 [REDACTED]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*["']?)[^\s,"'}]+/gi,
      '$1[REDACTED]',
    )
    .replace(/https:\/\/opencode\.ai\/workspace\/[^\s"\\]+/g, 'https://opencode.ai');
}
export function sanitize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (_key, item) =>
    typeof item === 'string' ? redact(item) : item,
  );
}
export async function captureArtifacts(directory: string, base: string) {
  const tracked = (await git(directory, ['diff', '--name-only', '-z', base, '--']))
    .split('\0')
    .filter(Boolean);
  const untracked = (await git(directory, ['ls-files', '--others', '--exclude-standard', '-z']))
    .split('\0')
    .filter(Boolean);
  const files = [...new Set([...tracked, ...untracked])].sort();
  requireThat(files.length <= 100, 409, '变更超过 100 个文件，请在本地拆分检查后再验收');
  const fingerprint = createHash('sha256').update(base);
  const artifacts: Artifact[] = [];
  let bytes = 0;
  for (const file of files) {
    const path = resolve(directory, file);
    const rel = relative(directory, path);
    requireThat(rel && !rel.startsWith('..') && !isAbsolute(rel), 400, '文件路径超出项目');
    const stat = await lstat(path).catch(() => null);
    let content = Buffer.from('');
    if (stat) {
      requireThat(
        !stat.isSymbolicLink() && stat.isFile(),
        409,
        `请在本地检查链接或特殊文件：${file}`,
      );
      const actual = await realpath(path);
      requireThat(!relative(directory, actual).startsWith('..'), 400, '文件链接超出项目');
      requireThat(stat.size <= 1024 * 1024, 409, `文件超过 1MB，请在本地检查：${file}`);
      content = await readFile(path);
    }
    fingerprint
      .update(file)
      .update(stat ? 'exists' : 'deleted')
      .update(content);
    let patch = tracked.includes(file)
      ? await git(directory, [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          base,
          '--',
          file,
        ])
      : `--- /dev/null\n+++ b/${file}\n@@ new file @@\n${content
          .toString('utf8')
          .split('\n')
          .map((l) => `+${l}`)
          .join('\n')}`;
    bytes += Buffer.byteLength(patch);
    requireThat(bytes <= 2 * 1024 * 1024, 409, '变更超过 2MB，请在本地检查');
    const sensitive = /(^\.env($|\.)|\.(pem|key|p12)$|^auth\.json$|^credentials)/i.test(
      basename(file),
    );
    const lines = patch.split('\n');
    const additions = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    const deletions = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
    if (sensitive || content.includes(0)) patch = '[敏感或二进制文件内容未展示；请在本地检查]';
    artifacts.push({
      file,
      patch: redact(patch),
      additions,
      deletions,
      status: !stat ? 'deleted' : untracked.includes(file) ? 'added' : 'modified',
    });
  }
  return { artifacts, artifactHash: fingerprint.digest('hex') };
}
