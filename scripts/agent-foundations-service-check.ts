// Real application routes and official engine startup; no task or model inference is requested.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelFixture, ServiceClient } from './m34-fixtures.ts';
import { isolatedWorkspace, testEnvironment } from './ci-workspace.ts';
import { loadNodeIdentity } from '../server/node-identity.ts';
import { projectGitEnvironment } from '../server/project-changes.ts';
import type { PromptTemplate, PromptTemplateList } from '../shared/prompt-templates.ts';
import type { ProjectChanges, ProjectDiff } from '../shared/project-changes.ts';
import type { Project } from '../shared/types.ts';

export async function checkAgentFoundations(root = resolve(import.meta.dirname, '..')) {
  const base = join(root, '.data', 'verification', 'agent-foundations-20260918');
  await mkdir(base, { recursive: true });
  const evidence = await mkdtemp(join(base, 'service-'));
  const runtime = await isolatedWorkspace('agent-foundations', root);
  const application = join(runtime, '.data', 'application'), home = join(runtime, 'home');
  await mkdir(home);
  const originalEnvironment = { ...process.env };
  const environment = { ...testEnvironment(runtime), HOME: home, USERPROFILE: home,
    RIVLOOM_MDNS_NETWORK: 'disabled', RIVLOOM_DISCOVERY_FALLBACK: 'disabled' };
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, environment);
  const fixture = await modelFixture();
  const owner = new ServiceClient(application), member = new ServiceClient(application), anonymous = new ServiceClient(application);
  const checks: string[] = [];
  const pass = (value: string) => { checks.push(value); console.log(`PASS ${value}`); };
  let failure: unknown, indexSha256: string | null = null;
  const sourceFiles = ['server/index.ts', 'server/project-changes.ts', 'server/project-changes-api.ts',
    'server/prompt-templates.ts', 'server/prompt-template-api.ts'];
  const sourceDigests = Object.fromEntries(await Promise.all(sourceFiles.map(async path =>
    [path, createHash('sha256').update(await readFile(join(runtime, path))).digest('hex')])));
  try {
    fixture.configure(application); loadNodeIdentity(application);
    await owner.start({ runtimeDirectory: runtime, logPath: join(evidence, 'service.log') });
    member.base = anonymous.base = owner.base;
    const invitation = await owner.call<{ code: string }>('/invitations', {});
    const memberPassword = `fixture-${randomUUID()}`;
    await member.call('/auth/join', { code: invitation.code, username: 'foundation_member', name: 'Fixture member', password: memberPassword });
    await anonymous.call('/prompt-templates', undefined, 401);
    await anonymous.call(`/projects/${randomUUID()}/changes`, undefined, 401);
    const templateID = randomUUID();
    const content = { title: 'Review template', text: 'Review {{project}} literally.\nDo not execute this template.' };
    await owner.call('/prompt-templates', { id: templateID, ...content }, 403, { Origin: 'https://untrusted.example' });
    await owner.call('/prompt-templates', { id: templateID, ...content, userID: 'other' }, 400);
    await owner.call('/prompt-templates', { id: templateID, ...content }, 403, { 'X-Rivloom-Request': '0' });
    pass('Real authentication, origin and strict request schemas protect template and project routes');

    const created = await owner.call<PromptTemplate>('/prompt-templates', { id: templateID, ...content }, 201);
    assert.equal(created.revision, 1);
    assert.deepEqual(await owner.call('/prompt-templates', { id: templateID, ...content }, 201), created);
    await owner.call('/prompt-templates', { id: templateID, ...content, title: 'Conflicting retry' }, 409);
    await member.call(`/prompt-templates/${templateID}`, undefined, 404);
    await member.call(`/prompt-templates/${templateID}`, { revision: 1, ...content }, 404);
    await member.call(`/prompt-templates/${templateID}/delete`, { revision: 1 }, 404);
    const memberTemplate = await member.call<PromptTemplate>('/prompt-templates', { id: templateID, title: 'Member only', text: 'Member private template' }, 201);
    assert.equal((await owner.call<PromptTemplateList>('/prompt-templates')).templates[0].text, content.text);
    assert.deepEqual((await member.call<PromptTemplateList>('/prompt-templates')).templates, [memberTemplate]);
    const edited = await owner.call<PromptTemplate>(`/prompt-templates/${templateID}`, { revision: 1, ...content, title: 'Edited template' });
    assert.equal(edited.revision, 2);
    await owner.call(`/prompt-templates/${templateID}`, { revision: 1, ...content }, 409);
    const races = await Promise.all(['Concurrent A', 'Concurrent B'].map(async title => {
      const response = await fetch(`${owner.base}/api/prompt-templates/${templateID}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rivloom-Request': '1', Cookie: owner.cookie },
        body: JSON.stringify({ ...content, title, revision: 2 }), signal: AbortSignal.timeout(10_000),
      });
      return { status: response.status, value: await response.json() as PromptTemplate };
    }));
    assert.deepEqual(races.map(result => result.status).sort(), [200, 409]);
    const winner = races.find(result => result.status === 200)!.value;
    assert.equal(winner.revision, 3);
    assert.deepEqual(await member.call(`/prompt-templates/${templateID}`), memberTemplate);
    pass('Templates preserve literal text and user isolation; duplicate creation and concurrent stale revisions cannot overwrite another write');

    const directory = join(runtime, 'project'); await mkdir(directory);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, windowsHide: true, encoding: 'utf8', env: projectGitEnvironment() });
    git('init', '-q');
    await writeFile(join(directory, 'example.txt'), 'original\n'); git('add', 'example.txt');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'isolated test baseline');
    await writeFile(join(directory, 'example.txt'), 'staged\n'); git('add', 'example.txt');
    await writeFile(join(directory, 'example.txt'), 'working\n');
    await writeFile(join(directory, 'notes.txt'), 'untracked fixture\n');
    await writeFile(join(directory, '.npmrc'), '//registry.npmjs.org/:_authToken=fixture-private\n');
    const before = await readFile(join(directory, '.git', 'index'));
    const project = await owner.call<Project>('/projects', { name: 'Agent foundation fixture', directory, trusted: true }, 201);
    await member.call('/projects', { name: 'Not authorized', directory: home, trusted: true }, 403);
    await member.call(`/projects/${project.id}/changes`, undefined, 403);
    await member.call(`/projects/${project.id}/changes/diff`, { path: 'example.txt', area: 'working' }, 403);
    await owner.call(`/projects/${randomUUID()}/changes`, undefined, 404);
    await owner.call(`/projects/${project.id}/changes/diff`, { path: '../outside.txt', area: 'working' }, 400);
    await owner.call(`/projects/${project.id}/changes/diff`, { path: 'example.txt', area: 'working', directory: home }, 400);
    await owner.call(`/projects/${project.id}/changes/diff`, { path: 'example.txt', area: 'working' }, 403, { Origin: 'https://untrusted.example' });
    const changes = await owner.call<ProjectChanges>(`/projects/${project.id}/changes`);
    assert.equal(changes.state, 'ready');
    const changed = changes.files.find(value => value.path === 'example.txt'); assert.equal(changed?.index, 'M'); assert.equal(changed?.worktree, 'M');
    const staged = await owner.call<ProjectDiff>(`/projects/${project.id}/changes/diff`, { path: 'example.txt', area: 'staged' });
    const working = await owner.call<ProjectDiff>(`/projects/${project.id}/changes/diff`, { path: 'example.txt', area: 'working' });
    assert.equal(staged.state, 'ready'); assert.match(staged.text, /\+staged/); assert.doesNotMatch(staged.text, /\+working/);
    assert.equal(working.state, 'ready'); assert.match(working.text, /-staged/); assert.match(working.text, /\+working/);
    const untracked = await owner.call<ProjectDiff>(`/projects/${project.id}/changes/diff`, { path: 'notes.txt', area: 'working' });
    assert.equal(untracked.kind, 'file'); assert.equal(untracked.text, 'untracked fixture\n');
    const missing = await owner.call<ProjectDiff>(`/projects/${project.id}/changes/diff`, { path: 'missing.txt', area: 'working' });
    assert.equal(missing.state, 'changed'); assert.equal(missing.text, '');
    const sensitive = await owner.call<ProjectDiff>(`/projects/${project.id}/changes/diff`, { path: '.npmrc', area: 'working' });
    assert.equal(sensitive.state, 'sensitive'); assert.equal(sensitive.text, '');
    assert.deepEqual(await readFile(join(directory, '.git', 'index')), before);
    assert.equal(await readFile(join(directory, 'example.txt'), 'utf8'), 'working\n');
    indexSha256 = createHash('sha256').update(before).digest('hex');
    pass('Owner-only registered project review separates staged/working patches and untracked files while preserving index and workspace bytes');

    await owner.stop(); assert.equal(owner.child?.exitCode, 0, 'The owned service must stop normally');
    await owner.start({ runtimeDirectory: runtime, logPath: join(evidence, 'restart.log') });
    member.base = owner.base; member.cookie = '';
    await member.call('/auth/login', { username: 'foundation_member', password: memberPassword });
    assert.deepEqual(await owner.call(`/prompt-templates/${templateID}`), winner);
    assert.deepEqual(await member.call(`/prompt-templates/${templateID}`), memberTemplate);
    assert.equal((await owner.call<ProjectChanges>(`/projects/${project.id}/changes`)).state, 'ready');
    assert.deepEqual(await readFile(join(directory, '.git', 'index')), before);
    await owner.call(`/prompt-templates/${templateID}/delete`, { revision: 2 }, 409);
    await owner.call(`/prompt-templates/${templateID}/delete`, { revision: winner.revision });
    await owner.call(`/prompt-templates/${templateID}`, undefined, 404);
    assert.deepEqual(await member.call(`/prompt-templates/${templateID}`), memberTemplate);
    assert.equal(fixture.requests, 0);
    await owner.stop(); assert.equal(owner.child?.exitCode, 0);
    pass('Restart preserves both users templates, CAS revisions and project registration; stale deletion is rejected and zero model requests occur');
  } catch (error) { failure = error; }
  finally {
    try { await owner.stop(); } catch (error) { failure ||= error; }
    await fixture.close();
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, originalEnvironment);
    await writeFile(join(evidence, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checks,
      runtime, application, sourceDigests, indexSha256, modelRequests: fixture.requests,
      platform: process.platform, arch: process.arch, shutdownExitCode: owner.child?.exitCode,
      scope: 'Isolated real server/index.ts routes, SQLite persistence and official engine startup. Loopback provider configured only; no inference, user data, remote workflows or publication.',
      ...(failure ? { error: String(failure) } : {}) }, null, 2) + '\n');
  }
  console.log(`Agent foundation report: ${join(evidence, 'report.json')}`);
  if (failure) throw failure;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await checkAgentFoundations();
