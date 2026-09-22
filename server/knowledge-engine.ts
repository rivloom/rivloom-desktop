import { createServer, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import type { KnowledgeTools } from './knowledge-tools.ts';
import { knowledgeToolNames } from '../shared/knowledge.ts';
import { resolve } from 'node:path';

let bridge: { url: string; token: string; context: ((root: string) => { url: string; token: string }) | null;
  tools: ((root: string) => { url: string; token: string }) | null } | null = null;
export function knowledgeEngineConfig(root?: string) {
  return bridge ? { ...(root && bridge.tools ? bridge.tools(root) : { url: bridge.url, token: bridge.token }), context: root ? bridge.context?.(root) : undefined,
    plugin: pathToFileURL(fileURLToPath(new URL('./knowledge-plugin.mjs', import.meta.url))).href } : null;
}
export async function startKnowledgeBridge(tools: () => KnowledgeTools | null, context?: (root: string, body: unknown) => unknown,
  history?: (root: string, body: unknown) => unknown,
  authorizeTool?: (root: string, sessionID: string, directory: string) => string) {
  if (bridge) throw new Error('knowledge_bridge_already_started');
  const secret = randomBytes(32).toString('hex');
  const scopes = new Map<string, string>();
  const server: Server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const scoped = req.url === '/context' || req.url === '/history' || req.url === '/tools' && !!authorizeTool;
    const scope = scoped ? [...scopes].find(([, token]) => req.headers.authorization === `Bearer ${token}`) : undefined;
    const supplied = Buffer.from(req.headers.authorization || ''); const expected = Buffer.from(`Bearer ${scope?.[1] || secret}`);
    if (req.method !== 'POST' || !['/tools', '/context', '/history'].includes(req.url || '') || req.headers.origin ||
      scoped && (!scope || !(req.url === '/tools' ? authorizeTool : req.url === '/history' ? history : context)) ||
      supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(403).end(); return; }
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const raw of req) { const part = Buffer.from(raw); bytes += part.length;
        if (bytes > 160_000) throw new Error('knowledge_request_too_large'); chunks.push(part); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (scope && req.url !== '/tools') {
        const result = await (req.url === '/history' ? history! : context!)(scope[0], body);
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result)); return;
      }
      if (!body || typeof body !== 'object' || typeof body.sessionID !== 'string' || body.sessionID.length > 120 ||
        typeof body.directory !== 'string' || body.directory.length > 1000 || !knowledgeToolNames.includes(body.name)) throw new Error('knowledge_invalid_request');
      const active = tools(); if (!active) throw new Error('knowledge_starting');
      const before = scope && authorizeTool ? authorizeTool(scope[0], body.sessionID, body.directory) : null;
      const guard = () => {
        if (scope && authorizeTool && authorizeTool(scope[0], body.sessionID, body.directory) !== before)
          throw new Error('context_execution_changed');
      };
      const result = await active.call(body.sessionID, body.directory, body.name, body.args, guard);
      guard();
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
    } catch (error) {
      const message = error instanceof Error && /^(knowledge|context)_[a-z_]+$/.test(error.message) ? error.message : 'knowledge_request_failed';
      res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: message }));
    }
  });
  server.requestTimeout = 20_000; server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('knowledge_bridge_start_failed');
  const scopedConfig = (root: string, endpoint: string) => {
    const key = process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root);
    if (!scopes.has(key)) scopes.set(key, randomBytes(32).toString('hex'));
    return { url: `http://127.0.0.1:${address.port}/${endpoint}`, token: scopes.get(key)! };
  };
  bridge = { url: `http://127.0.0.1:${address.port}/tools`, token: secret,
    context: context ? root => scopedConfig(root, 'context') : null,
    tools: authorizeTool ? root => scopedConfig(root, 'tools') : null };
  return { close: async () => { bridge = null; server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); } };
}
