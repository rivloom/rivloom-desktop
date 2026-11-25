import assert from 'node:assert/strict';
import test from 'node:test';
import type { LocalKnowledgeEntry } from '../shared/knowledge.ts';
import type { ProjectFileEntry } from '../shared/office-files.ts';
import {
  activeFileMention,
  activeKnowledgeTrigger,
  addComposerReference,
  composeMessageWithContext,
  composerReferenceLimit,
  fileReferenceFromEntry,
  filterKnowledgeEntries,
  filterProjectFileEntries,
  fuzzyMatchScore,
  knowledgeReferenceFromEntry,
  planProjectFileQuery,
  removeComposerReference,
  removeTriggerToken,
  replaceTriggerQuery,
  resolveAtScope,
  splitContextMessage,
  validComposerReference,
} from '../src/composer-context.ts';
import {
  createWorkflowDraft,
  conversationInputUsage,
  prepareConversationRequest,
  updateConversationDraft,
} from '../src/conversation-drafts.ts';
import { decodeDrafts, encodeDrafts } from '../src/draft-storage.ts';

const knowledgeEntry = (overrides: Partial<LocalKnowledgeEntry> = {}): LocalKnowledgeEntry => ({
  id: '11111111-1111-4111-8111-111111111111',
  nodeID: 'A'.repeat(32),
  kind: 'memory',
  name: '发布检查清单',
  description: '记录 Windows 签名、安装包校验和 R2 保留策略要点',
  category: 'release/windows',
  revision: 'a'.repeat(64),
  updatedAt: '2026-11-20T08:00:00.000Z',
  projectID: null,
  sharedBrains: [],
  source: 'local',
  error: null,
  ...overrides,
});

test('@file trigger activates at boundaries and rejects emails, URLs, code spans, @@ and traversal', () => {
  assert.deepEqual(activeFileMention('@', 1), { start: 0, end: 1, query: '', locked: false });
  assert.deepEqual(activeFileMention('请看 @src/live', 12), { start: 3, end: 12, query: 'src/live', locked: false });
  assert.deepEqual(activeFileMention('第一行\n@README.md', 14), { start: 4, end: 14, query: 'README.md', locked: false });
  // Must ignore locked @@, emails, URLs, paths without @, code spans, and .. traversal
  assert.equal(activeFileMention('@@DesignBox', 11), null);
  assert.equal(activeFileMention('user@example.com', 16), null);
  assert.equal(activeFileMention('@https://rivloom.com/docs', 25), null);
  assert.equal(activeFileMention('src/live-inspector.tsx', 22), null);
  assert.equal(activeFileMention('`@src/app.ts', 12), null);
  assert.equal(activeFileMention('```\n@src/app.ts', 15), null);
  assert.equal(activeFileMention('@../secret.txt', 14), null);
  assert.equal(activeFileMention('@src/../.env', 12), null);
});

test('# knowledge trigger activates cleanly and ignores markdown headings, URLs, file anchors and code', () => {
  assert.deepEqual(activeKnowledgeTrigger('#', 1), { start: 0, end: 1, query: '' });
  assert.deepEqual(activeKnowledgeTrigger('参考 #发布', 6), { start: 3, end: 6, query: '发布' });
  assert.deepEqual(activeKnowledgeTrigger('第一行\n#skill-check', 16), { start: 4, end: 16, query: 'skill-check' });
  // Reject markdown headings (## or # followed by space), URL fragments, file anchors, code spans
  assert.equal(activeKnowledgeTrigger('## Heading', 2), null);
  assert.equal(activeKnowledgeTrigger('###Heading', 10), null);
  assert.equal(activeKnowledgeTrigger('# Heading', 9), null);
  assert.equal(activeKnowledgeTrigger('https://rivloom.com/#download', 29), null);
  assert.equal(activeKnowledgeTrigger('docs/README.md#install', 22), null);
  assert.equal(activeKnowledgeTrigger('`#memory', 8), null);
  assert.equal(activeKnowledgeTrigger('```\n#memory', 11), null);
});

test('planProjectFileQuery enforces safe workspace boundary paths without traversal', () => {
  assert.deepEqual(planProjectFileQuery(''), { path: '', search: '' });
  assert.deepEqual(planProjectFileQuery('live'), { path: '', search: 'live' });
  assert.deepEqual(planProjectFileQuery('src/'), { path: 'src', search: '' });
  assert.deepEqual(planProjectFileQuery('src/live'), { path: 'src', search: 'live' });
  assert.deepEqual(planProjectFileQuery('../outside/foo'), { path: '', search: 'foo' });
  assert.deepEqual(planProjectFileQuery('.git/config'), { path: '', search: 'config' });
});

test('filterProjectFileEntries fuzzy-ranks safe files and drops hidden or sensitive entries', () => {
  const entries: ProjectFileEntry[] = [
    { name: '.env', path: '.env', directory: false, bytes: 10 },
    { name: 'id_rsa', path: '.ssh/id_rsa', directory: false, bytes: 20 },
    { name: 'live-inspector.tsx', path: 'src/live-inspector.tsx', directory: false, bytes: 1000 },
    { name: 'live-utils', path: 'src/live-utils', directory: true, bytes: 0 },
    { name: 'mission-cockpit.tsx', path: 'src/mission-cockpit.tsx', directory: false, bytes: 800 },
  ];
  const all = filterProjectFileEntries(entries, '');
  assert.equal(all.some((e) => e.path === '.env' || e.path.includes('id_rsa')), false);
  const searched = filterProjectFileEntries(entries, 'lvinsp');
  assert.deepEqual(searched.map((e) => e.path), ['src/live-inspector.tsx']);
  const prefix = filterProjectFileEntries(entries, 'live');
  assert.equal(prefix[0].path, 'src/live-inspector.tsx');
  assert.ok(fuzzyMatchScore('mc', 'mission-cockpit.tsx') !== null);
  assert.equal(fuzzyMatchScore('zzz', 'mission-cockpit.tsx'), null);
});

test('filterKnowledgeEntries respects project scope, kind, withdrawn/error state and fuzzy ranks', () => {
  const globalMem = knowledgeEntry({ id: '11111111-1111-4111-8111-111111111111', name: 'R2 保留规则', projectID: null });
  const projectSkill = knowledgeEntry({
    id: '22222222-2222-4222-8222-222222222222',
    kind: 'skill',
    name: 'workbench-review',
    category: 'skills/ui',
    description: '桌面工作台检查流程',
    projectID: 'proj-a',
  });
  const otherProject = knowledgeEntry({
    id: '33333333-3333-4333-8333-333333333333',
    name: '其他项目备忘',
    projectID: 'proj-b',
  });
  const withdrawn = knowledgeEntry({
    id: '44444444-4444-4444-8444-444444444444',
    name: '已撤回记忆',
    withdrawnAt: '2026-11-21T00:00:00.000Z',
  });
  const catalog = [globalMem, projectSkill, otherProject, withdrawn];

  const scoped = filterKnowledgeEntries(catalog, '', { projectID: 'proj-a' });
  assert.deepEqual(scoped.map((e) => e.id), [projectSkill.id, globalMem.id]);

  const onlySkills = filterKnowledgeEntries(catalog, '工作台', { projectID: 'proj-a', kind: 'skill' });
  assert.deepEqual(onlySkills.map((e) => e.id), [projectSkill.id]);
});

test('resolveAtScope switches cleanly between devices and workspace files', () => {
  assert.equal(
    resolveAtScope(null, { locked: true, canDevices: true, canFiles: true, query: 'src/a', peerCount: 1, matchingDeviceCount: 0 }),
    'devices',
  );
  assert.equal(
    resolveAtScope(null, { locked: false, canDevices: true, canFiles: true, query: '', peerCount: 2, matchingDeviceCount: 2 }),
    'devices',
  );
  assert.equal(
    resolveAtScope(null, { locked: false, canDevices: true, canFiles: true, query: 'src/app.ts', peerCount: 2, matchingDeviceCount: 0 }),
    'files',
  );
  assert.equal(
    resolveAtScope(null, { locked: false, canDevices: true, canFiles: true, query: '', peerCount: 0, matchingDeviceCount: 0 }),
    'files',
  );
  assert.equal(
    resolveAtScope('files', { locked: false, canDevices: true, canFiles: true, query: 'node', peerCount: 2, matchingDeviceCount: 1 }),
    'files',
  );
  assert.equal(
    resolveAtScope(null, { locked: false, canDevices: false, canFiles: true, query: 'app', peerCount: 2, matchingDeviceCount: 0 }),
    'files',
  );
});

test('progressive context references deduplicate, enforce cap, persist safely and never inject bodies', () => {
  const fileRef = fileReferenceFromEntry('proj-1', 'rivloom', 'src/live-inspector.tsx');
  const memRef = knowledgeReferenceFromEntry(knowledgeEntry());
  let list = addComposerReference([], fileRef).references;
  assert.equal(addComposerReference(list, fileRef).reason, 'duplicate');
  list = addComposerReference(list, memRef).references;
  assert.equal(list.length, 2);

  for (let i = 0; i < composerReferenceLimit; i++) {
    list = addComposerReference(list, fileReferenceFromEntry('proj-1', 'rivloom', `src/f${i}.ts`)).references;
  }
  assert.equal(list.length, composerReferenceLimit);
  assert.equal(addComposerReference(list, fileReferenceFromEntry('proj-1', 'rivloom', 'src/extra.ts')).reason, 'limit');

  const trimmed = removeComposerReference([fileRef, memRef], fileRef.id);
  assert.deepEqual(trimmed.map((r) => r.id), [memRef.id]);

  // Progressive serialization emits metadata & paths only (no full body)
  const outgoing = composeMessageWithContext('请按这个约束检查组件', null, [fileRef, memRef]);
  assert.match(outgoing, /@file src\/live-inspector\.tsx/);
  assert.match(outgoing, /#memory 发布检查清单/);
  assert.match(outgoing, /rev: aaaaaaaaaaaa/);
  const parsed = splitContextMessage(outgoing);
  assert.equal(parsed.text, '请按这个约束检查组件');
  assert.equal(parsed.badges.length, 2);
  assert.equal(parsed.badges[0].kind, 'file');
  assert.equal(parsed.badges[1].kind, 'memory');

  // Draft storage persists valid references and strips invalid/sensitive ones
  const draft = updateConversationDraft(createWorkflowDraft(), { text: '检查', references: [fileRef, memRef] });
  assert.ok(conversationInputUsage(draft, false).length > 2);
  const prepared = prepareConversationRequest(draft, {});
  assert.notEqual(updateConversationDraft(prepared, { references: [fileRef] }).requestID, prepared.requestID);
  const decoded = decodeDrafts(encodeDrafts({ drafts: { new: draft } })).drafts.new;
  assert.equal(decoded.references?.length, 2);
  assert.equal(validComposerReference({ ...fileRef, path: '.env' }), false);
  assert.equal(validComposerReference({ ...fileRef, path: '../escape.ts' }), false);

  const removed = removeTriggerToken('先看 @src/app 吧', { start: 3, end: 11 });
  assert.equal(removed.text, '先看 吧');
  const drilled = replaceTriggerQuery('看 @src', { start: 2, end: 6 }, '@', 'src/assets/');
  assert.equal(drilled.text, '看 @src/assets/');
});
