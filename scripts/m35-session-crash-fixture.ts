// Test preload only. The official engine is unchanged; withhold the Rivloom SDK response
// at one exact crash window, then the harness kills only its own service process tree.
import { writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const point = process.env.RIVLOOM_TEST_SESSION_CRASH_POINT;
const root = resolve(process.env.RIVLOOM_DATA_DIR || '.');
const within = relative(resolve('.data/verification'), root);
if (!['before_create', 'after_create'].includes(point || '') || !within || within.startsWith('..'))
  throw new Error('Session crash preload requires a dedicated verification data directory.');
const originalFetch = globalThis.fetch;
let injected = false;
globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : null;
  const url = new URL(request ? request.url : String(input));
  const method = init?.method || request?.method || 'GET';
  if (
    !injected &&
    url.hostname === '127.0.0.1' &&
    url.pathname === '/session' &&
    method === 'POST'
  ) {
    injected = true;
    let sessionID: string | null = null;
    if (point === 'after_create') {
      const result = await originalFetch(input, init);
      if (!result.ok) return result;
      const body = (await result.clone().json()) as { id?: string };
      if (!body.id) throw new Error('Official session create did not return an ID.');
      sessionID = body.id;
    }
    writeFileSync(
      join(root, 'session-crash-window.json'),
      JSON.stringify({ point, sessionID, at: new Date().toISOString() }),
    );
    return new Promise<Response>(() => {});
  }
  return originalFetch(input, init);
};
