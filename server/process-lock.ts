import { openSync, readFileSync, writeFileSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataRoot } from './engine.ts';

export function linuxProcessIdentity(pid = process.pid) {
  const bootID = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  // comm may contain spaces and parentheses. Fields after its final ')' begin at 3.
  const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
  const startTime = fields[19];
  if (!/^[0-9a-f-]{36}$/i.test(bootID) || !/^\d+$/.test(startTime || ''))
    throw new Error('Unable to identify the Linux process holding this workspace.');
  return { bootID, startTime };
}

// One owner per local workspace; this is deliberately not a distributed scheduler.
export function acquireDataLock(root = dataRoot) {
  const path = join(root, 'app.lock');
  const mine = JSON.stringify({ pid: process.pid, nonce: randomUUID(),
    ...(process.platform === 'linux' ? { linux: linuxProcessIdentity() } : {}) });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(fd, mine);
      } finally {
        closeSync(fd);
      }
      process.once('exit', () => {
        try {
          if (readFileSync(path, 'utf8') === mine) unlinkSync(path);
        } catch {
          /* Already removed. */
        }
      });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = readFileSync(path, 'utf8');
      const owner = JSON.parse(existing) as { pid: number; linux?: { bootID: string; startTime: string } };
      const pid = owner.pid;
      if (!Number.isInteger(pid) || pid <= 0)
        throw new Error('工作区锁文件无效，请确认没有运行实例后再检查 app.lock。');
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
      }
      if (alive && process.platform === 'linux' && owner.linux) {
        if (!/^[0-9a-f-]{36}$/i.test(owner.linux.bootID) || !/^\d+$/.test(owner.linux.startTime))
          throw new Error('Invalid Linux workspace lock identity.');
        try {
          const actual = linuxProcessIdentity(pid);
          alive = actual.bootID === owner.linux.bootID && actual.startTime === owner.linux.startTime;
        } catch (error) {
          if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code || '')) alive = false;
          else throw error;
        }
      }
      if (alive)
        throw new Error(
          `同一数据目录已有运行实例 (PID ${pid})。请先关闭它，不要同时运行 dev/start。`,
        );
      if (readFileSync(path, 'utf8') === existing) unlinkSync(path);
    }
  }
  throw new Error('无法获取工作区锁，请稍后再试。');
}
