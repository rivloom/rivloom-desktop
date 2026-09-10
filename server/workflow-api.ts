import type { Express, Request } from 'express';
import { z } from 'zod';
import { validWorkflowStepPlan, validWorkflowTarget } from '../shared/workflows.ts';
import { taskFileUploadCount } from '../shared/task-files.ts';
import type { User } from '../shared/types.ts';
import { HttpError, project, requireThat } from './store.ts';
import type { WorkflowRuntime } from './workflow-runtime.ts';
import type { NodeNetwork } from './node-network.ts';

export function installWorkflowAPI(app: Express, runtime: WorkflowRuntime, network: NodeNetwork, who: (req: Request) => User) {
  const visible = (req: Request) => {
    const value = runtime.store.get(String(req.params.id));
    requireThat(value && value.creatorID === who(req).id, 404, '协作任务不存在。'); return value;
  };
  const error = (value: unknown): never => { throw value instanceof HttpError || value instanceof z.ZodError ? value :
    new HttpError(409, value instanceof Error ? value.message.slice(0, 300) : 'workflow_operation_failed'); };
  app.post('/api/workflows', (req, res) => {
    try {
      const body = z.object({ requestID: z.string().uuid(), title: z.string().trim().min(1).max(160),
        description: z.string().trim().min(1).max(12_000), criteria: z.string().trim().max(4000).default(''), projectID: z.string().uuid().nullable().default(null),
        model: z.string().min(3).max(200).nullable().default(null), approvalMode: z.enum(['ask', 'auto', 'full']).default('ask'),
        target: z.unknown(), attachmentIDs: z.array(z.string().uuid()).max(taskFileUploadCount).default([]) }).strict().parse(req.body);
      requireThat(validWorkflowTarget(body.target), 400, '协作任务目标无效。');
      const actor = who(req); const ownNodeID = network.snapshot().local?.id;
      requireThat(actor.owner || body.target.mode === 'automatic' || body.target.nodeID === ownNodeID, 403, '只有工作区创建者可以向其他 Node 发起协作执行。');
      if (body.projectID) project(body.projectID);
      const inputFiles = network.files.uploaded(actor.id, body.attachmentIDs);
      const value = runtime.service.create({ requestID: body.requestID, creatorID: actor.id, title: body.title,
        description: body.description, criteria: body.criteria, projectID: body.projectID, model: body.model, approvalMode: body.approvalMode, target: body.target, inputFiles });
      runtime.kick(); res.status(201).json(value);
    } catch (value) { error(value); }
  });
  app.get('/api/workflows/:id', (req, res) => res.json(visible(req)));
  app.post('/api/workflows/:id/control', (req, res) => {
    try {
      const value = visible(req); const body = z.object({ action: z.enum(['pause', 'resume', 'stop', 'retry_planning']) }).strict().parse(req.body);
      const result = runtime.service.control(value.id, body.action); runtime.kick(); res.json(result);
    } catch (value) { error(value); }
  });
  app.post('/api/workflows/:id/confirm', (req, res) => {
    try {
      const value = visible(req); const body = z.object({ nodeID: z.string().min(1).max(80) }).strict().parse(req.body);
      const result = runtime.service.confirm(value.id, body.nodeID); runtime.kick(); res.json(result);
    } catch (value) { error(value); }
  });
  app.post('/api/workflows/:id/steps', (req, res) => {
    try {
      const value = visible(req); const body = z.object({ version: z.number().int().min(1), step: z.unknown() }).strict().parse(req.body);
      requireThat(validWorkflowStepPlan(body.step), 400, '任务步骤无效。');
      const result = runtime.service.editStep(value.id, body.version, body.step); runtime.kick(); res.json(result);
    } catch (value) { error(value); }
  });
}
