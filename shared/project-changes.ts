export type ProjectChangeFile = { path: string; index: string; worktree: string; untracked: boolean; conflict: boolean };
export type ProjectChanges = {
  state: 'ready' | 'not-repository' | 'unavailable' | 'too-large';
  branch: string | null;
  files: ProjectChangeFile[];
  truncated: boolean;
  checkedAt: string;
};
export type ProjectDiff = {
  path: string;
  area: 'staged' | 'working';
  state: 'ready' | 'sensitive' | 'binary' | 'too-large' | 'restricted' | 'changed';
  kind: 'patch' | 'file';
  text: string;
};
export const projectChangeLimit = 500;
export const projectDiffByteLimit = 256 * 1024;
export function validProjectChangePath(path: string): boolean {
  return path.length > 0 && path.length <= 2000 && !/[\0\\]/.test(path) && !path.startsWith('/') &&
    !/^[a-z]:/i.test(path) && path.split('/').every(part => !!part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}
export function sensitiveProjectChangePath(path: string): boolean {
  return /(?:^|\/)\.docker\/config\.json$/i.test(path) || path.split('/').some(part =>
    /^(?:\.env(?:\..*)?|\.(?:npmrc|pypirc|netrc|git-credentials|aws|ssh|gnupg)|_netrc|auth\.json|credentials(?:\..*)?|id_(?:rsa|dsa|ed25519|ecdsa)(?:\..*)?)$/i.test(part) ||
    /\.(?:pem|key|p12|pfx|keystore|jks|kdbx)$/i.test(part));
}
/** Porcelain v1 -z is unquoted, including whitespace and Unicode filenames. */
export function parseProjectStatus(raw: string, prefix = ''): Pick<ProjectChanges, 'branch' | 'files' | 'truncated'> {
  const records = raw.split('\0'); const files: ProjectChangeFile[] = []; let branch: string | null = null, truncated = false;
  for (let i = 0; i < records.length; i++) {
    const entry = records[i];
    if (entry.startsWith('## ')) { branch = entry.slice(3).replace(/^(?:No commits yet on|Initial commit on) /, '').split('...')[0].slice(0, 200); continue; }
    if (entry.length < 4 || entry[2] !== ' ') continue;
    const index = entry[0], worktree = entry[1], fullPath = entry.slice(3);
    if ('RC'.includes(index) || 'RC'.includes(worktree)) i++; // The source of a rename follows its destination.
    if (!fullPath.startsWith(prefix)) continue;
    const path = fullPath.slice(prefix.length);
    if (!validProjectChangePath(path) || (index === '!' && worktree === '!')) continue;
    if (files.length >= projectChangeLimit) { truncated = true; continue; }
    files.push({ path, index, worktree, untracked: index === '?' && worktree === '?',
      conflict: index === 'U' || worktree === 'U' || (index === 'A' && worktree === 'A') || (index === 'D' && worktree === 'D') });
  }
  return { branch, files, truncated };
}
