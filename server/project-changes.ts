import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, realpath, open, access } from 'node:fs/promises';
import { resolve, relative, sep, delimiter, isAbsolute, join, dirname } from 'node:path';
import { redact } from '../shared/redaction.ts';
import { parseProjectStatus, projectDiffByteLimit, sensitiveProjectChangePath, validProjectChangePath,
  type ProjectChanges, type ProjectDiff } from '../shared/project-changes.ts';

export class ProjectChangesError extends Error {
  readonly status: number;
  constructor(code: string, status = 409) { super(code); this.status = status; }
}
class GitOutputEncodingError extends Error {}
const baseArgs = ['--no-pager', '--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
  '-c', 'core.quotePath=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'submodule.recurse=false', '-c', 'protocol.allow=never',
  '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '-c', 'diff.autoRefreshIndex=false'];
export function projectGitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Keep platform essentials, not credentials, shell startup files or dynamic loader overrides.
  const environment = Object.fromEntries(Object.entries(source).filter(([key]) =>
    /^(?:path|home|systemroot|windir|comspec|pathext|userprofile|appdata|localappdata|programdata|programfiles|programfiles\(x86\)|systemdrive|temp|tmp|tmpdir)$/i.test(key)));
  for (const key of Object.keys(environment)) if (/^path$/i.test(key))
    environment[key] = (environment[key] || '').split(delimiter).filter(part => isAbsolute(part)).join(delimiter);
  return { ...environment, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_ATTR_NOSYSTEM: '1', LC_ALL: 'C', LANG: 'C' };
}
const noTrailingNewline = (text: string) => text.replace(/\r?\n$/, '');
const contained = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !/^(?:[a-z]:|[\\/])/i.test(rel)); };
const samePath = (left: string, right: string) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
let gitExecutable: Promise<string> | undefined;
async function findGitExecutable(): Promise<string> {
  const environment = projectGitEnvironment();
  const path = Object.entries(environment).find(([key]) => /^path$/i.test(key))?.[1] || '';
  for (const directory of path.split(delimiter).filter(Boolean)) {
    try {
      const candidate = await realpath(join(directory, process.platform === 'win32' ? 'git.exe' : 'git'));
      if ((await lstat(candidate)).isFile()) { await access(candidate, constants.X_OK); return candidate; }
    } catch { /* Try the next absolute executable search directory. */ }
  }
  throw new ProjectChangesError('project_changes_git_missing');
}
async function git(directory: string, flags: string[], args: string[], maxBuffer = 2 * 1024 * 1024): Promise<string> {
  // Never let the project cwd (or a relative PATH entry) choose the executable.
  const executable = await (gitExecutable ||= findGitExecutable().catch(error => { gitExecutable = undefined; throw error; }));
  return new Promise((done, fail) => execFile(executable, [...baseArgs, ...flags, ...args], {
    cwd: directory, env: projectGitEnvironment(), windowsHide: true, timeout: 10_000, maxBuffer, encoding: 'buffer',
  }, (error, stdout, stderr) => {
    if (error) return fail(Object.assign(error, { stderr: stderr.toString('utf8') }));
    // Decode only complete bounded output. Replacement characters could map a Git
    // filename to a different local file, or present corrupt diff bytes as real text.
    try { done(new TextDecoder('utf-8', { fatal: true }).decode(stdout)); }
    catch { fail(new GitOutputEncodingError('Invalid UTF-8 Git output')); }
  }));
}
function gitFailure(error: unknown): ProjectChanges['state'] {
  if (error instanceof ProjectChangesError && error.message === 'project_changes_not_repository') return 'not-repository';
  const err = error as { code?: string | number; stderr?: string };
  if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'too-large';
  if (/not a git repository/i.test(err.stderr || '')) return 'not-repository';
  return 'unavailable';
}
async function context(directory: string) {
  const canonical = await realpath(directory);
  // Registered project paths are canonical. A replaced root/parent link must not reauthorize a new directory.
  if (!samePath(canonical, resolve(directory)) || !(await lstat(canonical)).isDirectory()) throw new ProjectChangesError('project_changes_directory');
  // Discover the physical worktree marker, not core.worktree from repository config.
  // A .git file is normal for linked worktrees/submodules; a .git symlink is not followed.
  let worktree = canonical;
  for (;;) {
    try {
      const marker = await lstat(join(worktree, '.git'));
      if (marker.isSymbolicLink() || (!marker.isFile() && !marker.isDirectory())) throw new ProjectChangesError('project_changes_directory');
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
      const parent = dirname(worktree);
      if (parent === worktree) throw new ProjectChangesError('project_changes_not_repository');
      worktree = parent;
    }
  }
  const scope = [`--work-tree=${worktree}`];
  const gitDirectory = await realpath(noTrailingNewline(await git(canonical, scope, ['rev-parse', '--absolute-git-dir'])));
  scope.unshift(`--git-dir=${gitDirectory}`);
  const inside = relative(worktree, canonical).split(sep).join('/');
  const prefix = inside ? `${inside}/` : '';
  // Diff and status may run clean/process filters, even with --no-textconv.
  // Enumerate names without values and disable every repository-defined filter.
  let names = '';
  try { names = await git(canonical, scope, ['config', '--includes', '--null', '--name-only', '--get-regexp', '^filter\..*\.(clean|smudge|process|required)$'], 32 * 1024); }
  catch (error) { if ((error as { code?: number }).code !== 1) throw error; }
  const keys = names.split('\0').filter(Boolean);
  if (keys.length > 64 || keys.some(key => key.length > 200 || !/^filter\.[^=\r\n]+\.(?:clean|smudge|process|required)$/i.test(key)))
    throw new ProjectChangesError('project_changes_config');
  const flags = [...scope, ...keys.flatMap(key => ['-c', `${key}=${/\.required$/i.test(key) ? 'false' : ''}`])];
  return { canonical, prefix, flags };
}
async function inspectPath(root: string, path: string) {
  if (!samePath(root, await realpath(root))) return false;
  if (process.platform === 'win32' && path.split('/').some(part => /:|[. ]$/.test(part))) return false;
  let current = root;
  for (const part of path.split('/')) {
    current = resolve(current, part);
    if (!contained(root, current)) return false;
    try { const info = await lstat(current); if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || (info.isFile() && info.nlink > 1)) return false; }
    catch (error) { if ((error as { code?: string }).code === 'ENOENT') return true; throw error; }
  }
  try { return contained(root, await realpath(current)); } catch { return true; }
}
let readers = 0;
async function readOnly<T>(read: () => Promise<T>): Promise<T> {
  if (readers >= 3) throw new ProjectChangesError('project_changes_busy', 429);
  readers++;
  try { return await read(); } finally { readers--; }
}
export async function readProjectChanges(directory: string): Promise<ProjectChanges> {
  return readOnly(async () => {
    try {
      const { canonical, prefix, flags } = await context(directory);
      const raw = await git(canonical, flags, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all', '--ignore-submodules=all', '--no-renames', '--', '.']);
      return { state: 'ready', ...parseProjectStatus(raw, prefix), checkedAt: new Date().toISOString() };
    } catch (error) { return { state: gitFailure(error), branch: null, files: [], truncated: false, checkedAt: new Date().toISOString() }; }
  });
}
export async function readProjectDiff(directory: string, path: string, area: ProjectDiff['area']): Promise<ProjectDiff> {
  if (!validProjectChangePath(path) || !['working', 'staged'].includes(area)) throw new ProjectChangesError('project_changes_path', 400);
  const result = (state: ProjectDiff['state'], text = '', kind: ProjectDiff['kind'] = 'patch'): ProjectDiff => ({ path, area, state, text, kind });
  return readOnly(async () => {
    if (sensitiveProjectChangePath(path)) return result('sensitive');
    const { canonical, prefix, flags } = await context(directory);
    const raw = await git(canonical, flags, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all', '--no-renames', '--', path]);
    const entry = parseProjectStatus(raw, prefix).files.find(file => file.path === path);
    if (!entry || (area === 'staged' && (entry.index === ' ' || entry.untracked))) return result('changed');
    if (!await inspectPath(canonical, path)) return result('restricted');
    let text: string, kind: ProjectDiff['kind'] = 'patch';
    if (entry.untracked) {
      const target = resolve(canonical, path);
      const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const info = await file.stat();
        const atPath = await lstat(target);
        if (!info.isFile() || info.nlink > 1 || atPath.dev !== info.dev || atPath.ino !== info.ino || !await inspectPath(canonical, path)) return result('restricted');
        if (info.size > projectDiffByteLimit) return result('too-large');
        const bytes = Buffer.alloc(projectDiffByteLimit + 1); const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > projectDiffByteLimit) return result('too-large');
        const content = bytes.subarray(0, bytesRead);
        const after = await file.stat(), finalPath = await lstat(target);
        if (after.nlink > 1 || finalPath.dev !== info.dev || finalPath.ino !== info.ino || after.size !== info.size ||
          after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) return result('changed');
        if (content.includes(0)) return result('binary');
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(content); } catch { return result('binary'); }
        kind = 'file';
      } finally { await file.close(); }
    } else {
      try { text = await git(canonical, flags, ['diff', ...(area === 'staged' ? ['--cached'] : []), '--relative', '--no-renames',
        '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all', '--src-prefix=a/', '--dst-prefix=b/', '--unified=3', '--', path], projectDiffByteLimit); }
      catch (error) {
        if (gitFailure(error) === 'too-large') return result('too-large');
        if (error instanceof GitOutputEncodingError) return result('binary');
        throw error;
      }
      if (/^(?:Binary files |GIT binary patch)/m.test(text) || text.includes('\0')) return result('binary');
      if (/^(?:(?:old|new) mode |(?:new|deleted) file mode )(?:120000|160000)$/m.test(text)) return result('restricted');
    }
    if (!await inspectPath(canonical, path)) return result('restricted');
    if (text.split('\n').length > 5000) return result('too-large');
    return result('ready', redact(text), kind);
  });
}
