import { createServer, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import type { KnowledgeTools } from './knowledge-tools.ts';
import { knowledgeToolNames } from '../shared/knowledge.ts';

let bridge: { url: string; token: string } | null = null;
export function knowledgeEngineConfig() {
  return bridge ? { url: bridge.url, token: bridge.token, plugin: pathToFileURL(fileURLToPath(new URL('./knowledge-plugin.mjs', import.meta.url))).href } : null;
}
export async function startKnowledgeBridge(tools: () => KnowledgeTools | null) {
  if (bridge) throw new Error('knowledge_bridge_already_started');
  const secret = randomBytes(32).toString('hex');
  const server: Server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const supplied = Buffer.from(req.headers.authorization || ''); const expected = Buffer.from(`Bearer ${secret}`);
    if (req.method !== 'POST' || req.url !== '/tools' || req.headers.origin ||
      supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(403).end(); return; }
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const raw of req) { const part = Buffer.from(raw); bytes += part.length;
        if (bytes > 160_000) throw new Error('knowledge_request_too_large'); chunks.push(part); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || typeof body.sessionID !== 'string' || body.sessionID.length > 120 ||
        typeof body.directory !== 'string' || body.directory.length > 1000 || !knowledgeToolNames.includes(body.name)) throw new Error('knowledge_invalid_request');
      const active = tools(); if (!active) throw new Error('knowledge_starting');
      const result = await active.call(body.sessionID, body.directory, body.name, body.args);
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
    } catch (error) {
      const message = error instanceof Error && /^knowledge_[a-z_]+$/.test(error.message) ? error.message : 'knowledge_request_failed';
      res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: message }));
    }
  });
  server.requestTimeout = 20_000; server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('knowledge_bridge_start_failed');
  bridge = { url: `http://127.0.0.1:${address.port}/tools`, token: secret };
  return { close: async () => { bridge = null; server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); } };
}
