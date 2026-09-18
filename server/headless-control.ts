import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readPrivateFile, writePrivateFile } from './private-storage.ts';

export type HeadlessControl = { version: 1; pid: number; url: string; token: string };

export function parseHeadlessControl(value: unknown): HeadlessControl {
  const record = value as Partial<HeadlessControl> | null;
  if (!record || record.version !== 1 || !Number.isInteger(record.pid) || record.pid! <= 0 ||
      typeof record.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(record.token) ||
      typeof record.url !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(record.url) ||
      Number(new URL(record.url).port) > 65535)
    throw new Error('Invalid Rivloom local control record. Restart rivloom serve.');
  return record as HeadlessControl;
}

export function publishHeadlessControl(root: string, url: string, token: string) {
  const path = join(root, 'headless-control.json');
  const record = parseHeadlessControl({ version: 1, pid: process.pid, url, token });
  const serialized = JSON.stringify(record);
  writePrivateFile(path, serialized);
  const remove = () => {
    try { if (existsSync(path) && readPrivateFile(path) === serialized) unlinkSync(path); } catch { /* Never remove a replacement record. */ }
  };
  process.once('exit', remove);
  return remove;
}
