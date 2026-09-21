import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TaskFileStore } from '../server/task-files.ts';
import { importWorkflowOutput, importConversationContext, importLegacyConversationContext, relayWorkflowInputs, WorkflowOutputs } from '../server/workflow-files.ts';
import { WorkflowStore } from '../server/workflows.ts';
import { DatabaseSync } from 'node:sqlite';

test('conversation context preserves full requests with repeatable verified attachment bytes', () => {
  const root = resolve('.data', 'unit-conversation-context', randomUUID());
  let files = new TaskFileStore(root); const db = new DatabaseSync(':memory:');
  try {
    const value = new WorkflowStore(db).create({ requestID: randomUUID(), creatorID: 'owner', title: 'Conversation',
      description: '要求'.repeat(5998) + 'END', projectID: null, model: null, target: { mode: 'automatic' }, approvalMode: 'ask', inputFiles: [] });
    const first = importConversationContext(files, value);
    assert.equal(files.view(first.id).state, 'complete');
    const transcript = JSON.parse(files.content(first.id).toString());
    assert.equal(transcript[0].request, value.description); assert(transcript[0].request.endsWith('END'));
    const later = { ...value, rounds: [{ ...value }], roundRequestID: randomUUID(), description: 'New current request' };
    const legacy = importLegacyConversationContext(files, later)!;
    assert.deepEqual(legacy, first, 'Legacy negotiation reuses the exact completed-round transcript');
    assert(!files.content(legacy.id).toString().includes('New current request'));
    assert.equal(importLegacyConversationContext(files, value), undefined);
    files.close(); files = new TaskFileStore(root);
    assert.deepEqual(importConversationContext(files, value), first);
    assert.equal(files.content(first.id).length, first.bytes);
    value.roundRequestID = randomUUID();
    assert.notEqual(importConversationContext(files, value).id, first.id);
  } finally { files.close(); db.close(); }
});

test('existing workflow output records recover the exact original filename across restarts', async () => {
  const root = resolve('.data', 'unit-workflow-location', randomUUID()); const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  const name = '最终成片, 第 1 版.mp4'; await writeFile(join(project, name), 'verified movie');
  const files = new TaskFileStore(join(root, 'storage')); const db = new DatabaseSync(join(root, 'workflow.sqlite'));
  let outputs = new WorkflowOutputs(db, files); const taskID = randomUUID(); const key = `${taskID}:session:run`;
  try {
    let revision = '';
    const file = await importWorkflowOutput(files, key, project, name, () => true, (value) => { revision = value; });
    const oldRecord = { key, taskID, phase: 'complete', files: [file], revisions: { [name]: revision }, error: null };
    db.prepare('INSERT INTO workflow_outputs VALUES (?,?,?)').run(key, taskID, JSON.stringify(oldRecord));
    await outputs.close(); outputs = new WorkflowOutputs(db, files);
    assert.deepEqual(outputs.locations(taskID, file.id, project), [{ root: project, path: join(project, name) }]);
    assert.equal((await files.location(file.id, outputs.locations(taskID, file.id, project))).path, join(project, name));
    assert.deepEqual(outputs.locations(randomUUID(), file.id, project), []);
    assert.deepEqual(outputs.locations(taskID, randomUUID(), project), []);
    await writeFile(join(project, name), 'revised movie');
    assert.notEqual((await files.location(file.id, outputs.locations(taskID, file.id, project))).path, join(project, name));
  } finally { await outputs.close(); db.close(); files.close(); }
});

test('returning a Node output to that Node uses a stable new identity without rebinding its original provenance', async () => {
  const root = resolve('.data', 'unit-workflow-relay', randomUUID()); const project = join(root, 'project');
  await mkdir(project, { recursive: true }); await writeFile(join(project, 'checkpoint.txt'), 'Verified checkpoint');
  let origin = new TaskFileStore(join(root, 'origin')); const worker = new TaskFileStore(join(root, 'worker'));
  try {
    const output = await importWorkflowOutput(worker, 'worker-run', project, 'checkpoint.txt');
    const resultRoute = { scope: 'remote' as const, taskID: randomUUID(), purpose: 'result' as const };
    origin.expectIncoming(resultRoute, [output], 'worker');
    origin.receive(resultRoute, 'worker', output, 0, worker.readChunk(output.id, 0));
    const inputRoute = { scope: 'remote' as const, taskID: randomUUID(), purpose: 'input' as const };
    assert.throws(() => worker.expectIncoming(inputRoute, [output], 'origin'), /其他来源/);
    const [relayed] = await relayWorkflowInputs(origin, 'same-attempt', [output]);
    assert.notEqual(relayed.id, output.id); assert.equal(relayed.sha256, output.sha256);
    worker.expectIncoming(inputRoute, [relayed], 'origin'); worker.receive(inputRoute, 'origin', relayed, 0, origin.readChunk(relayed.id, 0));
    assert.equal(worker.content(relayed.id).toString(), 'Verified checkpoint');
    assert.equal(worker.content(output.id).toString(), 'Verified checkpoint');
    assert.throws(() => worker.receive(inputRoute, 'wrong-peer', relayed), /来源/);
    origin.close(); origin = new TaskFileStore(join(root, 'origin'));
    assert.deepEqual(await relayWorkflowInputs(origin, 'same-attempt', [output]), [relayed]);
    assert.notEqual((await relayWorkflowInputs(origin, 'next-attempt', [output]))[0].id, relayed.id);
    await assert.rejects(relayWorkflowInputs(origin, 'bad-manifest', [{ ...output, sha256: '0'.repeat(64) }]), /not_complete/);
    await assert.rejects(relayWorkflowInputs(origin, 'cancelled', [output], () => false), /cancelled/);
  } finally { origin.close(); worker.close(); }
});

test('business outputs are hashed from pinned project files and reject secret, linked and changed sources', async () => {
  const root = resolve('.data', 'unit-workflow-files', randomUUID()); const project = join(root, 'project');
  await mkdir(project, { recursive: true }); const files = new TaskFileStore(join(root, 'storage'));
  try {
    const bytes = Buffer.alloc(180_000, 53); await writeFile(join(project, 'movie.mp4'), bytes);
    let revision = '';
    const result = await importWorkflowOutput(files, 'execution:session:run', project, 'movie.mp4', () => true, (value) => { revision = value; });
    assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(files.view(result.id).state, 'complete');
    assert.deepEqual(await importWorkflowOutput(files, 'execution:session:run', project, 'movie.mp4'), result);
    for (const path of ['../outside.txt', 'C:\\outside.txt', '.env', 'credentials.json', 'output/token.txt'])
      await assert.rejects(importWorkflowOutput(files, 'other', project, path), /not_exportable/);
    const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'private.txt'), 'private');
    await symlink(outside, join(project, 'linked'), 'junction');
    await assert.rejects(importWorkflowOutput(files, 'other', project, 'linked/private.txt'), /redirected/);
    await writeFile(join(project, 'movie.mp4'), 'modified');
    await assert.rejects(importWorkflowOutput(files, 'execution:session:run', project, 'movie.mp4', () => true, (value) => {
      if (value !== revision) throw new Error('workflow_output_changed');
    }), /changed/);
    await writeFile(join(project, 'racing.txt'), 'before');
    await assert.rejects(importWorkflowOutput(files, 'race', project, 'racing.txt', () => true, () => {
      writeFileSync(join(project, 'racing.txt'), 'after mutation');
    }), /changed/);
    await assert.rejects(importWorkflowOutput(files, 'cancel', project, 'movie.mp4', () => false), /cancelled|changed/);
  } finally { files.close(); }
});
