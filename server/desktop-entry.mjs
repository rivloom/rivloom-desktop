// Native process lifecycle only. All AI execution remains in official OpenCode.
let server;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(1), 7000);
  deadline.unref();
  if (server) await server.shutdown();
  else process.exit(0);
}
process.stdin.setEncoding('utf8');
process.stdin.on('end', close);
process.stdin.on('error', close);
process.stdin.on('data', (chunk) => {
  if (chunk.includes('shutdown')) void close();
});
process.stdin.resume();
server = await import('./index.ts');
