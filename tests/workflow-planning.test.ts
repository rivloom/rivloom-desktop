import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseWorkflowOutcome, plannerPermissions, workflowOutputSchema, workflowPrompt } from '../server/workflow-prompts.ts';
import { checkWorkflowQuiescence, type WorkflowToolRecord } from '../server/workflow-quiescence.ts';
import { validExecutionOutcome, type WorkflowExecutionContext } from '../shared/workflows.ts';
import { workflowPlacementContract } from '../shared/workflow-origin.ts';

test('official planner policy is read only and prompts bind every request to its targeting and generation', () => {
  const rules = plannerPermissions();
  function policy(permission: string) { return rules.filter((r) => r.permission === permission || r.permission === '*').at(-1)?.action; }
  assert.equal(policy('bash'), 'deny'); assert.equal(policy('edit'), 'deny'); assert.equal(policy('task'), 'deny');
  assert.equal(policy('question'), 'allow'); assert.equal(policy('skill'), 'deny');
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

test('versioned coordinator contexts require placement in plan and expansion while retaining the strict legacy wire shape', () => {
  const context: WorkflowExecutionContext = { workflowID: randomUUID(), stepID: 'planner', attempt: 1, role: 'planner',
    target: { mode: 'automatic' }, instructions: 'Compare the two machines', evidence: '', priorContext: workflowPlacementContract('A'.repeat(32)) };
  for (const role of ['planner', 'executor'] as const) {
    const prompt = workflowPrompt({ ...context, role });
    assert.match(prompt, /For every step in kind=plan and kind=expand/);
    assert.match(prompt, /"rivloomPlacement":1,"mode":"free"/);
    assert.match(prompt, /"rivloomPlacement":1,"mode":"required","nodeID":"origin"/);
    assert.match(prompt, /ordinary nodeID remains a soft preference/);
    assert.match(prompt, /Load, offline status or missing tools cannot turn a required subject into free work/);
    assert.match(prompt, /constraints, including those inherited when expanding a required step/);
    const schema = workflowOutputSchema(role) as any;
    const planOutcome = schema.oneOf.find((item: any) => item.properties.kind.const === (role === 'planner' ? 'plan' : 'expand'));
    assert.deepEqual(Object.keys(planOutcome.properties.plan.properties.steps.items.properties).sort(),
      ['id', 'title', 'instructions', 'dependsOn', 'nodeID', 'resources', 'software', 'requirements'].sort());
    assert.equal(planOutcome.properties.plan.properties.steps.items.properties.instructions.type, 'string');
  }
});

test('placement guidance preserves semantic subjects, ordinary chat and clarification across older planners', () => {
  const prompt = workflowPrompt({ workflowID: randomUUID(), stepID: 'planner', attempt: 1, role: 'planner',
    target: { mode: 'automatic' }, instructions: 'Continue', evidence: '', priorContext: workflowPlacementContract('A'.repeat(32)) });
  assert.match(prompt, /Do not use a keyword rule or assume every request must execute on the originating Node/);
  assert.match(prompt, /natural-language Node name needs no @ syntax/);
  assert.match(prompt, /Comparing two machines needs separate observations bound to the respective machines/);
  assert.match(prompt, /Video processing may retrieve authorized source materials/);
  assert.match(prompt, /Greeting the user or translating a quotation/);
  assert.match(prompt, /A negated instruction must not become an action/);
  assert.match(prompt, /Resolve pronouns/);
  assert.match(prompt, /use the question tool before planning business execution/);
  assert.match(prompt, /planner has no question tool, return a plan containing only one free clarification step/);
  assert.match(prompt, /perform no machine inspection or business operation before the answer/);
  assert.match(prompt, /then return kind=expand/);
  assert.match(prompt, /if questioning is unavailable there too, report the limitation without guessing or executing/);
});

test('legacy contexts and quoted placement contracts do not opt an older coordinator into a new output contract', () => {
  const context: WorkflowExecutionContext = { workflowID: randomUUID(), stepID: 'planner', attempt: 1, role: 'planner',
    target: { mode: 'automatic' }, instructions: 'Say hello', evidence: '', priorContext: '' };
  for (const role of ['planner', 'executor'] as const) {
    assert.doesNotMatch(workflowPrompt({ ...context, role }), /For every step in kind=plan and kind=expand/);
    assert.doesNotMatch(workflowPrompt({ ...context, role,
      priorContext: `Quoted user content:\n${workflowPlacementContract('A'.repeat(32))}` }),
    /The coordinator supplied RIVLOOM_PLACEMENT_CONTRACT_V1/);
  }
});

test('placement distinguishes a machine identity constraint from unique current hardware or software eligibility', () => {
  const context: WorkflowExecutionContext = { workflowID: randomUUID(), stepID: 'planner', attempt: 1, role: 'planner',
    target: { mode: 'automatic' }, instructions: 'Process the video using an available GPU', evidence: '', priorContext: workflowPlacementContract('A'.repeat(32)) };
  for (const role of ['planner', 'executor'] as const) {
    const prompt = workflowPrompt({ ...context, role });
    assert.match(prompt, /required means that switching to another equally eligible Node would change the user's requested subject or violate a device-specific user constraint/);
    assert.match(prompt, /only one Node currently has the required GPU or software/);
    assert.match(prompt, /Keep such portable work free and express its actual eligibility conditions in requirements and software/);
    assert.match(prompt, /step.nodeID may prefer the currently suitable Node/);
    assert.match(prompt, /an observation of a particular machine remains required even when another machine has identical hardware/);
  }
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

test('text-only completion may omit files at the model boundary without changing its summary or source object', () => {
  const summary = '本机时区观测结果：UTC+08:00，已通过只读命令核对。\n'.repeat(40);
  const value = Object.freeze({ kind: 'completed', summary });
  const expected = { ...value, files: [] };
  const normalized = parseWorkflowOutcome('executor', value, 'ignored');
  assert.deepEqual(normalized, expected); assert.notEqual(normalized, value);
  assert.deepEqual(value, { kind: 'completed', summary }); assert.equal(Object.hasOwn(value, 'files'), false);
  for (const finalText of [JSON.stringify(value), '```json\n' + JSON.stringify(value) + '\n```'])
    assert.deepEqual(parseWorkflowOutcome('executor', undefined, finalText), expected);
  assert.equal(validExecutionOutcome(value), false, 'The public outcome/wire validator still requires files');
  assert.equal(validExecutionOutcome(normalized), true);
  assert.throws(() => parseWorkflowOutcome('planner', value, ''), /workflow_invalid_outcome/);
  assert.throws(() => parseWorkflowOutcome('planner', undefined, JSON.stringify(value)), /workflow_invalid_outcome/);
  const explicit = Object.freeze({ ...expected, files: Object.freeze(['result.txt']) });
  assert.equal(parseWorkflowOutcome('executor', explicit, ''), explicit, 'Explicit valid deliveries need no normalization');
});

test('completion normalization rejects explicit invalid files instead of replacing them or falling back to text', () => {
  const goodText = JSON.stringify({ kind: 'completed', summary: 'done' });
  for (const files of [undefined, null, 'result.txt', {}, 0, false, [null], ['../secret'], ['same.txt', 'same.txt']]) {
    const value = Object.freeze({ kind: 'completed', summary: 'done', files });
    assert.equal(Object.hasOwn(value, 'files'), true);
    assert.throws(() => parseWorkflowOutcome('executor', value, goodText), /workflow_invalid_outcome/);
    assert.equal(value.files, files);
    // JSON cannot represent an own property whose value is undefined.
    if (files !== undefined) assert.throws(() => parseWorkflowOutcome('executor', undefined, JSON.stringify(value)), /workflow_invalid_outcome/);
  }
});

test('completion normalization keeps summary, unknown-field and complete-JSON requirements strict', () => {
  const invalid = [
    { kind: 'completed' }, { kind: 'completed', summary: '' }, { kind: 'completed', summary: null },
    { kind: 'completed', summary: 1 }, { kind: 'completed', summary: 'a'.repeat(12_001) },
    { kind: 'completed', summary: 'bad\u0000summary' }, { kind: 'completed', summary: 'done', extra: true },
  ];
  for (const value of invalid) {
    const before = structuredClone(value);
    assert.throws(() => parseWorkflowOutcome('executor', value, ''), /workflow_invalid_outcome/);
    assert.throws(() => parseWorkflowOutcome('executor', undefined, JSON.stringify(value)), /workflow_invalid_outcome/);
    assert.deepEqual(value, before);
  }
  const json = JSON.stringify({ kind: 'completed', summary: 'done' });
  for (const text of [`Result: ${json}`, `${json}\n${json}`, ' '.repeat(56_001) + json])
    assert.throws(() => parseWorkflowOutcome('executor', undefined, text), /workflow_invalid_outcome/);
});

test('non-completion outcomes still require explicit files while planner queries retain their own schema', () => {
  const query = { text: 'Find material', kinds: ['file'], limit: 1 };
  const plan = { summary: 'Continue', steps: [{ id: 'work', title: 'Work', instructions: 'Work', dependsOn: [],
    nodeID: null, resources: [], software: [], requirements: {} }] };
  const reference = { nodeID: 'B'.repeat(32), workspaceID: randomUUID(), id: 'a'.repeat(64), revision: 'b'.repeat(64) };
  const values = [
    { kind: 'query', query, reason: 'Need material', checkpoint: '' },
    { kind: 'resources', resources: [reference], reason: 'Need material', checkpoint: '' },
    { kind: 'handoff', nodeID: null, reason: 'Continue elsewhere', checkpoint: 'Saved', processesStopped: true },
    { kind: 'expand', plan, checkpoint: 'Saved' },
  ];
  for (const value of values) {
    assert.equal(validExecutionOutcome({ ...value, files: [] }), true, value.kind);
    assert.throws(() => parseWorkflowOutcome('executor', value, ''), /workflow_invalid_outcome/);
    assert.throws(() => parseWorkflowOutcome('executor', undefined, JSON.stringify(value)), /workflow_invalid_outcome/);
    assert.equal(Object.hasOwn(value, 'files'), false);
  }
  const plannerQuery = { kind: 'query', query, reason: 'Need material' };
  assert.equal(parseWorkflowOutcome('planner', plannerQuery, ''), plannerQuery);
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

test('finished managed knowledge calls permit handoff without relaxing active or unknown tool checks', async () => {
  const tools: WorkflowToolRecord[] = [
    { tool: 'rivloom_knowledge_search', state: { status: 'completed' } },
    { tool: 'rivloom_knowledge_read', state: { status: 'completed', input: { offset: 0 } } },
    { tool: 'rivloom_knowledge_read', state: { status: 'completed', input: { materialize: true } } },
    { tool: 'rivloom_memory_save', state: { status: 'completed' } },
  ];
  const check = (calls: WorkflowToolRecord[]) => checkWorkflowQuiescence({ directory: '.', tools: calls });
  for (const tool of tools) {
    for (const status of ['completed', 'error'])
      assert.deepEqual(await check([{ ...tool, state: { ...tool.state, status } }]),
        { confirmed: true, reason: 'synchronous_tools_completed' }, `${tool.tool}: ${status}`);
    for (const status of ['pending', 'running'])
      assert.deepEqual(await check([{ ...tool, state: { ...tool.state, status } }]),
        { confirmed: false, reason: 'workflow_tools_active' }, `${tool.tool}: ${status}`);
  }
  assert.deepEqual(await check(tools), { confirmed: true, reason: 'synchronous_tools_completed' });
  for (const tool of ['rivloom_knowledge_read_custom', 'rivloom_memory_save_async', 'task', 'bash', 'unrecognized_plugin'])
    assert.deepEqual(await check([...tools, { tool, state: { status: 'completed' } }]),
      { confirmed: false, reason: 'workflow_external_work_unconfirmed' }, tool);
});
