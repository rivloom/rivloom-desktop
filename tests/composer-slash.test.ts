import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activeSlashCommand,
  applySlashInsertion,
  filterSlashItems,
  templateToSlashItem,
  type SlashCommandItem,
} from '../src/composer-slash.ts';

test('activeSlashCommand triggers at line or word boundary and ignores paths and URLs', () => {
  assert.deepEqual(activeSlashCommand('/', 1), { start: 0, end: 1, query: '' });
  assert.deepEqual(activeSlashCommand('/plan', 5), { start: 0, end: 5, query: 'plan' });
  assert.deepEqual(activeSlashCommand('先看下 /diff', 9), { start: 4, end: 9, query: 'diff' });
  assert.deepEqual(activeSlashCommand('第一行\n/审查', 7), { start: 4, end: 7, query: '审查' });
  // Must not falsely trigger on paths, URLs, or mid-word slashes
  assert.equal(activeSlashCommand('/usr/local/bin', 14), null);
  assert.equal(activeSlashCommand('https://rivloom.com/docs', 24), null);
  assert.equal(activeSlashCommand('foo/bar', 7), null);
  assert.equal(activeSlashCommand('/plan next', 10), null);
});

test('applySlashInsertion replaces only the active slash token and places caret cleanly', () => {
  const inserted = applySlashInsertion('请帮忙 /plan 之后发我', { start: 4, end: 9, query: 'plan' }, '制定实施计划');
  assert.equal(inserted.text, '请帮忙 制定实施计划 之后发我');
  assert.equal(inserted.cursor, 10);

  const cleared = applySlashInsertion('/diff', { start: 0, end: 5, query: 'diff' }, '');
  assert.equal(cleared.text, '');
  assert.equal(cleared.cursor, 0);
});

test('filterSlashItems ranks exact command prefix before keyword matches', () => {
  const items: SlashCommandItem[] = [
    { id: 'review', command: '/review', label: '检查当前改动', detail: '审查代码', group: 'builtin', keywords: 'review diff', insertText: 'review' },
    { id: 'diff', command: '/diff', label: '打开工作区改动检视', detail: '查看 Diff', group: 'builtin', action: 'diff' },
    templateToSlashItem({ id: 't1', title: '周报汇总', text: '整理本周提交记录与风险清单', revision: 1, updatedAt: '' }),
  ];
  assert.equal(filterSlashItems(items, '').length, 3);
  assert.deepEqual(filterSlashItems(items, 'dif').map((i) => i.id), ['diff', 'review']);
  assert.deepEqual(filterSlashItems(items, '周报').map((i) => i.id), ['template:t1']);
  assert.deepEqual(filterSlashItems(items, '风险清单').map((i) => i.id), ['template:t1']);
});
