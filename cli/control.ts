import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { API } from './commands.ts';
import { parseHeadlessControl, type HeadlessControl } from '../server/headless-control.ts';
import { readPrivateFile } from '../server/private-storage.ts';
import { cliSystemText } from './localization.ts';

export const parseControl = parseHeadlessControl;

export function readControl(dataDir: string): HeadlessControl {
  const path = join(dataDir, 'headless-control.json');
  let stat;
  try { stat = lstatSync(path); } catch { throw new Error('Node is not running. Start rivloom serve with the same --data-dir.'); }
  if (!stat.isFile() || stat.size > 8192 || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error('Local control file must be a private regular file owned by this user (chmod 600).');
  let value: unknown;
  try { value = JSON.parse(readPrivateFile(path)); } catch { throw new Error('Invalid local control file. Restart rivloom serve.'); }
  return parseControl(value);
}

export class HeadlessClient implements API {
  private cookie = '';
  private readonly control: HeadlessControl;
  private readonly send: typeof fetch;
  constructor(control: HeadlessControl, send: typeof fetch = fetch) { this.control = control; this.send = send; }
  async connect(): Promise<void> {
    const response = await this.send(`${this.control.url}/api/auth/headless`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { 'x-rivloom-request': '1', 'x-rivloom-headless-token': this.control.token, 'content-type': 'application/json' }, body: '{}' });
    if (!response.ok) throw new Error(`Could not authenticate with the local node (HTTP ${response.status}). Restart rivloom serve.`);
    const cookie = response.headers.getSetCookie().map(item => item.split(';')[0]).find(item => item.startsWith('rivloom_session='));
    if (!cookie) throw new Error('Local node did not return a session cookie.');
    this.cookie = cookie;
    await response.arrayBuffer();
  }
  async request<T = unknown>(path: string, body?: unknown): Promise<T> {
    if (!this.cookie) throw new Error('Local node is not authenticated.');
    if (!/^\/api\/[A-Za-z0-9_/%-]+$/.test(path) || /%(?:2f|5c|2e)/i.test(path)) throw new Error('Invalid local API path.');
    const response = await this.send(`${this.control.url}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(90_000), headers: { cookie: this.cookie, 'x-rivloom-request': '1', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json() as { error?: unknown };
    if (!response.ok) {
      // Provider validation errors must never echo submitted credentials.
      const detail = path.startsWith('/api/model-settings/provider/') ? '' : typeof value.error === 'string' ? `: ${cliSystemText(value.error)}` : '';
      throw new Error(`Local request failed (HTTP ${response.status})${detail}`);
    }
    return value as T;
  }
  async close(): Promise<void> {
    if (!this.cookie) return;
    try { await this.send(`${this.control.url}/api/auth/logout`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3_000), headers: { cookie: this.cookie, 'x-rivloom-request': '1', 'content-type': 'application/json' }, body: '{}' }); } catch { /* A stopped server has no active local session to use. */ }
    this.cookie = '';
  }
}
