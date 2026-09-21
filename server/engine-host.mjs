// A small process owner, not an agent. IPC disconnect also covers a crashed app.
import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import { stopWindowsEngineTree } from './windows-engine-stop.mjs';
function stopDiagnostic(value) {
  // Synchronous and bounded so process.exit cannot discard the final evidence.
  try { writeSync(2, `RIVLOOM_ENGINE_STOP ${JSON.stringify(value)}\n`); } catch { /* Diagnostics are best effort. */ }
}
const engine = spawn(process.argv[2], process.argv.slice(3), {
  env: process.env,
  cwd: process.cwd(),
  windowsHide: true,
  detached: process.platform === 'linux',
  stdio: ['ignore', 'pipe', 'pipe'],
});
engine.stdout.pipe(process.stdout);
engine.stderr.pipe(process.stderr);
let closing = false;
function close(exitCode = 0) {
  if (closing) return;
  closing = true;
  if (!engine.pid) return process.exit(0);
  if (process.platform === 'linux') {
    // The detached child owns a fresh process group, including shells/tools it spawns.
    // Never signal the parent's process group or infer tree exit from root exit alone.
    const group = -engine.pid;
    const signal = (value) => {
      try { process.kill(group, value); return true; }
      catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    };
    try { signal('SIGTERM'); } catch { return process.exit(1); }
    const started = Date.now();
    let killed = false;
    const timer = setInterval(() => {
      try {
        if (!signal(0)) { clearInterval(timer); process.exit(exitCode); }
        if (!killed && Date.now() - started >= 2000) { killed = true; signal('SIGKILL'); }
        if (Date.now() - started >= 5500) { clearInterval(timer); process.exit(1); }
      } catch { clearInterval(timer); process.exit(1); }
    }, 50);
    return;
  }
  if (engine.exitCode !== null || engine.signalCode !== null) return process.exit(0);
  // The host is the ownership receipt for the whole engine tree. It must not
  // claim success merely because taskkill returned or TerminateProcess was sent.
  let engineExited = false;
  let treeStopped = process.platform !== 'win32';
  const started = performance.now();
  const deadline = setTimeout(() => {
    if (process.platform === 'win32') stopDiagnostic({ phase: 'deadline', outcome: 'failed', durationMs: Math.round(performance.now() - started), reason: 'timeout' });
    process.exit(1);
  }, 7000);
  const finish = () => {
    if (engineExited && treeStopped) { clearTimeout(deadline); process.exit(0); }
  };
  engine.once('exit', () => { engineExited = true; finish(); });
  if (process.platform === 'win32') {
    const failed = () => {
      // Best effort through the original child handle only. This does not prove
      // descendant cleanup, so the host must still report failure.
      if (engine.exitCode === null && engine.signalCode === null) {
        try { engine.kill(); } catch { /* Keep the failure result. */ }
      }
      process.exit(1);
    };
    void stopWindowsEngineTree(engine.pid, process.pid, {
      isRootRunning: () => engine.exitCode === null && engine.signalCode === null,
      onDiagnostic: stopDiagnostic,
    }).then((result) => {
      if (!result.stopped) return failed();
      treeStopped = true; finish();
    }, () => {
      stopDiagnostic({ phase: 'unexpected', outcome: 'failed', durationMs: Math.round(performance.now() - started), reason: 'invalid_result' });
      failed();
    });
  } else {
    engine.kill();
  }
}
process.on('disconnect', () => close());
process.on('SIGTERM', () => close());
process.on('SIGINT', () => close());
engine.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
engine.on('exit', (code) => {
  if (!closing) {
    if (process.platform === 'linux') close(code ?? 1);
    else process.exit(code || 0);
  }
});
