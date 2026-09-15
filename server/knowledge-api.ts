import type { Express, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { knowledgeID, knowledgeRefSchema, knowledgeRevision, memoryInputSchema } from '../shared/knowledge.ts';
import type { Project, User } from '../shared/types.ts';
import { KnowledgeStore } from './knowledge-store.ts';
import { KnowledgeNetwork } from './knowledge-network.ts';

export function installKnowledgeAPI(app: Express, current: () => { store: KnowledgeStore; network: KnowledgeNetwork } | null,
  who: (req: Request) => User, projects: () => Project[]) {
  const route = (fn: (req: Request, service: NonNullable<ReturnType<typeof current>>) => unknown) =>
    async (req: Request, res: Response, _next: NextFunction) => {
      res.setHeader('Cache-Control', 'no-store');
      if (!who(req).owner) { res.status(403).json({ error: 'knowledge_owner_only' }); return; }
      const service = current(); if (!service) { res.status(503).json({ error: 'knowledge_starting' }); return; }
      try { res.json(await fn(req, service)); }
      catch (error) { res.status(error instanceof z.ZodError ? 400 : 409).json({ error:
        error instanceof Error && /^knowledge_[a-z_]+$/.test(error.message) ? error.message : 'knowledge_request_failed' }); }
    };
  const directory = (id: string | null) => {
    if (id === null) return undefined;
    const project = projects().find((v) => v.id === id); if (!project) throw new Error('knowledge_wrong_project'); return project.directory;
  };
  app.get('/api/knowledge', route((_req, { store, network }) => ({ entries: store.listLocal(), brains: network.brains(), organization: store.organization() })));
  app.post('/api/knowledge/search', route((req, { network }) => network.search(z.object({
    brainID: knowledgeID.nullable().optional(), text: z.string().max(200).optional(), kind: z.enum(['skill', 'memory']).optional(),
    category: z.string().max(240).optional(), offset: z.number().int().min(0).max(2000).optional(),
  }).strict().parse(req.body))));
  app.post('/api/knowledge/refresh', route(async (_req, { store, network }) => { await store.refreshAll(); return { entries: store.listLocal(), brains: network.brains() }; }));
  app.post('/api/knowledge/skills/register', route(async (req, { store }) => {
    const input = z.object({ directory: z.string().min(1).max(1000), projectID: knowledgeID.nullable() }).strict().parse(req.body);
    directory(input.projectID); return store.registerSkill(input.directory, input.projectID);
  }));
  app.post('/api/knowledge/memory', route((req, { store }) => {
    const input = memoryInputSchema.parse(req.body); directory(input.projectID); return store.saveMemory(input, 'user');
  }));
  app.get('/api/knowledge/memory/:id', route((req, { store }) => store.readMemory(knowledgeID.parse(req.params.id))));
  app.get('/api/knowledge/history/:id', route((req, { store }) => store.history(knowledgeID.parse(req.params.id))));
  app.post('/api/knowledge/share', route((req, { store, network }) => {
    const input = z.object({ id: knowledgeID, brains: z.array(knowledgeID).max(32), revision: knowledgeRevision,
      updatedAt: z.string().datetime() }).strict().parse(req.body);
    if (input.brains.some((id) => !network.brains().some((b) => b.id === id))) throw new Error('knowledge_brain_unavailable');
    return store.share(input.id, input.brains, input.revision, input.updatedAt);
  }));
  app.post('/api/knowledge/share-many', route((req, { store, network }) => {
    const input = z.object({ entries: z.array(z.object({ id: knowledgeID, revision: knowledgeRevision, updatedAt: z.string().datetime() }).strict()).min(1).max(2000),
      brains: z.array(knowledgeID).max(32) }).strict().parse(req.body);
    if (input.brains.some((id) => !network.brains().some((b) => b.id === id))) throw new Error('knowledge_brain_unavailable');
    return store.shareMany(input.entries, input.brains);
  }));
  app.post('/api/knowledge/remove', route((req, { store }) => {
    const input = z.object({ id: knowledgeID, revision: knowledgeRevision }).strict().parse(req.body);
    store.remove(input.id, input.revision); return { ok: true };
  }));
  app.post('/api/knowledge/organize', route((_req, { store }) => store.organize()));
  app.post('/api/knowledge/rules/read', route((req, { store }) => {
    const input = z.object({ projectID: knowledgeID.nullable() }).strict().parse(req.body); return store.rules(directory(input.projectID));
  }));
  app.post('/api/knowledge/rules/save', route((req, { store }) => {
    const input = z.object({ projectID: knowledgeID.nullable(), body: z.string().max(24_000), revision: knowledgeRevision }).strict().parse(req.body);
    return store.saveRules(input.body, input.revision, directory(input.projectID));
  }));
  app.post('/api/knowledge/read', route(async (req, { network }) => {
    const ref = knowledgeRefSchema.parse(req.body); const manifest = await network.manifest(ref);
    const bytes = await network.file(ref, manifest, manifest.entry.kind === 'skill' ? 'SKILL.md' : 'MEMORY.md');
    return { ...manifest, body: bytes.length <= 128_000 ? bytes.toString('utf8') : '', truncated: bytes.length > 128_000 };
  }));
}
