import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { listenHttp } from '../server/http-ports.ts';
import { mkdir, mkdtemp, writeFile, readFile, rm, symlink, link, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, sep, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { parseProjectStatus, validProjectChangePath, projectDiffByteLimit, sensitiveProjectChangePath } from '../shared/project-changes.ts';
import { projectGitEnvironment, readProjectChanges, readProjectDiff } from '../server/project-changes.ts';
import { installProjectChangesAPI } from '../server/project-changes-api.ts';
import express from 'express';

const base = resolve('.data', 'unit-project-changes');
async function fixture(fn: (root: string, git: (...args: string[]) => string) => Promise<void>) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'case-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env: projectGitEnvironment(), encoding: 'utf8', windowsHide: true }).trim();
  try { git('init', '-q'); await fn(root, git); }
  finally { assert(root.startsWith(base + sep) && root !== base); await rm(root, { recursive: true, force: true }); }
}
async function seed(root: string, git: (...args: string[]) => string) {
  await writeFile(join(root, 'example.txt'), 'before\n');
  git('add', 'example.txt'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'isolated fixture');
}

test('project status handles spaces, Unicode, rename records and scoped directories without unquoting paths', () => {
  const parsed = parseProjectStatus('## main...origin/main\0 M scope/名字 file.txt\0R  scope/new.txt\0scope/old.txt\0?? scope/notes.md\0 M sibling/private.txt\0', 'scope/');
  assert.equal(parsed.branch, 'main'); assert.deepEqual(parsed.files.map(file => file.path), ['名字 file.txt', 'new.txt', 'notes.md']);
  assert.equal(parsed.files[2].untracked, true);
  assert.equal(parseProjectStatus('UU conflict.txt\0').files[0].conflict, true);
  assert.equal(parseProjectStatus('?? .git/config\0?? ../escape\0').files.length, 0);
  const many = Array.from({ length: 501 }, (_, i) => `?? file${i}\0`).join('');
  assert.equal(parseProjectStatus(many).files.length, 500); assert.equal(parseProjectStatus(many).truncated, true);
});
test('project diff rejects traversal and inherited Git overrides without treating special pathspec names as commands', () => {
  for (const path of ['../file', '/tmp/file', 'C:/secret', '.git/config', 'a/../../b', 'a\\b', 'file\0x', 'a//b']) assert.equal(validProjectChangePath(path), false, path);
  assert.equal(validProjectChangePath(':(glob)*.txt'), true); assert.equal(validProjectChangePath('--option.txt'), true);
  const safePath = resolve('safe-path');
  const env = projectGitEnvironment({ PATH: [safePath, '.', '', 'relative/path'].join(delimiter), GIT_DIR: 'elsewhere', GIT_CONFIG_COUNT: '99', git_work_tree: 'elsewhere', HOME: 'fixture-home',
    NODE_OPTIONS: '--require=unsafe.cjs', LD_PRELOAD: 'unsafe.so', DYLD_INSERT_LIBRARIES: 'unsafe.dylib', BASH_ENV: 'unsafe.sh', AWS_SECRET_ACCESS_KEY: 'private' });
  assert.equal(env.GIT_DIR, undefined); assert.equal(env.GIT_CONFIG_COUNT, undefined); assert.equal(env.git_work_tree, undefined);
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0'); assert.equal(env.GIT_NO_LAZY_FETCH, '1'); assert.equal(env.PATH, safePath);
  for (const key of ['NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'BASH_ENV', 'AWS_SECRET_ACCESS_KEY']) assert.equal(env[key], undefined);
  for (const path of ['.npmrc', 'nested/.netrc', '.git-credentials', '.docker/config.json', '.aws/config', '.ssh/id_dsa', 'saved.kdbx'])
    assert(sensitiveProjectChangePath(path), path);
  assert.equal(sensitiveProjectChangePath('src/config.json'), false);
});
test('Git project review separates index and working changes while leaving index and files unchanged', async () => fixture(async (root, git) => {
  await seed(root, git); await writeFile(join(root, 'example.txt'), 'staged\n'); git('add', 'example.txt');
  await writeFile(join(root, 'example.txt'), 'working\n'); await writeFile(join(root, '新文件.txt'), 'new text\n');
  const indexBefore = await readFile(join(root, '.git/index'));
  const state = await readProjectChanges(root); assert.equal(state.state, 'ready');
  const entry = state.files.find(file => file.path === 'example.txt'); assert.equal(entry?.index, 'M'); assert.equal(entry?.worktree, 'M');
  const staged = await readProjectDiff(root, 'example.txt', 'staged'), working = await readProjectDiff(root, 'example.txt', 'working');
  assert.equal(staged.state, 'ready'); assert.match(staged.text, /\+staged/); assert.doesNotMatch(staged.text, /\+working/);
  assert.match(working.text, /-staged/); assert.match(working.text, /\+working/);
  assert.equal((await readProjectDiff(root, '新文件.txt', 'working')).text, 'new text\n');
  assert.deepEqual(await readFile(join(root, '.git/index')), indexBefore);
  assert.equal(await readFile(join(root, 'example.txt'), 'utf8'), 'working\n');
}));
test('Git project review scopes nested projects and bounds sensitive, binary, large and literal filenames', async () => fixture(async (root, git) => {
  await seed(root, git); const scoped = join(root, 'scope'); await mkdir(scoped);
  for (const [name, body] of [['example.txt', 'scoped'], ['.env.local', 'secret'], ['-literal.txt', 'literal']]) await writeFile(join(scoped, name), body);
  await writeFile(join(root, 'outside.txt'), 'not the project');
  await writeFile(join(scoped, 'binary.bin'), Buffer.from([0, 1, 2]));
  await writeFile(join(scoped, 'large.txt'), 'x'.repeat(projectDiffByteLimit + 1));
  const state = await readProjectChanges(scoped); assert.equal(state.state, 'ready');
  assert(!state.files.some(file => file.path.includes('outside'))); assert(state.files.some(file => file.path === 'example.txt'));
  assert.equal((await readProjectDiff(scoped, '.env.local', 'working')).state, 'sensitive');
  assert.equal((await readProjectDiff(scoped, 'binary.bin', 'working')).state, 'binary');
  assert.equal((await readProjectDiff(scoped, 'large.txt', 'working')).state, 'too-large');
  assert.equal((await readProjectDiff(scoped, '-literal.txt', 'working')).text, 'literal');
  assert.equal((await readProjectDiff(scoped, 'missing.txt', 'working')).state, 'changed');
  await assert.rejects(readProjectDiff(scoped, '../outside.txt', 'working'), /project_changes_path/);
}));
test('Git review disables clean, process, textconv and external diff helpers configured by a repository', async () => fixture(async (root, git) => {
  await seed(root, git);
  const marker = join(root, 'executed.marker'), helper = join(root, 'helper.cjs');
  await writeFile(helper, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');process.stdin.pipe(process.stdout);`);
  const command = `"${process.execPath}" "${helper}"`;
  git('config', 'filter.unsafe.clean', command); git('config', 'filter.unsafe.process', command); git('config', 'filter.unsafe.required', 'true');
  git('config', 'diff.unsafe.textconv', command); git('config', 'diff.external', command); git('config', 'core.fsmonitor', command);
  await writeFile(join(root, '.gitattributes'), '*.txt filter=unsafe diff=unsafe\n');
  await writeFile(join(root, 'example.txt'), 'after\n');
  assert.equal((await readProjectChanges(root)).state, 'ready');
  const result = await readProjectDiff(root, 'example.txt', 'working'); assert.equal(result.state, 'ready'); assert.match(result.text, /\+after/);
  assert.equal(existsSync(marker), false, 'Read-only review executed a repository helper');
}));

test('Git review also disables helpers from included repository configuration', async () => fixture(async (root, git) => {
  await seed(root, git);
  const marker = join(root, 'included-executed.marker'), helper = join(root, 'included-helper.cjs');
  await writeFile(helper, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');process.stdin.pipe(process.stdout);`);
  const command = `"${process.execPath}" "${helper}"`;
  git('config', '--file', '.git/included-config', 'filter.included.clean', command);
  git('config', '--file', '.git/included-config', 'filter.included.process', command);
  git('config', '--file', '.git/included-config', 'filter.included.required', 'true');
  git('config', 'include.path', 'included-config');
  await writeFile(join(root, '.gitattributes'), '*.txt filter=included\n');
  await writeFile(join(root, 'example.txt'), 'included after\n');
  assert.equal((await readProjectChanges(root)).state, 'ready');
  assert.match((await readProjectDiff(root, 'example.txt', 'working')).text, /\+included after/);
  assert.equal(existsSync(marker), false);
}));

test('project review resolves Git outside the project cwd and classifies a plain directory accurately', async () => fixture(async (root, git) => {
  await seed(root, git);
  const executable = join(root, process.platform === 'win32' ? 'git.exe' : 'git');
  await writeFile(executable, process.platform === 'win32' ? 'not a trusted executable' : '#!/bin/sh\nexit 91\n');
  if (process.platform !== 'win32') await chmod(executable, 0o755);
  const previous = process.env.PATH;
  try {
    process.env.PATH = ['.', previous || ''].join(delimiter);
    assert.equal((await readProjectChanges(root)).state, 'ready', 'project-local Git must not execute');
  } finally { process.env.PATH = previous; }
  const temporaryRoot = resolve(tmpdir()), directory = await mkdtemp(join(temporaryRoot, 'rivloom-nonrepo-'));
  try { assert.equal((await readProjectChanges(directory)).state, 'not-repository'); }
  finally { assert(directory.startsWith(temporaryRoot + sep)); await rm(directory, { recursive: true, force: true }); }
}));

test('deleted tracked files retain scoped staged and working patches without reading siblings', async () => fixture(async (root, git) => {
  await seed(root, git);
  const scope = join(root, 'scope'); await mkdir(scope);
  await writeFile(join(scope, 'working.txt'), 'scoped working original\n');
  await writeFile(join(scope, 'staged.txt'), 'scoped staged original\n');
  await writeFile(join(root, 'sibling.txt'), 'outside-scope-private\n');
  git('add', 'scope', 'sibling.txt'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'scoped fixture');
  await rm(join(scope, 'working.txt')); await rm(join(scope, 'staged.txt')); git('add', '-u', 'scope/staged.txt');
  await writeFile(join(root, 'sibling.txt'), 'outside-scope-changed\n');
  const indexBefore = await readFile(join(root, '.git/index'));
  const state = await readProjectChanges(scope);
  assert.deepEqual(state.files.map(file => file.path).sort(), ['staged.txt', 'working.txt']);
  const staged = await readProjectDiff(scope, 'staged.txt', 'staged');
  const working = await readProjectDiff(scope, 'working.txt', 'working');
  assert.equal(staged.state, 'ready'); assert.match(staged.text, /-scoped staged original/);
  assert.equal(working.state, 'ready'); assert.match(working.text, /-scoped working original/);
  assert(!staged.text.includes('outside-scope')); assert(!working.text.includes('outside-scope'));
  assert.deepEqual(await readFile(join(root, '.git/index')), indexBefore);
}));

test('repository core.worktree cannot redirect review outside the registered physical project', async () => fixture(async (root, git) => {
  await seed(root, git);
  const scope = join(root, 'scope'), outside = join(root, 'elsewhere'); await mkdir(scope); await mkdir(outside);
  await writeFile(join(scope, 'scoped.txt'), 'authorized scoped original\n');
  git('add', 'scope'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'scoped fixture');
  await writeFile(join(outside, 'example.txt'), 'outside-worktree-private\n');
  await mkdir(join(outside, 'scope')); await writeFile(join(outside, 'scope', 'scoped.txt'), 'outside-scoped-private\n');
  git('config', 'core.worktree', outside);
  assert.equal((await readProjectDiff(root, 'example.txt', 'working')).state, 'changed');
  assert.equal((await readProjectDiff(scope, 'scoped.txt', 'working')).state, 'changed');
  await writeFile(join(scope, 'scoped.txt'), 'authorized scoped modified\n');
  const result = await readProjectDiff(scope, 'scoped.txt', 'working');
  assert.equal(result.state, 'ready'); assert.match(result.text, /\+authorized scoped modified/);
  assert(!result.text.includes('outside-scoped-private'));
}));

test('linked Git worktrees retain their own physical scope and index while reviewing changes', async () => fixture(async (root, git) => {
  await seed(root, git);
  const linked = join(root, 'linked'); git('worktree', 'add', '--quiet', '--detach', linked);
  const originalIndex = await readFile(join(root, '.git', 'index'));
  await writeFile(join(linked, 'example.txt'), 'linked worktree change\n');
  const state = await readProjectChanges(linked);
  assert.equal(state.state, 'ready'); assert.equal(state.files.find(file => file.path === 'example.txt')?.worktree, 'M');
  const diff = await readProjectDiff(linked, 'example.txt', 'working');
  assert.equal(diff.state, 'ready'); assert.match(diff.text, /\+linked worktree change/);
  assert.equal(await readFile(join(root, 'example.txt'), 'utf8'), 'before\n');
  assert.deepEqual(await readFile(join(root, '.git', 'index')), originalIndex);
}));

test('staged additions and deletions of symbolic links never expose recorded link targets', async () => fixture(async (root, git) => {
  await seed(root, git);
  await writeFile(join(root, 'link-target.txt'), '/outside/recorded-private-target\n');
  const blob = git('hash-object', '-w', 'link-target.txt');
  git('update-index', '--add', '--cacheinfo', `120000,${blob},recorded-link`);
  assert.equal((await readProjectDiff(root, 'recorded-link', 'staged')).state, 'restricted');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'index link fixture');
  git('update-index', '--force-remove', 'recorded-link');
  const removed = await readProjectDiff(root, 'recorded-link', 'staged');
  assert.equal(removed.state, 'restricted'); assert.equal(removed.text, '');
}));

test('tracked non-UTF8 bytes and oversized patches never become replacement text or truncated valid patches', async () => fixture(async (root, git) => {
  await seed(root, git);
  const invalid = Buffer.from([0x61, 0x80, 0xff, 0x0a]);
  await writeFile(join(root, 'example.txt'), invalid);
  const working = await readProjectDiff(root, 'example.txt', 'working');
  assert.equal(working.state, 'binary'); assert.equal(working.text, '');
  git('add', 'example.txt');
  const staged = await readProjectDiff(root, 'example.txt', 'staged');
  assert.equal(staged.state, 'binary'); assert.equal(staged.text, '');
  await writeFile(join(root, 'example.txt'), 'x'.repeat(projectDiffByteLimit));
  git('add', 'example.txt');
  assert.equal((await readProjectDiff(root, 'example.txt', 'staged')).state, 'too-large', 'patch headers and hunk framing count toward the byte limit');
}));

// Windows paths are Unicode. Like the native Linux runtime checks, register this
// raw POSIX filename case only where it can run; Windows CI rejects skipped cases.
if (process.platform !== 'win32') test('Git status rejects non-UTF8 filenames instead of mapping replacement characters to another file', async () => fixture(async root => {
  const name = Buffer.concat([Buffer.from(root + '/invalid-'), Buffer.from([0xff]), Buffer.from('.txt')]);
  await writeFile(name, 'invalid name');
  await writeFile(join(root, 'invalid-�.txt'), 'different valid name');
  const state = await readProjectChanges(root);
  assert.equal(state.state, 'unavailable'); assert.deepEqual(state.files, []);
  const literal = await readProjectDiff(root, 'invalid-�.txt', 'working');
  assert.equal(literal.state, 'ready'); assert.equal(literal.text, 'different valid name');
}));
test('project diff never returns link targets or embedded credential values', async () => fixture(async (root, git) => {
  await seed(root, git); const outside = join(root, 'outside'), scope = join(root, 'scope');
  await mkdir(outside); await mkdir(scope); await writeFile(join(outside, 'private.txt'), 'outside-private');
  await symlink(outside, join(scope, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await readProjectDiff(scope, 'link/private.txt', 'working');
  assert(['changed', 'restricted'].includes(result.state)); assert(!result.text.includes('outside-private'));
  await writeFile(join(scope, 'config.txt'), 'password=hidden-token\nBearer abcdefghijklmnop\n');
  const content = await readProjectDiff(scope, 'config.txt', 'working');
  assert(!content.text.includes('hidden-token')); assert(!content.text.includes('abcdefghijklmnop')); assert.match(content.text, /REDACTED/);
  await link(join(outside, 'private.txt'), join(scope, 'hardlink.txt'));
  assert.equal((await readProjectDiff(scope, 'hardlink.txt', 'working')).state, 'restricted');
  assert.equal((await readProjectChanges(join(scope, 'link'))).state, 'unavailable', 'a replaced project root cannot authorize a different real directory');
  await writeFile(join(scope, '.npmrc'), '//registry.npmjs.org/:_authToken=otherwise-unrecognized-token\n');
  assert.equal((await readProjectDiff(scope, '.npmrc', 'working')).state, 'sensitive');
}));

test('project review bounds parallel readers without poisoning later requests', async () => fixture(async (root, git) => {
  await seed(root, git);
  const values = await Promise.allSettled(Array.from({ length: 8 }, () => readProjectChanges(root)));
  assert.equal(values.filter(value => value.status === 'fulfilled').length, 3);
  const rejected = values.filter(value => value.status === 'rejected');
  assert.equal(rejected.length, 5);
  for (const value of rejected) if (value.status === 'rejected') assert.equal(value.reason.status, 429);
  assert.equal((await readProjectChanges(root)).state, 'ready');
}));
test('project changes API refuses non-owner and unknown project access before reading directories', async () => {
  const app = express(); app.use(express.json());
  installProjectChangesAPI(app, req => ({ id: 'user', username: 'user', name: 'User', owner: req.headers['x-test-owner'] === '1' }),
    () => [{ id: 'known', name: 'fixture', directory: join(base, 'does-not-exist'), createdAt: '' }]);
  const server = createServer(app); await listenHttp(server, '127.0.0.1');
  const address = server.address(); assert(address && typeof address !== 'string'); const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(origin + '/api/projects/known/changes')).status, 403);
    assert.equal((await fetch(origin + '/api/projects/unknown/changes', { headers: { 'x-test-owner': '1' } })).status, 404);
    assert.equal((await fetch(origin + '/api/projects/known/changes/diff', { method: 'POST', headers: { 'x-test-owner': '1', 'content-type': 'application/json' }, body: JSON.stringify({ path: 'file', area: 'working', directory: 'elsewhere' }) })).status, 400);
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});
