// A small process owner, not an agent. IPC disconnect also covers a crashed app.
import { spawn } from 'node:child_process';
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
  const deadline = setTimeout(() => process.exit(1), 7000);
  const finish = () => {
    if (engineExited && treeStopped) { clearTimeout(deadline); process.exit(0); }
  };
  engine.once('exit', () => { engineExited = true; finish(); });
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(engine.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.once('exit', (code) => {
      if (code !== 0) return process.exit(1);
      treeStopped = true; finish();
    });
    killer.once('error', () => {
      engine.kill();
      // Root-only termination does not establish that the tree has stopped.
      process.exit(1);
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
