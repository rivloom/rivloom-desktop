import { openSync, readFileSync, writeFileSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataRoot } from './engine.ts';

// One owner per local workspace; this is deliberately not a distributed scheduler.
export function acquireDataLock() {
  const path = join(dataRoot, 'app.lock');
  const mine = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
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
      const pid = (JSON.parse(existing) as { pid: number }).pid;
      if (!Number.isInteger(pid) || pid <= 0)
        throw new Error('工作区锁文件无效，请确认没有运行实例后再检查 app.lock。');
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
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
