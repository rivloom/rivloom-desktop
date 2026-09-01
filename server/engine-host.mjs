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
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(engine.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.once('exit', () => process.exit(0));
    killer.once('error', () => {
      engine.kill();
      process.exit(0);
    });
  } else {
    engine.kill();
    process.exit(0);
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
