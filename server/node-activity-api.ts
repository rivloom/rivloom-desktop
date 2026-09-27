import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import type { User } from '../shared/types.ts';
import type { NodeActivitySnapshot } from '../shared/node-activity.ts';

const dismissSchema = z.object({ id: z.string().uuid() }).strict();

export function installNodeActivityAPI(app: Express, who: (req: Request) => User,
  readSnapshot: () => NodeActivitySnapshot, dismiss: (id: string) => boolean) {
  const route = (run: (req: Request, res: Response) => void) => (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!who(req).owner) { res.status(403).json({ error: 'node_activity_owner_only' }); return; }
      run(req, res);
    } catch { res.status(503).json({ error: 'node_activity_unavailable' }); }
  };
  app.get('/api/node-activity', route((_req, res) => { res.json(readSnapshot()); }));
  app.post('/api/node-activity/knowledge/dismiss', route((req, res) => {
    const input = dismissSchema.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'node_activity_invalid_request' }); return; }
    res.json({ dismissed: dismiss(input.data.id) });
  }));
}
