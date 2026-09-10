// A small process owner, not an agent. IPC disconnect also covers a crashed app.
import { spawn } from 'node:child_process';
const engine = spawn(process.argv[2], process.argv.slice(3), {
  env: process.env,
  cwd: process.cwd(),
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
engine.stdout.pipe(process.stdout);
engine.stderr.pipe(process.stderr);
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  if (!engine.pid) return process.exit(0);
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
process.on('disconnect', close);
process.on('SIGTERM', close);
process.on('SIGINT', close);
engine.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
engine.on('exit', (code) => {
  if (!closing) process.exit(code || 0);
});
