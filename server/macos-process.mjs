import { execFile, spawn } from 'node:child_process';
import { lstatSync, mkdtempSync, realpathSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const pid = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const identity = row => `${row.pid}:${row.created}`;
const birth = value => typeof value === 'string' && /^[1-9]\d{12,19}$/.test(value);
const same = (a, b) => !!a && !!b && a.created !== null && b.created !== null && identity(a) === identity(b);
const newer = (a, b) => a.created !== null && b.created !== null && BigInt(a.created) >= BigInt(b.created);
const nativeInventoryFailures = ['capacity', 'list', 'allocation', 'short-info', 'full-info-before', 'full-info-after',
  'session-before', 'session-after', 'birth-invalid', 'birth-changed', 'group-changed', 'uid-changed', 'output'];
const inventoryFailures = [...nativeInventoryFailures, 'query-timeout', 'query-output-limit', 'query-launch', 'query-failed', 'invalid-result'];
const hostFailures = ['none', 'inventory-unavailable', 'ownership-uncertain', 'owner-start', 'owner-exit', 'owner-pipe',
  'lifecycle-invalid', 'startup-timeout', 'engine-exit', 'stop-unproven', 'host-error'];
const ownershipFailures = ['initial-identity', 'leader-reused', 'recorded-birth-unavailable', 'recorded-birth-backwards',
  'session-birth-invalid', 'session-uid-changed', 'child-birth-unavailable', 'session-changed', 'group-changed',
  'uid-changed', 'record-limit', 'guard-identity', 'guard-transition', 'watchdog-identity'];

export function parseMacosInventoryFailure(line) {
  const prefix = 'RIVLOOM_PROCESS_INVENTORY_FAILURE ';
  if (typeof line !== 'string' || line.length > 256 || !line.startsWith(prefix)) return;
  try {
    const value = JSON.parse(line.slice(prefix.length));
    if (value && Object.keys(value).join(',') === 'reason' && nativeInventoryFailures.includes(value.reason)) return value.reason;
  } catch { /* Only the fixed native failure protocol is accepted. */ }
}

function inventoryError(reason) {
  const error = new Error('macOS process inventory is unavailable.');
  error.code = 'macos_process_inventory_unavailable';
  error.inventoryFailure = inventoryFailures.includes(reason) ? reason : 'query-failed';
  return error;
}

function inventoryFailure(error) {
  return inventoryFailures.includes(error?.inventoryFailure) ? error.inventoryFailure : 'query-failed';
}

export function parseMacosEngineStopDiagnostic(line) {
  const prefix = 'RIVLOOM_ENGINE_STOP ';
  if (typeof line !== 'string' || line.length > 768 || !line.startsWith(prefix)) return;
  try {
    const value = JSON.parse(line.slice(prefix.length));
    if (!value || value.phase !== 'result' || !['ok', 'failed'].includes(value.outcome) ||
        !nonnegative(value.durationMs) || !nonnegative(value.recorded) || value.recorded > 65536 ||
        !['observed-exit', 'unproven'].includes(value.proof) || !hostFailures.includes(value.failure) ||
        (value.outcome === 'ok') !== (value.proof === 'observed-exit')) return;
    const result = { phase: 'result', outcome: value.outcome, durationMs: value.durationMs,
      proof: value.proof, recorded: value.recorded, failure: value.failure };
    if ('inventoryFailure' in value) {
      if (!inventoryFailures.includes(value.inventoryFailure)) return;
      result.inventoryFailure = value.inventoryFailure;
    }
    if ('ownershipFailure' in value) {
      if (!ownershipFailures.includes(value.ownershipFailure)) return;
      result.ownershipFailure = value.ownershipFailure;
    }
    return result;
  } catch { return; }
}

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
  return new Promise((ok, fail) => {
    let helper;
    try { helper = macosProcessHelper(); } catch { fail(inventoryError('query-launch')); return; }
    execFile(helper, [mode], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) { ok(stdout); return; }
        const reason = parseMacosInventoryFailure(stderr) ||
          (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'query-output-limit'
            : error.killed ? 'query-timeout' : ['ENOENT', 'EACCES', 'EPERM'].includes(error.code) ? 'query-launch' : 'query-failed');
        fail(inventoryError(reason));
      });
  });
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
  const output = await query('snapshot', timeoutMs);
  try { return macosProcessSnapshot(JSON.parse(output)); }
  catch { throw inventoryError('invalid-result'); }
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
  constructor(rows, groupPID, hostPID, rootPID, watchdogPID = 0) {
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
    this.guards = new Map();
    this.lastGuardID = 0;
    this.ownerQuit = false;
    this.ownerStopping = false;
    if (watchdogPID) {
      this.watchdog = this.requireChild(rows, watchdogPID, leader);
      if (watchdogPID === rootPID) throw new Error('Invalid macOS watchdog identity.');
      this.recorded.set(identity(this.watchdog), this.watchdog);
    }
    this.observe(rows);
  }

  requireChild(rows, childPID, parent) {
    const child = rows.find(row => row.pid === childPID);
    if (!child || child.zombie || child.parentPid !== parent.pid || child.group !== parent.group ||
        child.session !== parent.session || child.uid !== parent.uid || !newer(child, parent))
      throw new Error('Invalid macOS controlled child identity.');
    return child;
  }

  registerGuard(receipt, input, cancelledBeforeStart = false) {
    const rows = macosProcessSnapshot({ schemaVersion: 1, processes: input });
    const root = rows.find(row => same(row, this.root));
    const observed = rows.find(row => row.pid === receipt.guardPID);
    // Before A there is no target and no authorized session transition. A
    // native cancellation receipt can therefore be reconciled with a vanished
    // peer, while its original birth still prevents attaching a reused PID.
    const guard = cancelledBeforeStart && (!observed || observed.created !== receipt.created)
      ? { pid: receipt.guardPID, created: receipt.created, parentPid: this.root.pid, group: this.leader.pid,
        session: this.leader.pid, uid: this.leader.uid, zombie: true } : observed;
    if (this.uncertain || !root || root.zombie || receipt.id !== this.lastGuardID + 1 || this.guards.size >= 256 ||
        !guard || (!cancelledBeforeStart && guard.zombie) || guard.created !== receipt.created || guard.parentPid !== root.pid ||
        guard.group !== this.leader.pid || guard.session !== this.leader.pid || guard.uid !== this.leader.uid ||
        !newer(guard, root) || [...this.guards.values()].some(item => item.leader.pid === guard.pid))
      throw new Error('Invalid macOS guard registration identity.');
    this.guards.set(receipt.id, { id: receipt.id, leader: guard, stage: 'registered', closed: false,
      stopping: false, exited: false, quitSent: false, authorized: false, rootPID: 0, watchdogPID: 0 });
    this.lastGuardID = receipt.id;
    this.recorded.set(identity(guard), guard);
    this.observe(rows);
  }

  authorizeGuard(id) {
    const guard = this.guards.get(id);
    if (!guard || guard.authorized || guard.closed || guard.stopping) throw new Error('Invalid macOS guard authorization.');
    guard.authorized = true;
  }

  activateGuard(receipt, input, cancelledBeforeExecution = false) {
    const rows = macosProcessSnapshot({ schemaVersion: 1, processes: input });
    const guard = this.guards.get(receipt.id);
    const leader = rows.find(row => row.pid === receipt.guardPID);
    if (!guard || !guard.authorized || guard.stage !== 'registered' || guard.closed ||
        (!cancelledBeforeExecution && (!leader || leader.zombie)) ||
        (leader && (!same(leader, guard.leader) || leader.group !== leader.pid || leader.session !== leader.pid || leader.uid !== this.leader.uid)))
      throw new Error('Invalid macOS guard session transition.');
    const child = childPID => {
      const row = rows.find(item => item.pid === childPID);
      if (!cancelledBeforeExecution) return this.requireChild(rows, childPID, leader);
      if (row && (row.group !== guard.leader.pid || row.session !== guard.leader.pid || row.uid !== this.leader.uid ||
          !newer(row, guard.leader) || (leader && !leader.zombie && row.parentPid !== guard.leader.pid)))
        throw new Error('Invalid macOS cancelled target identity.');
      return row;
    };
    const root = child(receipt.guardRootPID), watchdog = child(receipt.watchdogPID);
    if (receipt.guardRootPID === receipt.watchdogPID) throw new Error('Invalid macOS guard watchdog identity.');
    guard.root = root; guard.watchdog = watchdog;
    guard.rootPID = receipt.guardRootPID; guard.watchdogPID = receipt.watchdogPID;
    guard.stage = cancelledBeforeExecution ? 'gated-cancelled' : 'active';
    if (root) this.recorded.set(identity(root), root);
    if (watchdog) this.recorded.set(identity(watchdog), watchdog);
    this.observe(rows);
  }

  guardEvent(receipt) {
    const guard = this.guards.get(receipt.id);
    if (!guard || guard.leader.pid !== receipt.guardPID || guard.closed ||
        receipt.guardRootPID !== guard.rootPID || receipt.watchdogPID !== guard.watchdogPID)
      throw new Error('Invalid macOS guard lifecycle identity.');
    if (receipt.event === 'guard-engine-exit') {
      if (!['active', 'gated-cancelled'].includes(guard.stage) || guard.exited) throw new Error('Invalid macOS guard exit ordering.');
      guard.exited = true;
    } else if (receipt.event === 'guard-stopping') {
      if (guard.stopping) throw new Error('Duplicate macOS guard stop.');
      guard.stopping = true;
    } else if (receipt.event === 'guard-closed') {
      if (!guard.stopping) this.markUncertain('guard-identity');
      guard.closed = true;
    }
    else throw new Error('Invalid macOS guard event.');
  }

  guardQuits() {
    const ids = [];
    for (const guard of this.guards.values()) {
      if (guard.closed || guard.quitSent || !guard.exited || !guard.stopping) continue;
      const live = this.current.filter(row => !row.zombie && row.session === guard.leader.pid);
      if (live.every(row => same(row, guard.leader) || same(row, guard.watchdog))) {
        guard.quitSent = true;
        ids.push(guard.id);
      }
    }
    return ids;
  }

  markUncertain(reason) {
    this.uncertain = true;
    this.ownershipFailure ||= reason;
  }

  observe(input) {
    const rows = macosProcessSnapshot({ schemaVersion: 1, processes: input });
    const current = new Map(rows.map(row => [row.pid, row]));
    this.current = rows;
    const leader = current.get(this.leader.pid);
    if (leader && !same(leader, this.leader)) this.markUncertain('leader-reused');
    const owned = new Map();
    for (const recorded of this.recorded.values()) {
      const row = current.get(recorded.pid);
      if (row && row.created === null) this.markUncertain('recorded-birth-unavailable');
      else if (row && BigInt(row.created) < BigInt(recorded.created)) this.markUncertain('recorded-birth-backwards');
      if (same(recorded, row)) owned.set(row.pid, row);
    }
    const sessions = new Map([[this.leader.pid, this.leader],
      ...[...this.guards.values()].filter(guard => guard.authorized).map(guard => [guard.leader.pid, guard.leader])]);
    for (const guard of this.guards.values()) {
      const live = current.get(guard.leader.pid);
      if (live && !same(live, guard.leader) && guard.authorized) this.markUncertain('leader-reused');
      if (guard.stage === 'active' && guard.watchdog && live && !live.zombie && !guard.quitSent && !guard.stopping &&
          (!same(current.get(guard.watchdog.pid), guard.watchdog) || current.get(guard.watchdog.pid)?.zombie)) this.markUncertain('watchdog-identity');
    }
    if (this.watchdog && leader && !leader.zombie && !this.ownerQuit && !this.ownerStopping &&
        (!same(current.get(this.watchdog.pid), this.watchdog) || current.get(this.watchdog.pid)?.zombie)) this.markUncertain('watchdog-identity');
    for (const row of rows) {
      const session = sessions.get(row.session);
      if (!session) continue;
      if (!newer(row, session)) this.markUncertain('session-birth-invalid');
      else if (row.uid !== session.uid) this.markUncertain('session-uid-changed');
      else owned.set(row.pid, row);
    }
    // A live parent's creation stamp must still match before following parentPid.
    // A recycled PID cannot attach unrelated work to a historical parent.
    for (let count = -1; count !== owned.size;) {
      count = owned.size;
      for (const row of rows) {
        const parent = owned.get(row.parentPid);
        if (parent && row.created === null) this.markUncertain('child-birth-unavailable');
        if (parent && !parent.zombie && newer(row, parent)) owned.set(row.pid, row);
      }
    }
    for (const row of owned.values()) {
      this.recorded.set(identity(row), row);
      // Moving into a different group/session is outside the controlled kill
      // boundary. Remember that gap even if this row later vanishes; unseen
      // daemonized descendants must not be certified as stopped.
      if (!sessions.has(row.session)) this.markUncertain('session-changed');
      else if (row.group !== row.session) this.markUncertain('group-changed');
      else if (row.uid !== this.leader.uid) this.markUncertain('uid-changed');
    }
    if (this.recorded.size > 32768) this.markUncertain('record-limit');
    const running = [...owned.values()].filter(row => !row.zombie);
    for (const [id, guard] of this.guards) {
      if (guard.closed && !running.some(row => row.session === guard.leader.pid || same(row, guard.leader))) this.guards.delete(id);
    }
    return { running: running.length, childrenRunning: running.filter(row => !same(row, this.leader) && !same(row, this.watchdog)).length,
      leaderRunning: running.some(row => same(row, this.leader)), uncertain: this.uncertain,
      recorded: this.recorded.size, ...(this.ownershipFailure ? { ownershipFailure: this.ownershipFailure } : {}) };
  }
}

export function parseMacosLifecycle(value, groupPID) {
  const events = ['ready', 'engine-exit', 'stopping', 'guard-register', 'guard-ready', 'guard-engine-exit', 'guard-stopping', 'guard-closed'];
  if (!value || value.schemaVersion !== 1 || !events.includes(value.event) ||
      value.groupPID !== groupPID || !pid(value.rootPID) || value.rootPID === groupPID ||
      !nonnegative(value.code) || value.code > 255 || (!['engine-exit', 'guard-engine-exit'].includes(value.event) && value.code !== 0))
    throw new Error('Invalid macOS lifecycle receipt.');
  const result = { event: value.event, rootPID: value.rootPID, code: value.code };
  if (value.event.startsWith('guard-')) {
    if (!pid(value.id) || value.id > 1000000 || !pid(value.guardPID) || [groupPID, value.rootPID].includes(value.guardPID))
      throw new Error('Invalid macOS guard receipt.');
    Object.assign(result, { id: value.id, guardPID: value.guardPID });
    if (value.event === 'guard-register') {
      if (!birth(value.created)) throw new Error('Invalid macOS guard birth receipt.');
      result.created = value.created;
    } else {
      if (!nonnegative(value.guardRootPID) || !nonnegative(value.watchdogPID) ||
          (value.guardRootPID && [groupPID, value.rootPID, value.guardPID, value.watchdogPID].includes(value.guardRootPID)) ||
          (value.watchdogPID && [groupPID, value.rootPID, value.guardPID].includes(value.watchdogPID)) ||
          (['guard-ready', 'guard-engine-exit'].includes(value.event) && (!value.guardRootPID || !value.watchdogPID)))
        throw new Error('Invalid macOS guarded target receipt.');
      Object.assign(result, { guardRootPID: value.guardRootPID, watchdogPID: value.watchdogPID });
    }
  } else if ('watchdogPID' in value) {
    if (!pid(value.watchdogPID) || [groupPID, value.rootPID].includes(value.watchdogPID)) throw new Error('Invalid macOS watchdog receipt.');
    result.watchdogPID = value.watchdogPID;
  }
  return result;
}

// Factored for deadline/unknown-state tests. Queries are sequential and must
// finish within the same total deadline; late or failed evidence cannot pass.
export async function waitForMacosExit(ownership, options) {
  const now = options.now || (() => performance.now());
  const wait = options.wait || delay;
  const timeoutMs = options.timeoutMs ?? 5800;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 5800) throw new Error('Invalid macOS stop deadline.');
  const deadline = now() + timeoutMs;
  const result = (failure = 'stop-unproven', error) => ({ stopped: false, proof: 'unproven', recorded: ownership.recorded.size,
    failure, ...(failure === 'inventory-unavailable' ? { inventoryFailure: inventoryFailure(error) } : {}),
    ...(ownership.ownershipFailure ? { ownershipFailure: ownership.ownershipFailure } : {}) });
  let quitSent = false;
  while (now() < deadline) {
    let state;
    try {
      const budget = Math.min(1000, Math.floor(deadline - now()));
      state = options.observe ? await options.observe(budget) : ownership.observe(await options.snapshot(budget));
    } catch (error) { ownership.uncertain = true; return result('inventory-unavailable', error); }
    if (now() >= deadline) return result();
    if (state.uncertain) return result('ownership-uncertain');
    const status = options.status();
    if (status.exited && state.running === 0 && status.expected)
      return { stopped: true, proof: 'observed-exit', recorded: state.recorded, failure: 'none' };
    if (!quitSent && state.childrenRunning === 0 && state.leaderRunning && status.engineExited) {
      quitSent = true;
      try { options.quit(); } catch { ownership.uncertain = true; return result('owner-pipe'); }
    }
    await wait(Math.min(100, Math.max(1, deadline - now())));
  }
  return result();
}

export async function runMacosEngineHost(command) {
  let stopping = false, requestedExit = 1, engineExited = false, childExited = false;
  let stopAt = performance.now();
  let expectedExit = false, invalid = false, rootPID, readyResolve, readyReject;
  let nativeStatus = '', readySeen = false, ownership, failure, queryFailure, ownershipFailure, watchdogPID;
  let inspecting = false, socketDirectory, socketPath;
  const inspections = [];
  const transitions = new Map(), receivedGuards = new Map(), ignoredRegistrations = new Set();
  const fail = (reason, error) => {
    invalid = true;
    failure ||= reason;
    if (reason === 'inventory-unavailable') queryFailure ||= inventoryFailure(error);
  };
  const report = result => {
    const value = { phase: 'result', outcome: result.stopped ? 'ok' : 'failed',
      durationMs: Math.round(performance.now() - stopAt), proof: result.proof, recorded: result.recorded,
      failure: failure || result.failure || (result.stopped ? 'none' : 'stop-unproven'),
      ...((queryFailure || result.inventoryFailure) ? { inventoryFailure: queryFailure || result.inventoryFailure } : {}),
      ...((ownershipFailure || ownership?.ownershipFailure || result.ownershipFailure)
        ? { ownershipFailure: ownershipFailure || ownership?.ownershipFailure || result.ownershipFailure } : {}) };
    try { writeSync(2, `RIVLOOM_ENGINE_STOP ${JSON.stringify(value)}\n`); } catch { /* Best effort only. */ }
  };
  let child;
  try {
    // A short, private directory also fits Darwin's bounded sockaddr_un path.
    socketDirectory = mkdtempSync('/tmp/rl-process-');
    const directory = lstatSync(socketDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || (directory.mode & 0o077))
      throw new Error('Invalid private macOS process directory.');
    socketPath = join(socketDirectory, 'control.sock');
    child = spawn(realpathSync(macosProcessHelper()), ['run', '--socket', socketPath, '--', ...command], {
      env: process.env, cwd: process.cwd(), detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
  } catch {
    fail('owner-start'); report({ stopped: false, proof: 'unproven', recorded: 0 }); return 1;
  }
  const ready = new Promise((ok, fail) => { readyResolve = ok; readyReject = fail; });
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  const stop = (code = 0) => {
    if (stopping) return;
    stopping = true; requestedExit = code; stopAt = performance.now();
    if (ownership) ownership.ownerStopping = true;
    if (!childExited) child.stdin.write('T', () => {});
  };
  const inspect = (action, registration = false) => {
    const task = new Promise((resolve, reject) => inspections.push({ action, registration, resolve, reject }));
    // Callers handling private lifecycle events do not await their inspection.
    task.catch(() => {});
    if (!inspecting) {
      inspecting = true;
      void (async () => {
        while (inspections.length) {
          // Completed commands must not wait behind a burst of new launches:
          // their native two-second cleanup deadline remains in force.
          const priority = inspections.findIndex(item => !item.registration);
          const [item] = inspections.splice(priority < 0 ? 0 : priority, 1);
          try { item.resolve(await item.action()); }
          catch (error) {
            fail(error?.code === 'macos_process_inventory_unavailable' ? 'inventory-unavailable' : 'lifecycle-invalid', error);
            stop(1); item.reject(error);
          }
        }
        inspecting = false;
      })();
    }
    return task;
  };
  const sendGuardQuits = () => {
    if (!ownership.uncertain && !childExited)
      for (const id of ownership.guardQuits()) child.stdin.write(`q${id}\n`, () => {});
  };
  const observe = timeout => inspect(async () => {
    const state = ownership.observe(await readMacosProcesses(timeout));
    sendGuardQuits();
    return state;
  });
  const cancellationEvidence = (state, deadline, error) => new Promise((ok, fail) => {
    if (state.cancelled) { ok(); return; }
    const notify = () => { clearTimeout(timer); ok(); };
    const timer = setTimeout(() => { state.listeners.delete(notify); fail(error); }, Math.max(1, deadline - performance.now()));
    state.listeners.add(notify);
  });
  const inspectGuardEvent = value => {
    void inspect(async () => {
      if (ignoredRegistrations.has(value.id)) {
        if (!['guard-stopping', 'guard-closed'].includes(value.event) || value.guardRootPID || value.watchdogPID)
          throw new Error('Unreleased macOS guard has a target.');
        if (value.event === 'guard-closed') { ignoredRegistrations.delete(value.id); receivedGuards.delete(value.id); }
        return;
      }
      ownership.guardEvent(value);
      if (value.event === 'guard-closed') receivedGuards.delete(value.id);
      const state = ownership.observe(await readMacosProcesses());
      if (state.uncertain) { fail('ownership-uncertain'); stop(1); }
      sendGuardQuits();
    });
  };
  const receiveGuard = value => {
    if (value.event === 'guard-register') {
      if (receivedGuards.has(value.id) || receivedGuards.size >= 1024) throw new Error('Invalid macOS pending guard registration.');
      receivedGuards.set(value.id, { cancelled: false, registered: false, pending: [], listeners: new Set() });
    } else {
      const state = receivedGuards.get(value.id);
      if (!state) throw new Error('Unregistered macOS guard receipt.');
      if (value.event !== 'guard-ready') {
        state.cancelled = true;
        for (const notify of state.listeners) notify();
        state.listeners.clear();
      }
    }
    if (value.event === 'guard-ready') {
      const transition = transitions.get(value.id);
      if (!transition || transition.received || transition.guardPID !== value.guardPID)
        throw new Error('Unexpected macOS guard readiness receipt.');
      transition.received = true; transition.resolve(value);
      return;
    }
    if (value.event === 'guard-closed') {
      const transition = transitions.get(value.id);
      if (transition && !transition.received) { transition.received = true; transition.resolve(value); }
    }
    if (value.event === 'guard-register') {
      void inspect(async () => {
        const state = receivedGuards.get(value.id);
        try {
        if (stopping) { ignoredRegistrations.add(value.id); return; }
        const registrationDeadline = performance.now() + 2000;
        const rows = await readMacosProcesses();
        if (stopping) { ignoredRegistrations.add(value.id); return; }
        try { ownership.registerGuard(value, rows, state.cancelled); }
        catch (error) {
          if (state.cancelled) throw error;
          await cancellationEvidence(state, registrationDeadline, error);
          if (stopping) { ignoredRegistrations.add(value.id); return; }
          ownership.registerGuard(value,
            await readMacosProcesses(Math.max(1, Math.min(1000, Math.floor(registrationDeadline - performance.now())))), true);
        }
        if (performance.now() >= registrationDeadline) throw new Error('macOS guard registration exceeded its deadline.');
        if (ownership.uncertain) throw new Error('Uncertain macOS guard registration.');
        if (stopping || state.cancelled) return;
        let resolve, reject;
        const ready = new Promise((ok, fail) => { resolve = ok; reject = fail; });
        const transition = { guardPID: value.guardPID, resolve, received: false };
        transitions.set(value.id, transition);
        const deadline = performance.now() + 2000;
        const timeout = setTimeout(() => reject(new Error('macOS guard transition timed out.')), 2000);
        try {
          // Keep the inspection chain locked through setsid: inventory's two
          // native identity reads must never straddle an authorized transition.
          ownership.authorizeGuard(value.id);
          child.stdin.write(`A${value.id}\n`, () => {});
          const next = await ready;
          if (next.event === 'guard-ready') {
            const rows = await readMacosProcesses(Math.max(1, Math.min(1000, Math.floor(deadline - performance.now()))));
            try { ownership.activateGuard(next, rows, state.cancelled || stopping); }
            catch (error) {
              if (state.cancelled || stopping) throw error;
              // A target cancelled before B cannot have executed. Its S/E/EOF
              // receipt can lag the process snapshot, so await that protocol
              // evidence inside the same bounded transition, then reconcile.
              await cancellationEvidence(state, deadline, error);
              ownership.activateGuard(next, await readMacosProcesses(Math.max(1, Math.min(1000, Math.floor(deadline - performance.now())))), true);
            }
            if (performance.now() >= deadline) throw new Error('macOS guard transition exceeded its deadline.');
            if (ownership.uncertain) throw new Error('Uncertain macOS guard session.');
            if (!stopping && !state.cancelled) child.stdin.write(`B${value.id}\n`, () => {});
          }
        } finally { clearTimeout(timeout); transitions.delete(value.id); }
        } finally {
          state.registered = true;
          for (const receipt of state.pending) inspectGuardEvent(receipt);
          state.pending.length = 0;
        }
      }, true);
      return;
    }
    const state = receivedGuards.get(value.id);
    if (state.registered) inspectGuardEvent(value);
    else {
      if (state.pending.length >= 3) throw new Error('Oversized pending macOS guard lifecycle.');
      state.pending.push(value);
    }
  };
  const parentStopped = () => stop(0);
  process.on('disconnect', parentStopped);
  process.on('SIGTERM', parentStopped);
  process.on('SIGINT', parentStopped);
  child.stdin.on('error', () => { if (!stopping) { fail('owner-pipe'); stop(1); } });
  child.on('error', () => { fail('owner-start'); readyReject(new Error('macOS process owner failed to start.')); });
  child.on('exit', (code, signal) => {
    childExited = true;
    expectedExit = stopping && (code === 0 || signal === 'SIGKILL');
    if (!expectedExit) fail('owner-exit');
    if (!readySeen) readyReject(new Error('macOS process owner exited before identity capture.'));
    if (!stopping) stop(1);
  });
  child.stdio[3].on('data', data => {
    try {
      nativeStatus += data.toString();
      if (nativeStatus.length > 262144) throw new Error('Oversized lifecycle receipt.');
      for (let end; (end = nativeStatus.indexOf('\n')) !== -1;) {
        if (end > 1024) throw new Error('Oversized lifecycle receipt.');
        const value = parseMacosLifecycle(JSON.parse(nativeStatus.slice(0, end)), child.pid);
        nativeStatus = nativeStatus.slice(end + 1);
        if (rootPID !== undefined && value.rootPID !== rootPID) throw new Error('Changed engine identity.');
        rootPID = value.rootPID;
        if (value.event === 'ready') {
          if (readySeen) throw new Error('Duplicate lifecycle receipt.');
          if (!pid(value.watchdogPID)) throw new Error('Missing macOS owner watchdog.');
          watchdogPID = value.watchdogPID;
          readySeen = true; readyResolve(value.rootPID);
        } else if (!readySeen) throw new Error('Unordered lifecycle receipt.');
        else if (value.event.startsWith('guard-')) receiveGuard(value);
        else if (value.event === 'engine-exit') {
          if (value.watchdogPID !== watchdogPID) throw new Error('Changed macOS watchdog identity.');
          if (engineExited) throw new Error('Duplicate engine exit receipt.');
          if (!stopping && value.code !== 0) failure ||= 'engine-exit';
          engineExited = true; stop(value.code);
        }
        else {
          if (value.watchdogPID !== watchdogPID) throw new Error('Changed macOS watchdog identity.');
          if (!stopping) { failure ||= 'owner-exit'; stop(1); }
        }
      }
      if (nativeStatus.length > 1024) throw new Error('Oversized partial lifecycle receipt.');
    } catch { fail('lifecycle-invalid'); readyReject(new Error('Invalid macOS lifecycle receipt.')); stop(1); }
  });
  child.stdio[3].on('end', () => { if (nativeStatus.length) { fail('lifecycle-invalid'); stop(1); } });
  if ('connected' in process && !process.connected) stop(0);
  const startup = setTimeout(() => { fail('startup-timeout'); readyReject(new Error('macOS process owner startup timed out.')); stop(1); }, 4000);
  try {
    await ready;
    let initial;
    try { initial = await readMacosProcesses(); } catch (error) { fail('inventory-unavailable', error); throw error; }
    try { ownership = new MacosProcessOwnership(initial, child.pid, process.pid, rootPID, watchdogPID); }
    catch (error) { ownershipFailure = 'initial-identity'; fail('ownership-uncertain'); throw error; }
    clearTimeout(startup);
    if (!stopping) child.stdin.write('G', () => {});
    while (!stopping) {
      await delay(150);
      if (stopping) break;
      try { if ((await observe(1000)).uncertain) { fail('ownership-uncertain'); stop(1); } }
      catch (error) { fail(error?.code === 'macos_process_inventory_unavailable' ? 'inventory-unavailable' : 'ownership-uncertain', error); stop(1); }
    }
    if (invalid) ownership.uncertain = true;
    const result = await waitForMacosExit(ownership, {
      observe,
      timeoutMs: Math.max(1, Math.floor(5800 - (performance.now() - stopAt))),
      status: () => ({ exited: childExited, expected: expectedExit && !invalid, engineExited }),
      quit: () => { ownership.ownerQuit = true; if (!childExited) child.stdin.write('Q', () => {}); },
    });
    report(result);
    return result.stopped ? requestedExit : 1;
  } catch {
    failure ||= 'host-error';
    report({ stopped: false, proof: 'unproven', recorded: ownership?.recorded.size || 0 });
    return 1;
  }
  finally {
    clearTimeout(startup);
    // EOF also closes the native owner's group when this JS host crashes. No
    // fallback signal is sent to a stale PID after a failed inventory.
    child.stdin.end();
    process.off('disconnect', parentStopped);
    process.off('SIGTERM', parentStopped);
    process.off('SIGINT', parentStopped);
    if (childExited && socketDirectory) {
      try {
        const socket = lstatSync(socketPath, { throwIfNoEntry: false });
        if (socket?.isSocket() && socket.uid === process.getuid()) unlinkSync(socketPath);
        rmdirSync(socketDirectory);
      } catch { /* Retain an unexpected entry instead of following or deleting it. */ }
    }
  }
}
