import { execFile, spawn } from 'node:child_process';
import { lstatSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const pid = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const identity = row => `${row.pid}:${row.created}`;
const same = (a, b) => !!a && !!b && a.created !== null && b.created !== null && identity(a) === identity(b);
const newer = (a, b) => a.created !== null && b.created !== null && BigInt(a.created) >= BigInt(b.created);

export function macosProcessHelper() {
  for (const url of [new URL('../native/rivloom-process', import.meta.url),
    new URL('../src-tauri/resources/runtime/native/rivloom-process', import.meta.url)]) {
    const path = fileURLToPath(url);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111))
        throw new Error('macOS process helper is not a regular executable.');
      return path;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('macOS process helper is unavailable.');
}

function query(mode, timeoutMs) {
  if (process.platform !== 'darwin') return Promise.reject(new Error('Native macOS process query required.'));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 4000)
    return Promise.reject(new Error('Invalid macOS process query deadline.'));
  return new Promise((ok, fail) => execFile(macosProcessHelper(), [mode],
    { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
    (error, stdout) => error ? fail(new Error('macOS process inventory is unavailable.')) : ok(stdout)));
}

export function macosProcessSnapshot(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.processes) ||
      !value.processes.length || value.processes.length > 32768)
    throw new Error('macOS process inventory is incomplete.');
  const seen = new Set();
  return value.processes.map(row => {
    if (!row || !pid(row.pid) || !nonnegative(row.parentPid) || !nonnegative(row.group) ||
        !pid(row.session) || !nonnegative(row.uid) || typeof row.zombie !== 'boolean' ||
        (row.created !== null && (typeof row.created !== 'string' || !/^[1-9]\d{12,19}$/.test(row.created))) || seen.has(row.pid))
      throw new Error('macOS process identity is incomplete or ambiguous.');
    seen.add(row.pid);
    return { pid: row.pid, parentPid: row.parentPid, group: row.group, session: row.session,
      uid: row.uid, created: row.created, zombie: row.zombie };
  });
}

export async function readMacosProcesses(timeoutMs = 1000) {
  return macosProcessSnapshot(JSON.parse(await query('snapshot', timeoutMs)));
}

export async function macosMediaProcessCount() {
  const output = await query('media', 4000);
  if (!/^(0|[1-9]\d{0,4})\n$/.test(output)) throw new Error('workflow_process_audit_unavailable');
  return Number(output.trim());
}

// The helper stays alive as the private session/group leader while the engine
// runs. Only that leader can signal its own group. Recorded creation stamps are
// used for observations, never converted into an external numeric kill target.
export class MacosProcessOwnership {
  constructor(rows, groupPID, hostPID, rootPID) {
    rows = macosProcessSnapshot({ schemaVersion: 1, processes: rows });
    const leader = rows.find(row => row.pid === groupPID), root = rows.find(row => row.pid === rootPID);
    if (!pid(groupPID) || !pid(hostPID) || !pid(rootPID) || groupPID === rootPID || !leader || !root ||
        leader.zombie || root.zombie || leader.parentPid !== hostPID || leader.group !== groupPID ||
        leader.session !== groupPID || root.parentPid !== groupPID || root.group !== groupPID ||
        root.session !== groupPID || root.uid !== leader.uid || !newer(root, leader))
      throw new Error('macOS owned process identity could not be established.');
    this.leader = leader;
    this.root = root;
    this.recorded = new Map([[identity(leader), leader], [identity(root), root]]);
    this.uncertain = false;
    this.observe(rows);
  }

  observe(input) {
    const rows = macosProcessSnapshot({ schemaVersion: 1, processes: input });
    const current = new Map(rows.map(row => [row.pid, row]));
    const leader = current.get(this.leader.pid);
    if (leader && !same(leader, this.leader)) this.uncertain = true;
    const owned = new Map();
    for (const recorded of this.recorded.values()) {
      const row = current.get(recorded.pid);
      if (row && (row.created === null || BigInt(row.created) < BigInt(recorded.created))) this.uncertain = true;
      if (same(recorded, row)) owned.set(row.pid, row);
    }
    for (const row of rows) {
      if (row.session !== this.leader.pid) continue;
      if (!newer(row, this.leader) || row.uid !== this.leader.uid) this.uncertain = true;
      else owned.set(row.pid, row);
    }
    // A live parent's creation stamp must still match before following parentPid.
    // A recycled PID cannot attach unrelated work to a historical parent.
    for (let count = -1; count !== owned.size;) {
      count = owned.size;
      for (const row of rows) {
        const parent = owned.get(row.parentPid);
        if (parent && row.created === null) this.uncertain = true;
        if (parent && !parent.zombie && newer(row, parent)) owned.set(row.pid, row);
      }
    }
    for (const row of owned.values()) {
      this.recorded.set(identity(row), row);
      // Moving into a different group/session is outside the controlled kill
      // boundary. Remember that gap even if this row later vanishes; unseen
      // daemonized descendants must not be certified as stopped.
      if (row.group !== this.leader.pid || row.session !== this.leader.pid || row.uid !== this.leader.uid)
        this.uncertain = true;
    }
    if (this.recorded.size > 32768) this.uncertain = true;
    const running = [...owned.values()].filter(row => !row.zombie);
    return { running: running.length, childrenRunning: running.filter(row => !same(row, this.leader)).length,
      leaderRunning: running.some(row => same(row, this.leader)), uncertain: this.uncertain,
      recorded: this.recorded.size };
  }
}

export function parseMacosLifecycle(value, groupPID) {
  if (!value || value.schemaVersion !== 1 || !['ready', 'engine-exit', 'stopping'].includes(value.event) ||
      value.groupPID !== groupPID || !pid(value.rootPID) || value.rootPID === groupPID ||
      !nonnegative(value.code) || value.code > 255 || (value.event !== 'engine-exit' && value.code !== 0))
    throw new Error('Invalid macOS lifecycle receipt.');
  return { event: value.event, rootPID: value.rootPID, code: value.code };
}

// Factored for deadline/unknown-state tests. Queries are sequential and must
// finish within the same total deadline; late or failed evidence cannot pass.
export async function waitForMacosExit(ownership, options) {
  const now = options.now || (() => performance.now());
  const wait = options.wait || delay;
  const timeoutMs = options.timeoutMs ?? 5800;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 5800) throw new Error('Invalid macOS stop deadline.');
  const deadline = now() + timeoutMs;
  const result = () => ({ stopped: false, proof: 'unproven', recorded: ownership.recorded.size });
  let quitSent = false;
  while (now() < deadline) {
    let state;
    try {
      state = ownership.observe(await options.snapshot(Math.min(1000, Math.floor(deadline - now()))));
    } catch { ownership.uncertain = true; return result(); }
    if (now() >= deadline || state.uncertain) return result();
    const status = options.status();
    if (status.exited && state.running === 0 && status.expected)
      return { stopped: true, proof: 'observed-exit', recorded: state.recorded };
    if (!quitSent && state.childrenRunning === 0 && state.leaderRunning && status.engineExited) {
      quitSent = true;
      try { options.quit(); } catch { ownership.uncertain = true; return result(); }
    }
    await wait(Math.min(100, Math.max(1, deadline - now())));
  }
  return result();
}

export async function runMacosEngineHost(command) {
  let stopping = false, requestedExit = 1, engineExited = false, childExited = false;
  let stopAt = performance.now();
  let expectedExit = false, invalid = false, rootPID, readyResolve, readyReject;
  let nativeStatus = '', readySeen = false, ownership;
  const ready = new Promise((ok, fail) => { readyResolve = ok; readyReject = fail; });
  const child = spawn(macosProcessHelper(), ['run', ...command], {
    env: process.env, cwd: process.cwd(), detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  const stop = (code = 0) => {
    if (stopping) return;
    stopping = true; requestedExit = code; stopAt = performance.now();
    if (!childExited) child.stdin.write('T', () => {});
  };
  const parentStopped = () => stop(0);
  process.on('disconnect', parentStopped);
  process.on('SIGTERM', parentStopped);
  process.on('SIGINT', parentStopped);
  child.stdin.on('error', () => { if (!stopping) { invalid = true; stop(1); } });
  child.on('error', () => { invalid = true; readyReject(new Error('macOS process owner failed to start.')); });
  child.on('exit', (code, signal) => {
    childExited = true;
    expectedExit = stopping && (code === 0 || signal === 'SIGKILL');
    if (!expectedExit) invalid = true;
    if (!readySeen) readyReject(new Error('macOS process owner exited before identity capture.'));
    if (!stopping) stop(1);
  });
  child.stdio[3].on('data', data => {
    try {
      nativeStatus += data.toString();
      if (nativeStatus.length > 2048) throw new Error('Oversized lifecycle receipt.');
      for (let end; (end = nativeStatus.indexOf('\n')) !== -1;) {
        const value = parseMacosLifecycle(JSON.parse(nativeStatus.slice(0, end)), child.pid);
        nativeStatus = nativeStatus.slice(end + 1);
        if (rootPID !== undefined && value.rootPID !== rootPID) throw new Error('Changed engine identity.');
        rootPID = value.rootPID;
        if (value.event === 'ready') {
          if (readySeen) throw new Error('Duplicate lifecycle receipt.');
          readySeen = true; readyResolve(value.rootPID);
        } else if (!readySeen) throw new Error('Unordered lifecycle receipt.');
        else if (value.event === 'engine-exit') {
          if (engineExited) throw new Error('Duplicate engine exit receipt.');
          engineExited = true; stop(value.code);
        }
        else if (!stopping) stop(1);
      }
    } catch { invalid = true; readyReject(new Error('Invalid macOS lifecycle receipt.')); stop(1); }
  });
  child.stdio[3].on('end', () => { if (nativeStatus.length) { invalid = true; stop(1); } });
  if ('connected' in process && !process.connected) stop(0);
  const startup = setTimeout(() => { invalid = true; readyReject(new Error('macOS process owner startup timed out.')); stop(1); }, 4000);
  try {
    await ready;
    ownership = new MacosProcessOwnership(await readMacosProcesses(), child.pid, process.pid, rootPID);
    clearTimeout(startup);
    if (!stopping) child.stdin.write('G', () => {});
    while (!stopping) {
      await delay(150);
      if (stopping) break;
      try { if (ownership.observe(await readMacosProcesses()).uncertain) { invalid = true; stop(1); } }
      catch { invalid = true; stop(1); }
    }
    if (invalid) ownership.uncertain = true;
    const result = await waitForMacosExit(ownership, {
      snapshot: readMacosProcesses,
      status: () => ({ exited: childExited, expected: expectedExit && !invalid, engineExited }),
      quit: () => { if (!childExited) child.stdin.write('Q', () => {}); },
    });
    try { writeSync(2, `RIVLOOM_ENGINE_STOP ${JSON.stringify({ phase: 'result', outcome: result.stopped ? 'ok' : 'failed',
      durationMs: Math.round(performance.now() - stopAt), proof: result.proof, recorded: result.recorded })}\n`); } catch { /* Best effort only. */ }
    return result.stopped ? requestedExit : 1;
  } catch { return 1; }
  finally {
    clearTimeout(startup);
    // EOF also closes the native owner's group when this JS host crashes. No
    // fallback signal is sent to a stale PID after a failed inventory.
    child.stdin.end();
    process.off('disconnect', parentStopped);
    process.off('SIGTERM', parentStopped);
    process.off('SIGINT', parentStopped);
  }
}
