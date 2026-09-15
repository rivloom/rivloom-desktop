// Real encrypted Nodes and official OpenCode; all model replies are local deterministic fixtures.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createSocket } from 'node:dgram';
import { modelFixture, ServiceClient, pairServices, until, type FixtureModelReply } from './m34-fixtures.ts';
import type { KnowledgeRef, LocalKnowledgeEntry } from '../shared/knowledge.ts';

const root = resolve('.data', 'knowledge-service', String(Date.now())); mkdirSync(root, { recursive: true });
const assertions: string[] = []; const pass = (v: string) => { assertions.push(v); console.log('PASS', v); };
let projectID = ''; let projectDirectory = ''; let skillRef: KnowledgeRef; let memoryRef: KnowledgeRef;
let localPath = ''; const outputs: any[] = []; let bound = 0;
const fixture = await modelFixture(120_000, (input): FixtureModelReply => {
  const user = input.messages.filter((m: any) => m.role === 'user').map((m: any) => JSON.stringify(m.content)).join('\n');
  if (user.includes('KNOWLEDGE_APPROVAL_CASE')) {
    if (input.messages.some((m: any) => m.role === 'tool')) return { content: 'Memory write was rejected; no memory saved.' };
    return { toolName: 'rivloom_memory_save', arguments: { name: 'Must remain unapproved', description: 'Permission fixture', category: 'Tests/Approval', projectID, body: 'Never save without permission.' } };
  }
  if (!user.includes('KNOWLEDGE_ENGINE_CASE')) return { content: 'Knowledge test' };
  const system = input.messages.filter((m: any) => m.role === 'system').map((m: any) => JSON.stringify(m.content)).join('\n');
  assert(system.includes('NODE_RULE_PROOF') && system.includes('PROJECT_RULE_PROOF'));
  assert(!system.includes('PRIVATE_MEMORY_BODY')); bound++;
  const names = input.tools?.map((t: any) => t.function.name) || [];
  assert(names.includes('rivloom_knowledge_search') && names.includes('rivloom_knowledge_read') && names.includes('rivloom_memory_save'), JSON.stringify(names));
  const calls = input.messages.filter((m: any) => m.role === 'assistant').flatMap((m: any) => m.tool_calls || []);
  const results = input.messages.filter((m: any) => m.role === 'tool');
  const stage = calls.length;
  if (results.length) {
    const text = typeof results.at(-1).content === 'string' ? results.at(-1).content : JSON.stringify(results.at(-1).content);
    assert(!text.includes('knowledge_task_not_active') && !text.includes('knowledge_request_failed'), text);
    if (stage !== 4) { const value = JSON.parse(text); outputs[stage - 1] = value; }
  }
  if (stage === 0) return { toolName: 'rivloom_knowledge_search', arguments: { kind: 'skill', text: 'proof', brainID: skillRef.brainID } };
  if (stage === 1) { assert(outputs[0].entries.some((e: any) => e.id === skillRef.id)); return { toolName: 'rivloom_knowledge_read', arguments: skillRef }; }
  if (stage === 2) { assert(outputs[1].content.includes('LATEST_SKILL')); return { toolName: 'rivloom_knowledge_read', arguments: { ...skillRef, file: 'scripts/proof.mjs', materialize: true } }; }
  if (stage === 3) {
    localPath = outputs[2].localPath; assert(localPath && !localPath.includes('..'));
    return { toolName: 'bash', arguments: { command: `node "${localPath}"`, description: 'Run the retrieved fixture skill in this project' } };
  }
  if (stage === 4) { assert.equal(readFileSync(join(projectDirectory, 'skill-result.txt'), 'utf8'), 'verified remote skill'); return { toolName: 'rivloom_knowledge_read', arguments: memoryRef }; }
  if (stage === 5) { assert(outputs[4].content.includes('SHARED_MEMORY_BODY')); return { toolName: 'rivloom_memory_save', arguments: {
    name: 'Verified skill result', description: 'Result of the fixture task', category: 'Projects/Fixture/Results', projectID,
    body: 'Source: this isolated test task. Retrieved and ran the proof skill successfully.',
  } }; }
  assert.equal(stage, 6); assert.deepEqual(outputs[5].sharedBrains, []);
  return { content: 'Knowledge fixture completed with verified skill and local memory.' };
});
fixture.release();
const clients = ['master', 'source', 'reader'].map((name) => new ServiceClient(join(root, name)));
const [master, source, reader] = clients;
const socket = createSocket('udp4'); await new Promise<void>((ok) => socket.bind(0, '127.0.0.1', ok));
const port = socket.address().port; await new Promise<void>((ok) => socket.close(() => ok()));
const discovery = { port, mdns: false };
let status = 'failed'; let failure = '';
try {
  for (const client of clients) fixture.configure(client.root);
  // A lone host establishes its Brain before the other Nodes discover it.
  await master.start({ discovery, logPath: join(root, 'master.log') });
  const host = await until(() => master.network(), (n) => n.brains.some((b) => b.hosted && b.state === 'established'), 'established Brain');
  const brainID = host.brains.find((b) => b.hosted)!.id;
  await Promise.all([source, reader].map((c, i) => c.start({ discovery, logPath: join(root, `${i}.log`) })));
  await pairServices(master, source); await pairServices(master, reader);
  for (const client of [source, reader]) await until(() => client.network(), (n) => n.brains.some((b) => b.id === brainID), 'shared Brain');
  const sourceID = (await source.network()).local!.id;
  assert(!(await reader.network()).paired?.some((p) => p.id === sourceID));
  const directory = join(source.root, 'proof-skill'); mkdirSync(join(directory, 'scripts'), { recursive: true });
  writeFileSync(join(directory, 'SKILL.md'), '---\nname: proof-skill\ndescription: A deterministic proof skill\n---\nINITIAL_SKILL\n');
  writeFileSync(join(directory, 'scripts', 'proof.mjs'), "import { writeFileSync } from 'node:fs';\nif (process.env.RIVLOOM_KNOWLEDGE_BRIDGE_TOKEN) throw new Error('bridge secret leaked');\nwriteFileSync('skill-result.txt', 'verified remote skill');\n");
  let skill = await source.call<LocalKnowledgeEntry>('/knowledge/skills/register', { directory, projectID: null });
  let memory = await source.call<LocalKnowledgeEntry>('/knowledge/memory', { name: 'Shared work', description: 'Fixture responsibility', category: 'People/Fixture/Work', projectID: null, body: 'SHARED_MEMORY_BODY' });
  await source.call('/knowledge/memory', { name: 'Private profile', description: 'Private fixture profile', category: 'People/Fixture/Profile', projectID: null, body: 'PRIVATE_MEMORY_BODY' });
  assert.equal((await reader.call('/knowledge/search', { brainID })).entries.length, 0);
  await source.call('/knowledge/share-many', { entries: [skill, memory].map(({ id, revision, updatedAt }) => ({ id, revision, updatedAt })), brains: [brainID] });
  const catalog = await reader.call('/knowledge/search', { brainID });
  assert.equal(catalog.entries.length, 2); assert(!JSON.stringify(catalog).includes('MEMORY_BODY'));
  assert((await master.call('/knowledge/search', { brainID })).entries.some((e: any) => e.id === skill.id));
  pass('Three real Nodes: A discovers B through Brain without A/B pairing; private entries and bodies stay out of catalogs');
  skillRef = { brainID, nodeID: sourceID, id: skill.id }; memoryRef = { brainID, nodeID: sourceID, id: memory.id };
  writeFileSync(join(directory, 'SKILL.md'), '---\nname: proof-skill\ndescription: A deterministic proof skill\n---\nLATEST_SKILL: read and run scripts/proof.mjs using ordinary task tools.\n');
  const latest = await reader.call('/knowledge/read', skillRef);
  assert(latest.body.includes('LATEST_SKILL')); assert.notEqual(latest.entry.revision, skill.revision);
  pass('Reading through Brain fetches the source Node’s latest Skill revision');
  projectDirectory = join(reader.root, 'selected-project'); mkdirSync(projectDirectory);
  const project = await reader.call('/projects', { name: 'Knowledge fixture', directory: projectDirectory, trusted: true }, 201); projectID = project.id;
  for (const [id, body] of [[null, 'NODE_RULE_PROOF'], [projectID, 'PROJECT_RULE_PROOF']] as const) {
    const rules = await reader.call('/knowledge/rules/read', { projectID: id });
    await reader.call('/knowledge/rules/save', { projectID: id, revision: rules.revision, body });
  }
  const owner = (await reader.bootstrap()).user;
  const task = await reader.call('/tasks', { projectID, title: 'KNOWLEDGE_ENGINE_CASE', description: 'KNOWLEDGE_ENGINE_CASE use the shared proof skill, read shared work memory, and save sourced result memory.', criteria: 'Verified remote skill result', assigneeID: owner.id, approverID: owner.id, reviewerID: owner.id, model: 'fixture/m34', approvalMode: 'auto' }, 201);
  await reader.call(`/tasks/${task.id}/claim`, {}); await reader.call(`/tasks/${task.id}/run`, { confirmed: true });
  const complete = await until(() => reader.call(`/tasks/${task.id}`), (v) => ['accepted', 'failed', 'waiting_approval'].includes(v.task.state), 'official knowledge tool execution', 90_000);
  assert.equal(complete.task.state, 'accepted', JSON.stringify(complete));
  assert(bound >= 7); assert.equal(readFileSync(join(projectDirectory, localPath), 'utf8'), readFileSync(join(directory, 'scripts/proof.mjs'), 'utf8'));
  const saved = (await reader.call('/knowledge')).entries.find((e: any) => e.name === 'Verified skill result'); assert(saved); assert.deepEqual(saved.sharedBrains, []);
  pass('Official OpenCode discovers, progressively loads and runs a remote Skill, reads Wiki, saves private memory and loads both rule layers; bridge secret absent from command environment');
  const guarded = await reader.call('/tasks', { projectID, title: 'KNOWLEDGE_APPROVAL_CASE', description: 'KNOWLEDGE_APPROVAL_CASE', criteria: 'No unapproved memory write', assigneeID: owner.id, approverID: owner.id, reviewerID: owner.id, model: 'fixture/m34', approvalMode: 'ask' }, 201);
  await reader.call(`/tasks/${guarded.id}/claim`, {}); await reader.call(`/tasks/${guarded.id}/run`, { confirmed: true });
  const waiting = await until(() => reader.call(`/tasks/${guarded.id}`), (v) => v.task.state === 'waiting_approval', 'memory approval');
  assert.equal(waiting.task.approvals[0].permission, 'rivloom_memory_save');
  assert(!(await reader.call('/knowledge')).entries.some((e: any) => e.name === 'Must remain unapproved'));
  await reader.call(`/tasks/${guarded.id}/permissions/${waiting.task.approvals[0].id}`, { reply: 'reject' });
  await until(() => reader.call(`/tasks/${guarded.id}`), (v) => v.task.state === 'accepted', 'rejected write finishes');
  assert(!(await reader.call('/knowledge')).entries.some((e: any) => e.name === 'Must remain unapproved'));
  pass('Official ask mode pauses memory writes for approval; rejection leaves memory unchanged');
  skill = (await source.call('/knowledge')).entries.find((e: any) => e.id === skill.id);
  await source.call('/knowledge/share', { id: skill.id, revision: skill.revision, updatedAt: skill.updatedAt, brains: [] });
  await reader.call('/knowledge/read', skillRef, 409);
  assert(!(await reader.call('/knowledge/search', { brainID })).entries.some((e: any) => e.id === skill.id));
  pass('Revocation blocks subsequent discovery and reads through Brain');
  await reader.stop();
  const previousNetwork = process.env.RIVLOOM_NODE_NETWORK;
  process.env.RIVLOOM_NODE_NETWORK = 'disabled';
  try { await reader.start({ discovery }); } finally {
    if (previousNetwork === undefined) delete process.env.RIVLOOM_NODE_NETWORK; else process.env.RIVLOOM_NODE_NETWORK = previousNetwork;
  }
  assert((await reader.call('/knowledge')).entries.some((e: any) => e.id === saved.id));
  assert.equal((await reader.call('/knowledge/rules/read', { projectID: null })).body, 'NODE_RULE_PROOF');
  assert.equal((await reader.network()).status, 'disabled');
  pass('Wiki and local rules survive restart and remain available with Node discovery disabled');
  status = 'passed';
} catch (error) { failure = String(error); console.error(error); process.exitCode = 1; }
finally {
  await Promise.allSettled(clients.map((c) => c.stop())); await fixture.close();
  const report = { status, assertions, failure, modelRequests: fixture.requests, root };
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
