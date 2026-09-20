import type { Express, Request, RequestHandler } from 'express';
import { z } from 'zod';
import { maximumPromptTemplates, validPromptTemplateInput } from '../shared/prompt-templates.ts';
import { PromptTemplateError, type PromptTemplateStore } from './prompt-templates.ts';

/** Install after the existing authentication and same-origin middleware. User identity
 * always comes from who(req), never route/query/body fields.
 */
export function installPromptTemplateAPI(app: Express, who: (req: Request) => { id: string }, store: PromptTemplateStore) {
  const content = { title: z.string(), text: z.string() };
  const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
  const route = (handler: RequestHandler): RequestHandler => (req, res, next) => {
    try { return handler(req, res, next); }
    catch (error) {
      if (error instanceof PromptTemplateError) return void res.status(error.status).json({ error: error.code });
      if (error instanceof z.ZodError) return void res.status(400).json({ error: 'prompt_template_invalid' });
      next(error);
    }
  };
  const id = (req: Request) => z.string().uuid().parse(req.params.id);
  app.get('/api/prompt-templates', route((req, res) => { res.json({ templates: store.list(who(req).id), limit: maximumPromptTemplates }); }));
  app.get('/api/prompt-templates/:id', route((req, res) => { res.json(store.get(who(req).id, id(req))); }));
  app.post('/api/prompt-templates', route((req, res) => {
    const userID = who(req).id;
    const body = z.object({ id: z.string().uuid(), ...content }).strict().parse(req.body);
    const input = { title: body.title, text: body.text };
    if (!validPromptTemplateInput(input)) throw new PromptTemplateError('prompt_template_invalid');
    res.status(201).json(store.create(userID, input, body.id));
  }));
  app.post('/api/prompt-templates/:id', route((req, res) => {
    const userID = who(req).id;
    const body = z.object({ revision, ...content }).strict().parse(req.body);
    res.json(store.update(userID, id(req), body.revision, { title: body.title, text: body.text }));
  }));
  app.post('/api/prompt-templates/:id/delete', route((req, res) => {
    const userID = who(req).id, body = z.object({ revision }).strict().parse(req.body);
    store.delete(userID, id(req), body.revision); res.json({ deleted: true });
  }));
}
