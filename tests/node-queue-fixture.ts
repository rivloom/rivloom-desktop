import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { NodeQueueStore } from '../server/node-queue.ts';
import type { NodeQueueSource } from '../shared/node-queue.ts';

export const localSource = (): NodeQueueSource => ({ kind: 'local', taskID: randomUUID() });
export const remoteSource = (): NodeQueueSource => ({
  kind: 'remote',
  remoteTaskID: randomUUID(),
  ownerNodeID: 'a'.repeat(32),
  ownerBrainID: randomUUID(),
});
export function queueFixture() {
  const root = resolve('.data/verification');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'm35-queue-unit-'));
  const path = join(directory, 'rivloom.sqlite');
  let clock = Date.parse('2026-09-05T06:00:00Z');
  let db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');
  let store = new NodeQueueStore(db, { clock: () => clock });
  return {
    directory,
    get db() {
      return db;
    },
    get store() {
      return store;
    },
    get now() {
      return clock;
    },
    advance(ms: number) {
      clock += ms;
    },
    reopen() {
      db.close();
      db = new DatabaseSync(path);
      store = new NodeQueueStore(db, { clock: () => clock });
      return store;
    },
    close() {
      db.close();
    },
  };
}
