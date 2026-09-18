// Synthetic UI fixture, using the production diagnostic reducer. No model or real device access.
import { resolve } from 'node:path';
import { workflowStep } from '../server/workflows.ts';
import { workflowDiagnostics } from '../server/workflow-diagnostics.ts';
import type { WorkflowStep, WorkflowAttempt } from '../shared/workflows.ts';
import type { WorkflowStepDiagnostic } from '../shared/workflow-diagnostics.ts';
import { startSearchPreview } from './conversation-search-preview.ts';

export async function startWorkflowDiagnosticsPreview() {
  let fail = false, release: (() => void) | null = null, delayNext = false;
  let queueState: NonNullable<WorkflowStepDiagnostic['queue']>['state'] = 'queued';
  const preview = await startSearchPreview(resolve('dist'), async (req, res, data) => {
    const match = /^\/api\/workflows\/([^/]+)\/diagnostics$/.exec(req.url || '');
    if (!match) return false;
    const value = data.workflows!.find((w) => w.id === match[1]);
    const local = data.network.local!.id, remote = data.network.paired![0].id;
    const result = value ? workflowDiagnostics(value, {
      placement: () => ({ candidates: [], nodes: [
        { nodeID: local, reasons: [{ code: 'software_unknown', certainty: 'unknown', software: 'FFmpeg', observedAt: '2026-09-16T14:32:00Z' }] },
        { nodeID: remote, reasons: [{ code: 'node_offline', certainty: 'confirmed', observedAt: '2026-09-17T06:32:00Z' }] },
      ] }),
      preparation: (step) => step.id === 'materials' ? { nodeID: remote, observedAt: value.updatedAt } : null,
      execution: (attempt) => ({ connected: attempt.context.stepID !== 'unknown', observedAt: attempt.updatedAt, attention: false,
        queue: attempt.phase === 'queued' ? { state: queueState, position: queueState === 'queued' ? 2 : null,
          reason: null, code: null, observedAt: attempt.updatedAt, local: false } : null }),
    }) : { error: 'Missing fixture workflow' };
    if (delayNext) { delayNext = false; await new Promise<void>((ok) => { release = ok; }); release = null; }
    res.writeHead(fail ? 503 : value ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(fail ? { error: 'Synthetic status outage' } : result));
    return true;
  });
  const data = preview.data;
  const value = data.workflows![1];
  value.title = '多机任务状态验收'; value.description = '整理素材、生成音频，再合成产品短片。'; value.state = 'running';
  value.rounds = []; value.summary = ''; value.error = null;
  const blank = (id: string, title: string, dependsOn: string[] = []) => workflowStep({ id, title, instructions: '仅用于诊断界面验收。',
    dependsOn, nodeID: null, software: [], requirements: {}, resources: [] });
  const attempt = (step: WorkflowStep, phase: WorkflowAttempt['phase']) => ({
    ...structuredClone(value.steps[1].attempts[1]), executionID: `fixture-${step.id}`, number: 1, phase, kind: 'local' as const,
    nodeID: data.network.local!.id, error: null, updatedAt: '2026-09-17T06:30:00Z', handled: false,
    context: { ...value.steps[1].attempts[1].context, workflowID: value.id, stepID: step.id },
  });
  const audio = blank('audio', '生成音频'); audio.state = 'running'; audio.attempts = [attempt(audio, 'running')];
  const video = blank('video', '视频转码');
  const join = blank('join', '整理交付成果', ['audio', 'video']);
  const materials = blank('materials', '准备字幕材料');
  const queued = blank('queue', '生成封面'); queued.state = 'running'; queued.attempts = [attempt(queued, 'queued')];
  const unknown = blank('unknown', '检查远端字幕'); unknown.state = 'running'; unknown.attempts = [attempt(unknown, 'unknown')];
  value.steps = [audio, video, join, materials, queued, unknown];
  data.workflows = [value]; data.tasks = []; data.conversationPreferences = {};
  data.network.local!.name = '工作笔记本'; data.network.paired![0].name = '书房电脑';
  data.network.paired![0].online = false; data.network.paired![0].lastContactAt = '2026-09-17T06:32:00Z';
  return { ...preview, value, fail: (enabled: boolean) => { fail = enabled; },
    queue: (state: typeof queueState) => { queueState = state; },
    delay: () => { delayNext = true; }, held: () => !!release, release: () => release?.(),
    phase: (id: string, phase: WorkflowStepDiagnostic['phase']) => {
      const step = value.steps.find((s) => s.id === id)!;
      if (phase === 'failed') { step.state = 'failed'; step.attempts = [attempt(step, 'failed')]; step.attempts[0].handled = true; }
    } };
}
