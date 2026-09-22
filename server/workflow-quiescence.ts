import { execFile } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';

export type WorkflowToolRecord = { tool: string; state: { status: string; input?: Record<string, unknown> } };
export type QuiescenceEvidence = { confirmed: boolean; reason: string };
type QuiescenceOptions = {
  directory: string; tools: WorkflowToolRecord[];
  mediaProcesses?: () => Promise<number>;
  trustedMediaBinary?: (file: string, directory: string) => Promise<boolean>;
};
const inDirectory = (root: string, file: string) => { const path = relative(root, file); return path === '' || !path.startsWith('..') && !isAbsolute(path); };
async function trustedMediaBinary(file: string, directory: string) {
  try {
    if (!isAbsolute(file) || !/^ff(?:mpeg|probe)(?:\.exe)?$/i.test(basename(file))) return false;
    const canonical = await realpath(file); const info = await lstat(file);
    return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 &&
      !inDirectory(await realpath(directory), canonical) && resolve(canonical).toLowerCase() === resolve(file).toLowerCase();
  } catch { return false; }
}
/** An exact foreground adapter, deliberately excluding shells, scripts and command composition. */
function mediaBinary(command: string): string | null {
  const text = command.trim();
  if (/[\r\n;|`$<>]/.test(text) || /(?:^|\s)(?:start|nohup|screen|tmux|at|schtasks)\b/i.test(text)) return null;
  const invocation = text.startsWith('& ') ? text.slice(2).trimStart() : text;
  if (invocation.includes('&')) return null;
  const match = /^(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+))(?:\s|$)/.exec(invocation);
  return match ? match[1] || match[2] || match[3] : null;
}
export async function linuxMediaProcessCount(): Promise<number> {
  const entries = (await readdir('/proc')).filter(name => /^[1-9]\d*$/.test(name));
  if (entries.length > 50_000) throw new Error('workflow_process_audit_unavailable');
  let count = 0;
  for (const pid of entries) {
    try {
      const name = (await readFile(`/proc/${pid}/comm`, 'utf8')).trim();
      if (name === 'ffmpeg' || name === 'ffprobe') count++;
    } catch (error) {
      // A process can exit between enumeration and read. Permission/IO failures
      // cannot prove that media work has stopped, so keep the transfer blocked.
      if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code || ''))
        throw new Error('workflow_process_audit_unavailable');
    }
  }
  return count;
}
async function mediaProcessCount(): Promise<number> {
  if (process.platform === 'linux') return linuxMediaProcessCount();
  if (process.platform !== 'win32') throw new Error('workflow_process_audit_unavailable');
  const system = process.env.SystemRoot || 'C:\\Windows';
  const program = resolve(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    execFile(program, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "@(Get-Process -Name ffmpeg,ffprobe -ErrorAction SilentlyContinue).Count"],
    { windowsHide: true, timeout: 4000, maxBuffer: 4096 }, (error, stdout) => {
      if (error || !/^\d+\s*$/.test(stdout)) reject(new Error('workflow_process_audit_unavailable'));
      else resolve(Number(stdout.trim()));
    });
  });
}
/** Engine idle is checked by the caller. Opaque scripts cannot prove their external work has stopped. */
export async function checkWorkflowQuiescence(options: QuiescenceOptions): Promise<QuiescenceEvidence> {
  // Managed history/knowledge calls await their requests and finish any local writes before returning.
  // Materializing a Skill writes a verified file; it never starts a process or executes the Skill.
  const synchronous = new Set(['read', 'glob', 'grep', 'list', 'edit', 'write', 'apply_patch', 'todowrite', 'todoread', 'question',
    'StructuredOutput', 'rivloom_history', 'rivloom_context_note',
    'rivloom_knowledge_search', 'rivloom_knowledge_read', 'rivloom_memory_save']);
  let media = false;
  for (const tool of options.tools) {
    if (!['completed', 'error'].includes(tool.state.status)) return { confirmed: false, reason: 'workflow_tools_active' };
    if (synchronous.has(tool.tool)) continue;
    if (tool.tool !== 'bash' || typeof tool.state.input?.command !== 'string') return { confirmed: false, reason: 'workflow_external_work_unconfirmed' };
    const file = mediaBinary(tool.state.input.command);
    if (!file || !await (options.trustedMediaBinary || trustedMediaBinary)(file, options.directory))
      return { confirmed: false, reason: 'workflow_external_work_unconfirmed' };
    media = true;
  }
  if (media) {
    try {
      if (await (options.mediaProcesses || mediaProcessCount)()) return { confirmed: false, reason: 'workflow_media_process_active' };
    } catch { return { confirmed: false, reason: 'workflow_process_audit_unavailable' }; }
  }
  return { confirmed: true, reason: media ? 'foreground_media_completed' : 'synchronous_tools_completed' };
}
