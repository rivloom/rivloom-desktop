import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import type { Project, User } from '../shared/types.ts';
import { ProjectChangesError, readProjectChanges, readProjectDiff } from './project-changes.ts';

export function installProjectChangesAPI(app: Express, who: (req: Request) => User, projects: () => Project[]) {
  const route = (read: (req: Request, project: Project) => Promise<unknown>) => async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!who(req).owner) { res.status(403).json({ error: 'project_changes_owner_only' }); return; }
    const project = projects().find(value => value.id === req.params.id);
    if (!project) { res.status(404).json({ error: 'project_changes_missing' }); return; }
    try { res.json(await read(req, project)); }
    catch (error) { res.status(error instanceof z.ZodError ? 400 : error instanceof ProjectChangesError ? error.status : 409)
      .json({ error: error instanceof ProjectChangesError ? error.message : 'project_changes_failed' }); }
  };
  app.get('/api/projects/:id/changes', route((_req, project) => readProjectChanges(project.directory)));
  app.post('/api/projects/:id/changes/diff', route((req, project) => {
    const input = z.object({ path: z.string().min(1).max(2000), area: z.enum(['working', 'staged']) }).strict().parse(req.body);
    return readProjectDiff(project.directory, input.path, input.area);
  }));
}
