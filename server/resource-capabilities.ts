import { execFile } from 'node:child_process';
import { access, realpath, lstat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { SoftwareEvidence } from '../shared/resources.ts';
import { jsonBytes } from '../shared/collaboration.ts';

/** Coalesce file-change scans without skipping the catalog's minute-by-minute probe. */
export class ResourceCapabilityCache {
  private cached: { key: string; until: number; value: SoftwareEvidence[] } | null = null;
  private generation = 0;
  private clock: () => number;
  constructor(clock: () => number = Date.now) { this.clock = clock; }
  async get(key: string, probe: () => Promise<SoftwareEvidence[]>): Promise<SoftwareEvidence[]> {
    const startedAt = this.clock();
    if (this.cached?.key === key && this.cached.until > startedAt) return this.cached.value;
    const generation = ++this.generation;
    const value = await probe();
    // A 60s cache plus a 60s catalog interval can retain the same observation for
    // 120s, then expire on peers before their next sync. Do not extend probe age.
    if (this.generation === generation) this.cached = { key, until: startedAt + 30_000, value };
    return value;
  }
}

const probes = [
  { id: 'ffmpeg', name: 'FFmpeg', args: ['-version'] },
  { id: 'ffprobe', name: 'FFprobe', args: ['-version'] },
  { id: 'python', name: 'Python', args: ['--version'] },
  { id: 'git', name: 'Git', args: ['--version'] },
  { id: 'node', name: 'Node.js', args: ['--version'] },
] as const;
function contained(root: string, path: string) {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
/** Resolve only fixed executables outside the selected workspace. Never execute project scripts. */
async function executable(name: string, workspace: string) {
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (!isAbsolute(directory) || contained(workspace, resolve(directory))) continue;
    const path = join(directory, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
    try {
      await access(path);
      if (!(await lstat(path)).isFile() && !(await lstat(path)).isSymbolicLink()) continue;
      const canonical = await realpath(path);
      if (!contained(workspace, canonical)) return canonical;
    } catch { /* A missing optional adapter is normal. */ }
  }
  return null;
}
export async function probeResourceCapabilities(workspace: string, cwd: string,
  models: { id: string; name: string }[], run = (file: string, args: readonly string[]): Promise<string> => new Promise((resolve, reject) => {
    execFile(file, [...args], { cwd, timeout: 2500, maxBuffer: 8192, windowsHide: true },
      (error, stdout, stderr) => error ? reject(error) : resolve(stdout || stderr));
  })): Promise<SoftwareEvidence[]> {
  const checkedAt = new Date().toISOString();
  const result: SoftwareEvidence[] = [];
  // Two probes at a time; tool discovery must not compete with execution for an unbounded process burst.
  for (let offset = 0; offset < probes.length; offset += 2) {
    result.push(...await Promise.all(probes.slice(offset, offset + 2).map(async (probe): Promise<SoftwareEvidence> => {
      const base = { id: probe.id, name: probe.name, kind: 'software' as const, checkedAt };
      const file = await executable(probe.id, workspace);
      if (!file) return { ...base, status: 'unavailable', version: null };
      try {
        const output = await run(file, probe.args);
        const version = output.split(/[\r\n]/).find((line) => line.trim())?.replace(/[\u0000-\u001f]/g, '').slice(0, 160) || null;
        return { ...base, status: 'available', version };
      } catch { return { ...base, status: 'unknown', version: null }; }
    })));
  }
  const evidence = [...result, ...models.slice(0, 35).map((model): SoftwareEvidence => ({ id: model.id.slice(0, 200), name: model.name.slice(0, 120),
    kind: 'model', status: 'available', version: null, checkedAt }))];
  while (jsonBytes(evidence) > 10_000) evidence.pop();
  return evidence;
}
