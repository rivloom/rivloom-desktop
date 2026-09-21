import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseWorkflowOutcome, plannerPermissions, workflowOutputSchema, workflowPrompt } from '../server/workflow-prompts.ts';
import { checkWorkflowQuiescence, type WorkflowToolRecord } from '../server/workflow-quiescence.ts';
import type { WorkflowExecutionContext } from '../shared/workflows.ts';

test('official planner policy is read only and prompts bind every request to its targeting and generation', () => {
  const rules = plannerPermissions();
  function policy(permission: string) { return rules.filter((r) => r.permission === permission || r.permission === '*').at(-1)?.action; }
  assert.equal(policy('bash'), 'deny'); assert.equal(policy('edit'), 'deny'); assert.equal(policy('task'), 'deny');
  assert.equal(policy('read'), 'deny'); // last credential-specific read rule is retained
  assert(rules.some((r) => r.permission === 'read' && r.pattern === '*' && r.action === 'allow'));
  assert.equal(policy('StructuredOutput'), 'allow');
  const context: WorkflowExecutionContext = { workflowID: randomUUID(), stepID: 'planner', attempt: 1, role: 'planner',
    target: { mode: 'locked', nodeID: 'B'.repeat(32) }, instructions: '剪辑这个视频', evidence: '', priorContext: '' };
  const prompt = workflowPrompt(context); assert.match(prompt, /只允许读取和规划/); assert.match(prompt, /剪辑这个视频/);
  assert.match(prompt, /所有执行步骤必须留在 Node BBB/); assert.match(prompt, /包括很短的请求/);
  assert.notDeepEqual(workflowOutputSchema('planner'), workflowOutputSchema('executor'));
  assert.throws(() => workflowPrompt({ ...context, evidence: '界'.repeat(28_000) }), /workflow_invalid_context/);
});
test('structured outcome parsing rejects invalid supplied structures and accepts only bounded complete JSON fallback', () => {
  const value = { kind: 'completed', summary: 'done', files: ['output/movie.mp4'] };
  assert.deepEqual(parseWorkflowOutcome('executor', value, 'ignored'), value);
  assert.deepEqual(parseWorkflowOutcome('executor', undefined, '```json\n' + JSON.stringify(value) + '\n```'), value);
  assert.throws(() => parseWorkflowOutcome('executor', { ...value, extra: true }, JSON.stringify(value)), /invalid_outcome/);
  assert.throws(() => parseWorkflowOutcome('executor', undefined, `Result: ${JSON.stringify(value)}`), /invalid_outcome/);
  for (const path of ['../secret', 'C:\\secret', '/etc/passwd', 'a/../secret', 'file:stream'])
    assert.throws(() => parseWorkflowOutcome('executor', { ...value, files: [path] }, ''), /invalid_outcome/);
  assert.throws(() => parseWorkflowOutcome('planner', value, ''), /invalid_outcome/);
  assert.throws(() => parseWorkflowOutcome('planner', undefined, `${JSON.stringify(value)}\n${JSON.stringify(value)}`), /invalid_outcome/);
});

test('planner file reference schema matches accepted catalog references and rejects tool names or versions', () => {
  const schema = workflowOutputSchema('planner') as any;
  const properties = schema.oneOf[0].properties.plan.properties.steps.items.properties.resources.items.properties;
  const valid = { nodeID: 'B'.repeat(32), workspaceID: randomUUID(), id: 'a'.repeat(64), revision: 'b'.repeat(64) };
  for (const [key, value] of Object.entries(valid)) assert(new RegExp(properties[key].pattern).test(value));
  for (const value of ['ffmpeg', 'version:8.1.1', 'C'.repeat(64), '']) {
    assert(!new RegExp(properties.id.pattern).test(value)); assert(!new RegExp(properties.revision.pattern).test(value));
  }
});
test('handoff quiescence uses tool and process evidence, rejecting opaque scripts and asynchronous shell launches', async () => {
  const read: WorkflowToolRecord = { tool: 'read', state: { status: 'completed', input: { filePath: 'script.md' } } };
  assert((await checkWorkflowQuiescence({ directory: '.', tools: [read] })).confirmed);
  assert(!(await checkWorkflowQuiescence({ directory: '.', tools: [{ ...read, state: { status: 'running' } }] })).confirmed);
  const command = (command: string): WorkflowToolRecord => ({ tool: 'bash', state: { status: 'completed', input: { command } } });
  for (const unsafe of ['python render.py', 'Start-Process ffmpeg', 'C:\\tools\\ffmpeg.exe -i a.mp4 b.mp4 &', 'C:\\tools\\ffmpeg.exe -i a; echo x', '`evil`']) {
    const result = await checkWorkflowQuiescence({ directory: '.', tools: [command(unsafe)], trustedMediaBinary: async (file) => /ffmpeg\.exe$/.test(file), mediaProcesses: async () => 0 });
    assert(!result.confirmed, unsafe);
  }
  const tools = [command('& "C:\\tools\\ffmpeg.exe" -i "a.mp4" "b.mp4"')];
  const options = { directory: '.', tools, trustedMediaBinary: async () => true };
  assert((await checkWorkflowQuiescence({ ...options, mediaProcesses: async () => 0 })).confirmed);
  assert(!(await checkWorkflowQuiescence({ ...options, mediaProcesses: async () => 1 })).confirmed);
  assert(!(await checkWorkflowQuiescence({ ...options, mediaProcesses: async () => { throw new Error('unavailable'); } })).confirmed);
});

test('finished workflow history tools permit handoff while active or unknown tools remain blocked', async () => {
  const history: WorkflowToolRecord = { tool: 'rivloom_history', state: { status: 'completed', input: { action: 'read', offset: 4000 } } };
  const note: WorkflowToolRecord = { tool: 'rivloom_context_note', state: { status: 'completed' } };
  const check = (tools: WorkflowToolRecord[]) => checkWorkflowQuiescence({ directory: '.', tools });
  assert.deepEqual(await check([history, note]), { confirmed: true, reason: 'synchronous_tools_completed' });
  assert((await check([{ ...history, state: { status: 'error' } }])).confirmed);
  for (const tool of [history, note]) for (const status of ['pending', 'running'])
    assert.deepEqual(await check([{ ...tool, state: { status } }]), { confirmed: false, reason: 'workflow_tools_active' });
  for (const tool of ['rivloom_history_custom', 'task', 'bash', 'unrecognized_plugin'])
    assert.deepEqual(await check([history, { tool, state: { status: 'completed' } }]),
      { confirmed: false, reason: 'workflow_external_work_unconfirmed' });
});
