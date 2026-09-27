import type { Express, Request, Response } from 'express';
import { filePreviewType, filePreviewTextBytes, previewRange } from '../shared/file-preview.ts';
import { readOffice, officeReadOptions } from './office-files.ts';
import { editableTextLimit, officeFileLimit, textEditable } from '../shared/office-files.ts';
import { decodeOfficeText } from './office-parser.ts';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { Task, User } from '../shared/types.ts';
import {
  validTaskFileDescriptor,
  taskFileChunkBytes,
  taskFileUploadCount,
  type TaskFileScope,
  type TaskFileRoute,
  type TaskFileView,
} from '../shared/task-files.ts';
import { TaskFileError } from './task-files.ts';
import type { NodeNetwork } from './node-network.ts';

export function installTaskFileAPI(
  app: Express,
  network: NodeNetwork,
  who: (req: Request) => User,
  localTasks: () => Task[],
  changed: () => void,
  locations: (local: Task, fileID: string) => { root: string; path: string }[] = () => [],
  protectedFile: (fileID: string) => boolean = () => false,
  remoteResults?: { views: (executionID: string) => TaskFileView[]; fetch: (executionID: string, fileID: string) => Promise<void> },
) {
  const files = network.files;
  const check = (condition: unknown, status: number, message: string) => {
    if (!condition) throw new TaskFileError(status, message);
  };
  const ids = z.array(z.string().uuid()).max(taskFileUploadCount);
  const preview = (req: Request, res: Response, fileID: string) => {
    const descriptor = files.descriptorFor(fileID), type = filePreviewType(descriptor.name);
    res.set({ 'Content-Type': type.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "sandbox; default-src 'none'", 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(descriptor.name)}` });
    check(type.kind !== 'unsupported', 415, '此格式暂不支持预览，请下载后打开。');
    if (type.kind === 'text') {
      const bytes = files.previewBytes(fileID, 0, Math.min(descriptor.bytes, filePreviewTextBytes));
      res.set('X-Preview-Truncated', descriptor.bytes > bytes.length ? 'true' : 'false'); res.send(bytes); return;
    }
    if (type.kind === 'image') {
      check(descriptor.bytes <= 20 * 1024 * 1024, 413, '图片较大，请下载后打开。');
      res.send(files.previewBytes(fileID, 0, descriptor.bytes)); return;
    }
    const range = previewRange(req.headers.range, descriptor.bytes);
    res.set('Accept-Ranges', 'bytes');
    if (!range) { res.status(416).set('Content-Range', `bytes */${descriptor.bytes}`).end(); return; }
    const { start, end } = range;
    if (req.headers.range || end + 1 < descriptor.bytes) res.status(206).set('Content-Range', `bytes ${start}-${end}/${descriptor.bytes}`);
    res.send(files.previewBytes(fileID, start, end - start + 1));
  };
  const accessible = (req: Request) => {
    const scope = z.enum(['local', 'remote', 'brain']).parse(req.params.scope),
      taskID = z.string().uuid().parse(req.params.taskID);
    const actor = who(req);
    let local: Task | undefined;
    if (scope === 'local') {
      local = localTasks().find((t) => t.id === taskID);
      check(local, 404, '任务不存在。');
      check(
        [local!.creatorID, local!.assigneeID, local!.approverID, local!.reviewerID].includes(
          actor.id,
        ),
        403,
        '你不是此任务的参与者。',
      );
    } else {
      const snapshot = network.snapshot();
      const remote =
        scope === 'remote' ? snapshot.remoteTasks.find((t) => t.id === taskID) : undefined;
      const brain =
        scope === 'brain' ? snapshot.brainTasks.find((t) => t.id === taskID) : undefined;
      check(remote || brain, 404, '协作任务不存在。');
      if (remote?.direction === 'incoming' && remote.localTaskID)
        local = localTasks().find((t) => t.id === remote.localTaskID);
      check(
        actor.owner ||
          (local &&
            [local.creatorID, local.assigneeID, local.approverID, local.reviewerID].includes(
              actor.id,
            )),
        403,
        '你不能访问此协作任务。',
      );
    }
    let canPublish =
      !!local &&
      local.assigneeID === actor.id &&
      !!local.sessionID &&
      ['review', 'accepted', 'stopped', 'failed'].includes(local.state);
    if (local?.remoteOrigin) {
      const remote = network.remoteTask(local.remoteOrigin.remoteTaskID);
      canPublish =
        canPublish &&
        remote?.status === 'accepted' &&
        network.isTrustedNode(local.remoteOrigin.ownerNodeID);
    }
    return {
      scope,
      taskID,
      local,
      canPublish,
      canSave: true,
      canRetry: actor.owner || local?.assigneeID === actor.id,
    };
  };
  const routes = (scope: TaskFileScope, taskID: string) => ({
    input: { scope, taskID, purpose: 'input' } as TaskFileRoute,
    result: { scope, taskID, purpose: 'result' } as TaskFileRoute,
  });
  app.post('/api/task-files/uploads', (req, res) => {
    check(validTaskFileDescriptor(req.body), 400, '文件名称、大小、类型或校验信息无效。');
    res.status(201).json(files.beginUpload(who(req).id, req.body));
  });
  app.post('/api/task-files/uploads/:fileID/chunk', (req, res) => {
    const input = z
      .object({
        offset: z.number().int().nonnegative(),
        data: z
          .string()
          .min(1)
          .max(Math.ceil(taskFileChunkBytes / 3) * 4),
      })
      .strict()
      .parse(req.body);
    res.json(
      files.uploadChunk(
        who(req).id,
        z.string().uuid().parse(req.params.fileID),
        input.offset,
        input.data,
      ),
    );
  });
  app.post('/api/task-files/uploads/:fileID/discard', (req, res) => {
    const id = z.string().uuid().parse(req.params.fileID);
    if (protectedFile(id)) { files.uploaded(who(req).id, [id]); res.json({ removed: false, retained: true }); return; }
    files.discardUpload(who(req).id, id);
    res.json({ removed: true });
  });
  app.get('/api/task-files/uploads/:fileID/preview', (req, res) => {
    const id = z.string().uuid().parse(req.params.fileID); files.uploaded(who(req).id, [id]); preview(req, res, id);
  });
  app.get('/api/task-files/uploads/:fileID', (req, res) => {
    const id = z.string().uuid().parse(req.params.fileID); files.uploaded(who(req).id, [id]); res.json(files.view(id));
  });
  app.get('/api/task-files/:scope/:taskID', (req, res) => {
    const access = accessible(req),
      route = routes(access.scope, access.taskID);
    res.json({
      inputs: files.views(route.input),
      results: access.scope === 'remote' && remoteResults?.views(access.taskID).length ? remoteResults.views(access.taskID) : files.views(route.result),
      canPublish: access.canPublish,
      canSave: true,
      canRetry: access.canRetry,
    });
  });
  app.post('/api/task-files/:scope/:taskID/fetch', async (req, res) => {
    const access = accessible(req);
    const body = z.object({ fileID: z.string().uuid() }).strict().parse(req.body);
    check(access.scope === 'remote' && remoteResults, 409, '此文件不支持远端取回。');
    try { await remoteResults!.fetch(access.taskID, body.fileID); }
    catch (error) { throw new TaskFileError(409, error instanceof Error ? error.message : 'workflow_file_not_available'); }
    res.json({ requested: true });
  });
  app.post('/api/task-files/:scope/:taskID/results', (req, res) => {
    const access = accessible(req);
    check(access.canPublish && access.local, 403, '只有本任务执行人可在执行停止后选择发布成果。');
    const input = z
      .object({ attachmentIDs: ids.min(1) })
      .strict()
      .parse(req.body);
    const route: TaskFileRoute = { scope: 'local', taskID: access.local!.id, purpose: 'result' };
    files.bindUploaded(route, who(req).id, input.attachmentIDs);
    network.refreshTaskFiles();
    changed();
    res.json({ published: true });
  });
  app.post('/api/task-files/:scope/:taskID/retry', (req, res) => {
    const access = accessible(req);
    check(access.canRetry, 403, '只有本机所有者或执行人可以重试文件传输。');
    const route = routes(access.scope, access.taskID);
    files.retry(route.input);
    files.retry(route.result);
    network.refreshTaskFiles();
    res.json({ retrying: true });
  });
  const selectedFile = (req: Request) => {
    const access = accessible(req),
      fileID = z.string().uuid().parse(req.params.fileID),
      route = routes(access.scope, access.taskID);
    check(
      [...files.manifest(route.input), ...files.manifest(route.result)].some(
        (f) => f.id === fileID,
      ),
      403,
      '文件未绑定此任务。',
    );
    return { fileID, local: access.local };
  };
  app.get('/api/task-files/:scope/:taskID/:fileID/content', (req, res) => {
    const { fileID } = selectedFile(req),
      descriptor = files.descriptorFor(fileID);
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(descriptor.name)}`,
    });
    res.send(files.content(fileID));
  });
  app.get('/api/task-files/:scope/:taskID/:fileID/preview', (req, res) => preview(req, res, selectedFile(req).fileID));
  const officeID = (req: Request) => {
    if (req.params.scope === 'uploads') {
      const id = z.string().uuid().parse(req.params.fileID); files.uploaded(who(req).id, [id]); return id;
    }
    return selectedFile(req).fileID;
  };
  for (const prefix of ['/api/task-files/uploads/:fileID', '/api/task-files/:scope/:taskID/:fileID']) {
    const select = (req: Request) => {
      if (prefix.includes('/uploads/')) { const id = z.string().uuid().parse(req.params.fileID); files.uploaded(who(req).id, [id]); return id; }
      return officeID(req);
    };
    app.get(`${prefix}/document`, async (req, res) => {
      const id = select(req), file = files.descriptorFor(id);
      check(file.bytes <= officeFileLimit, 413, 'office_too_large');
      res.set('Cache-Control', 'no-store').json(await readOffice(file.name, files.content(id), officeReadOptions.parse(req.query)));
    });
    app.get(`${prefix}/text`, (req, res) => {
      const id = select(req), file = files.descriptorFor(id);
      check(textEditable(file.name) && file.bytes <= editableTextLimit, 413, 'office_edit_unavailable');
      const decoded = decodeOfficeText(files.content(id)); check(decoded.encoding === 'utf-8', 409, 'office_edit_unavailable');
      res.set('Cache-Control', 'no-store').json({ text: decoded.text, revision: file.sha256 });
    });
    app.post(`${prefix}/copy`, (req, res) => {
      const id = select(req), source = files.descriptorFor(id);
      const body = z.object({ text: z.string().max(editableTextLimit), expectedRevision: z.string().length(64) }).strict().parse(req.body);
      check(textEditable(source.name) && source.bytes <= editableTextLimit, 413, 'office_edit_unavailable');
      check(body.expectedRevision === source.sha256, 409, 'office_changed');
      const bytes = Buffer.from(body.text); check(bytes.length <= editableTextLimit && !body.text.includes('\0'), 413, 'office_edit_unavailable');
      const file = { ...source, id: randomUUID(), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      const actor = who(req).id; files.beginUpload(actor, file);
      for (let offset = 0; offset < bytes.length; offset += taskFileChunkBytes) files.uploadChunk(actor, file.id, offset, bytes.subarray(offset, offset + taskFileChunkBytes).toString('base64'));
      res.json({ file, path: `/task-files/uploads/${file.id}` });
    });
  }
  app.get('/api/task-files/uploads/:fileID/content', (req, res) => {
    const id = z.string().uuid().parse(req.params.fileID); files.uploaded(who(req).id, [id]);
    res.set({ 'Cache-Control': 'no-store', 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(files.descriptorFor(id).name)}` }).send(files.content(id));
  });
  app.post('/api/task-files/uploads/:fileID/location', async (req, res) => {
    const id = z.string().uuid().parse(req.params.fileID); files.uploaded(who(req).id, [id]); res.json(await files.location(id));
  });
  app.post('/api/task-files/uploads/:fileID/export', (req, res) => {
    const id = z.string().uuid().parse(req.params.fileID); files.uploaded(who(req).id, [id]);
    const input = z.object({ destination: z.string().min(1).max(2000) }).strict().parse(req.body); res.json(files.exportFile(id, input.destination));
  });
  app.post('/api/task-files/:scope/:taskID/:fileID/export', (req, res) => {
    const { fileID } = selectedFile(req),
      input = z
        .object({ destination: z.string().min(1).max(1000) })
        .strict()
        .parse(req.body);
    res.json(files.exportFile(fileID, input.destination));
  });
  app.post('/api/task-files/:scope/:taskID/:fileID/location', async (req, res) => {
    const { fileID, local } = selectedFile(req);
    z.object({}).strict().parse(req.body);
    res.json(await files.location(fileID, local ? locations(local, fileID) : []));
  });
}
