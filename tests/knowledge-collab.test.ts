import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { KnowledgeStore } from '../server/knowledge-store.ts';
import { KnowledgeNetwork } from '../server/knowledge-network.ts';
import { KnowledgeTools, type KnowledgeTask } from '../server/knowledge-tools.ts';
import { formatSkillDraftMarkdown, type KnowledgeUsage, type LocalKnowledgeEntry } from '../shared/knowledge.ts';
import {
  buildKnowledgeCaptureDraft,
  previewSkillDraftFile,
  sanitizeCategorySegment,
  suggestCaptureCategory,
} from '../src/knowledge-capture.ts';
import {
  buildKnowledgeCategoryTree,
  filterKnowledgeEntries,
  flattenKnowledgeTree,
  summarizeLocalKnowledge,
  type KnowledgeOutlineEntry,
} from '../src/knowledge-outline.ts';
import { summarizeKnowledgeUsage } from '../src/knowledge-usage-summary.ts';

const nodeID = 'k'.repeat(32);

test('createSkillDraft writes SKILL.md privately, handles special YAML chars safely, and preserves custom category across refresh', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rivloom-skill-draft-'));
  const store = new KnowledgeStore(root, nodeID);
  try {
    const brainID = randomUUID();
    const projectID = randomUUID();
    const draft = await store.createSkillDraft({
      name: `Release: "Check" & it's safe`,
      description: `Review: [v2] steps & guardrails — don't execute scripts`,
      category: 'Skills/Release',
      body: '# Release Checklist\n\n- Verify hashes.\n- Never execute untrusted scripts.',
      projectID,
    });
    assert.equal(draft.kind, 'skill');
    assert.equal(draft.category, 'Skills/Release');
    assert.equal(draft.projectID, projectID);
    assert.equal(draft.origin, 'skill-draft');
    assert.deepEqual(draft.sharedBrains, []);
    assert.equal(draft.name, `Release: "Check" & it's safe`);
    assert.equal(draft.description, `Review: [v2] steps & guardrails — don't execute scripts`);
    assert.deepEqual(store.listShared(brainID).entries, []);

    const manifest = store.manifest(draft.id);
    assert.deepEqual(manifest.files.map((file) => file.path), ['SKILL.md']);
    const fileText = readFileSync(join(draft.source, 'SKILL.md'), 'utf8');
    assert(fileText.startsWith('---\nname: '));
    assert(fileText.includes('# Release Checklist'));

    await store.refresh(draft.id);
    const refreshed = store.localEntry(draft.id);
    assert.equal(refreshed.category, 'Skills/Release');
    assert.equal(refreshed.name, draft.name);
    assert.equal(refreshed.description, draft.description);
    assert.deepEqual(refreshed.sharedBrains, []);

    // Manual share exposes only after explicit grant; new drafts stay private.
    store.share(draft.id, [brainID], refreshed.revision, refreshed.updatedAt);
    assert.equal(store.listShared(brainID).entries.length, 1);

    const secondDraft = await store.createSkillDraft({
      name: 'Second private draft',
      description: 'Remains private even after prior share',
      category: 'Skills/Release',
      body: 'Only private by default.',
      projectID: null,
    });
    assert.deepEqual(secondDraft.sharedBrains, []);
    assert.equal(store.listShared(brainID).entries.length, 1);

    // Reject newline / NUL injection in frontmatter fields.
    await assert.rejects(
      store.createSkillDraft({
        name: 'Bad\nname: injected',
        description: 'desc',
        category: 'Skills',
        body: 'body',
        projectID: null,
      }),
    );
    await assert.rejects(
      store.createSkillDraft({
        name: 'Bad category',
        description: 'desc',
        category: '../escape',
        body: 'body',
        projectID: null,
      }),
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('knowledge capture helpers prefill editable Wiki and Skill drafts with provenance and safe categories', () => {
  const wiki = buildKnowledgeCaptureDraft('memory', {
    conversationTitle: '网站部署规范',
    conversationID: 'wf-123',
    projectID: randomUUID(),
    projectName: 'con:website/v2',
    originLabel: '整理发布清单',
    excerpt: '## 结论\n\n每次发布前必须校验 SHA256 与 R2 保留清单。',
    capturedAt: '2026-11-24T12:00:00.000Z',
    noteKind: 'decision',
    sourceRevision: 'a'.repeat(64),
    sourceQuote: '必须校验 SHA256',
  });
  assert.equal(wiki.kind, 'memory');
  assert(wiki.name.includes('网站部署规范'));
  assert(wiki.body.includes('wf-123'));
  assert(wiki.body.includes('aaaaaaaaaaaa'));
  assert(wiki.body.includes('必须校验 SHA256'));
  assert(!wiki.category.includes(':'));
  assert.equal(sanitizeCategorySegment('con'), 'General');
  assert.equal(sanitizeCategorySegment('..'), 'General');

  const skill = buildKnowledgeCaptureDraft('skill', {
    conversationTitle: '前端打包核验',
    conversationID: 'wf-456',
    projectID: null,
    projectName: 'Desktop App',
    excerpt: '先运行 check-i18n，再跑 tsc --noEmit 和 vite build。',
    capturedAt: '2026-11-24T12:30:00.000Z',
  });
  assert.equal(skill.kind, 'skill');
  assert.equal(skill.category, 'Skills/Desktop App');
  assert(skill.body.includes('wf-456'));
  const markdown = previewSkillDraftFile(skill);
  assert(markdown.startsWith('---\nname: '));
  assert(markdown.includes('description: '));
  assert.equal(suggestCaptureCategory('skill', null), 'Skills');
  assert(formatSkillDraftMarkdown({ name: '---', description: '>', body: 'Body' }).includes("'---'"));
});

test('knowledge outline builds hierarchical tree, tracks shared counts, and filters accurately', () => {
  const brainA = randomUUID();
  const brainB = randomUUID();
  const base = {
    nodeID,
    revision: 'b'.repeat(64),
    updatedAt: '2026-11-24T12:00:00.000Z',
    source: 'wiki',
    error: null,
  };
  const locals: LocalKnowledgeEntry[] = [
    {
      ...base,
      id: randomUUID(),
      kind: 'memory',
      name: '张三工作偏好',
      description: '先看结论',
      category: '人物/张三/工作',
      projectID: null,
      sharedBrains: [],
    },
    {
      ...base,
      id: randomUUID(),
      kind: 'memory',
      name: '网站交付规范',
      description: '核对清单',
      category: '项目/网站/规范',
      projectID: null,
      sharedBrains: [brainA],
    },
    {
      ...base,
      id: randomUUID(),
      kind: 'skill',
      name: '周报模板',
      description: '整理本周进度与风险',
      category: 'Skills/团队',
      projectID: null,
      sharedBrains: [brainA, brainB],
      origin: 'skill-draft',
    },
  ];

  const summary = summarizeLocalKnowledge(locals);
  assert.deepEqual(summary, {
    total: 3,
    privateCount: 1,
    sharedCount: 2,
    skillCount: 1,
    memoryCount: 2,
    withdrawnCount: 0,
    errorCount: 0,
  });

  const rows: KnowledgeOutlineEntry[] = locals.map((entry) => ({
    ...entry,
    brainID: null,
    nodeName: '本机',
  }));

  const tree = buildKnowledgeCategoryTree(rows);
  assert.equal(tree.length, 3);
  const projectBranch = tree.find((node) => node.path === '项目')!;
  assert.equal(projectBranch.count, 1);
  assert.equal(projectBranch.sharedCount, 1);
  assert.equal(projectBranch.children[0].path, '项目/网站');
  assert.equal(projectBranch.children[0].children[0].path, '项目/网站/规范');

  const collapsed = new Set(['项目']);
  const flat = flattenKnowledgeTree(tree, collapsed);
  assert(!flat.some((row) => row.path === '项目/网站'));
  assert(flat.some((row) => row.path === '人物/张三/工作'));

  assert.equal(
    filterKnowledgeEntries(rows, { filter: 'private', category: '', query: '', localScope: true }).length,
    1,
  );
  assert.equal(
    filterKnowledgeEntries(rows, { filter: 'shared', brainFilter: brainB, category: '', query: '', localScope: true }).length,
    1,
  );
  assert.equal(
    filterKnowledgeEntries(rows, { filter: 'skill', category: 'Skills', query: '周报', localScope: true }).length,
    1,
  );
  assert.equal(
    filterKnowledgeEntries(rows, { filter: 'memory', category: '项目', query: '', localScope: true }).length,
    1,
  );
});

test('knowledge usage records include catalog metadata without body text and summarize cleanly by source and revision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rivloom-usage-summary-'));
  const store = new KnowledgeStore(root, nodeID);
  const directory = join(root, 'project');
  const projectID = randomUUID();
  const task: KnowledgeTask = {
    id: randomUUID(),
    sessionID: 'ses_usage_meta',
    directory,
    projectID,
    privateLocal: true,
    brainIDs: [],
    canWriteMemory: true,
  };
  const network = new KnowledgeNetwork(store, {
    snapshot: () => ({ local: null, paired: [], brains: [] }),
    trusted: () => false,
    request: async () => {
      throw new Error('unexpected');
    },
  });
  const tools = new KnowledgeTools(store, network, () => task);
  try {
    const wiki = store.saveMemory(
      {
        name: '交付规范',
        description: '发布前检查摘要',
        category: '项目/规范',
        body: 'SECRET_BODY_TEXT_MUST_NOT_LEAK_INTO_USAGE',
        projectID,
      },
      'user',
    );
    const skill = await store.createSkillDraft({
      name: '周报整理',
      description: '整理周报与风险清单',
      category: 'Skills/团队',
      body: 'SKILL_PRIVATE_BODY_TEXT',
      projectID,
    });

    await tools.call(task.sessionID, task.directory, 'rivloom_knowledge_read', {
      brainID: null,
      nodeID,
      id: wiki.id,
      revision: wiki.revision,
    });
    await tools.call(task.sessionID, task.directory, 'rivloom_knowledge_read', {
      brainID: null,
      nodeID,
      id: skill.id,
      revision: skill.revision,
    });

    const page = tools.usage(task.id);
    assert.equal(page.total, 2);
    assert(!JSON.stringify(page).includes('SECRET_BODY_TEXT'));
    assert(!JSON.stringify(page).includes('SKILL_PRIVATE_BODY_TEXT'));
    assert(!JSON.stringify(page).includes(directory));

    const remoteEntry: KnowledgeUsage = {
      id: randomUUID(),
      taskID: task.id,
      sessionID: task.sessionID,
      at: new Date(Date.now() + 60_000).toISOString(),
      reference: { brainID: randomUUID(), nodeID: 'r'.repeat(32), id: randomUUID() },
      revision: 'c'.repeat(64),
      name: '远端交付检查',
      kind: 'skill',
      description: '来自远端节点的共享技能',
      category: 'Skills',
      file: 'references/checklist.md',
      operation: 'materialize',
      offset: 0,
      nextOffset: null,
      totalCharacters: 120,
      contentBytes: 120,
    };

    const digest = summarizeKnowledgeUsage([...page.entries, remoteEntry]);
    assert.equal(digest.wikiCount, 1);
    assert.equal(digest.skillCount, 2);
    assert.equal(digest.totalReads, 3);
    assert.equal(digest.items[0].name, '远端交付检查');
    assert.equal(digest.items[0].sourceNodeID, 'r'.repeat(32));
    assert.equal(digest.items[0].files[0].materializeCount, 1);
    const wikiItem = digest.items.find((item) => item.id === wiki.id)!;
    assert.equal(wikiItem.description, '发布前检查摘要');
    assert.equal(wikiItem.files[0].complete, true);
  } finally {
    tools.close();
    network.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
