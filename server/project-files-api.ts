import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { dirname, join, basename, resolve, isAbsolute } from 'node:path';
import { lstat, realpath, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Project, User } from '../shared/types.ts';
import { taskFileNameError } from '../shared/task-files.ts';
import { filePreviewType, previewRange } from '../shared/file-preview.ts';
import { officeFileLimit, editableTextLimit, textEditable } from '../shared/office-files.ts';
import { decodeOfficeText } from './office-parser.ts';
import { readOffice, officeReadOptions } from './office-files.ts';
import { ProjectFileError, projectFilePath, listProjectFiles, readProjectFile, saveProjectText } from './project-files.ts';
export function installProjectFilesAPI(app: Express, who: (req: Request) => User, projects: () => Project[]) {
  app.get('/api/office-assets/:group/:name', (req, res) => {
    const group = z.enum(['cmaps', 'standard_fonts', 'wasm']).parse(req.params.group);
    const name = z.string().regex(/^[a-zA-Z0-9_-]+\.(bcmap|ttf|pfb|wasm|js)$/).parse(req.params.name);
    res.sendFile(join(dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json'))), group, name));
  });
  const route = (action: (req: Request, res: Response, project: Project) => Promise<void>) => async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    if (!who(req).owner) { res.status(403).json({ error: 'office_owner_only' }); return; }
    const project = projects().find(value => value.id === req.params.id);
    if (!project) { res.status(404).json({ error: 'office_project_missing' }); return; }
    try { await action(req, res, project); }
    catch (error) { const message = (error as Error).message;
      res.status(error instanceof z.ZodError ? 400 : error instanceof ProjectFileError ? error.status : 409)
        .json({ error: /^office_[a-z_]+$/.test(message) ? message : 'office_unavailable' }); }
  };
  const path = (req: Request) => z.string().min(1).max(2000).parse(req.params.entry);
  const prefix = '/api/projects/:id/file/:entry';
  const metadata = async (project: Project, entry: string) => {
    const target = await projectFilePath(project.directory, entry); const info = await lstat(target);
    if (!info.isFile()) throw new ProjectFileError('office_path');
    return { path: target, name: basename(target), bytes: info.size };
  };
  app.get('/api/projects/:id/files', route(async (req, res, project) => {
    const query = z.object({ path: z.string().max(2000).default(''), search: z.string().max(100).default('') }).parse(req.query);
    res.json(await listProjectFiles(project.directory, query.path, query.search));
  }));
  app.get(prefix, route(async (req, res, project) => {
    const { name, bytes } = await metadata(project, path(req));
    res.json({ name, bytes });
  }));
  app.get(`${prefix}/document`, route(async (req, res, project) => {
    const value = await readProjectFile(project.directory, path(req));
    res.json(await readOffice(value.name, value.buffer, officeReadOptions.parse(req.query)));
  }));
  app.get(`${prefix}/text`, route(async (req, res, project) => {
    const value = await readProjectFile(project.directory, path(req), editableTextLimit);
    const decoded = decodeOfficeText(value.buffer);
    if (!textEditable(value.name) || decoded.encoding !== 'utf-8') throw new ProjectFileError('office_edit_unavailable');
    res.json({ text: decoded.text, revision: value.revision });
  }));
  app.post(`${prefix}/save`, route(async (req, res, project) => {
    const input = z.object({ text: z.string().max(editableTextLimit), expectedRevision: z.string().length(64) }).strict().parse(req.body);
    res.json(await saveProjectText(project.directory, path(req), input.expectedRevision, input.text));
  }));
  app.post(`${prefix}/export`, route(async (req, res, project) => {
    const { destination } = z.object({ destination: z.string().min(1).max(2000) }).strict().parse(req.body);
    if (!isAbsolute(destination) || destination.split(/[\\/]/).includes('..') || taskFileNameError(basename(destination))) throw new ProjectFileError('office_path', 400);
    const parent = dirname(resolve(destination));
    if (!(await lstat(parent)).isDirectory() || (await realpath(parent)).toLocaleLowerCase() !== parent.toLocaleLowerCase()) throw new ProjectFileError('office_path', 400);
    const value = await readProjectFile(project.directory, path(req));
    let handle;
    try { handle = await open(destination, 'wx'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ProjectFileError('office_destination_exists'); throw error; }
    try { await handle.writeFile(value.buffer); await handle.sync(); } finally { await handle.close(); }
    res.json({ path: destination, bytes: value.buffer.length });
  }));
  for (const operation of ['content', 'preview']) app.get(`${prefix}/${operation}`, route(async (req, res, project) => {
    const value = await readProjectFile(project.directory, path(req), officeFileLimit); const type = filePreviewType(value.name);
    res.set({ 'Content-Type': operation === 'content' ? 'application/octet-stream' : type.mime,
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'",
      'Content-Disposition': `${operation === 'content' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(value.name)}` });
    if (req.headers.range) { const range = previewRange(req.headers.range, value.buffer.length);
      if (!range) { res.status(416).end(); return; }
      res.status(206).set({ 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${range.start}-${range.end}/${value.buffer.length}` }).send(value.buffer.subarray(range.start, range.end + 1));
    } else res.send(value.buffer);
  }));
  app.post(`${prefix}/location`, route(async (req, res, project) => {
    const value = await metadata(project, path(req)); res.json({ path: value.path });
  }));
}
