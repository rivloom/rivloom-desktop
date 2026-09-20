import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  availableWorkspaceCommands, executeWorkspaceCommand, searchWorkspaceCommands,
  workspaceCommandKey, workspaceShortcutForEvent, type WorkspaceCommand, type WorkspaceKeyEvent,
} from '../src/workspace-commands.ts';

function commands(): { values: WorkspaceCommand[]; calls: string[] } {
  const calls: string[] = [];
  return { calls, values: [
    { kind: 'action', id: 'new-conversation', label: '新会话', keywords: ['new conversation'], run: () => calls.push('new') },
    { kind: 'action', id: 'queue', label: '执行队列', run: () => calls.push('queue') },
    { kind: 'action', id: 'knowledge', label: '技能与记忆', run: () => calls.push('knowledge') },
    { kind: 'action', id: 'trash', label: '回收站', run: () => calls.push('trash') },
    { kind: 'action', id: 'models', label: '模型', disabled: true, run: () => calls.push('models') },
    { kind: 'conversation', id: 'local:secret', label: 'Owner only notes', ownerOnly: true, run: () => calls.push('secret') },
    { kind: 'conversation', id: 'workflow:one', label: 'Linux audit', detail: '设计目录', run: () => calls.push('old') },
    { kind: 'draft', id: 'workflow:one', label: 'Linux audit', detail: '设计目录', run: () => calls.push('draft') },
    { kind: 'conversation', id: 'local:two', label: 'C++ [report] ＡＢＣ', detail: 'Linux', run: () => calls.push('two') },
  ] };
}

test('navigation commands omit owner-only actions and reject restricted execution independently of search', () => {
  const { values, calls } = commands();
  const guest = availableWorkspaceCommands(values, false);
  assert.deepEqual(guest.map((command) => command.id), ['new-conversation', 'models', 'workflow:one', 'local:two']);
  assert.equal(searchWorkspaceCommands(values, 'Owner only', false).length, 0);
  for (const command of values.filter((item) => ['queue', 'knowledge', 'trash', 'local:secret'].includes(item.id))) {
    assert.equal(executeWorkspaceCommand(command, false), false);
    assert.equal(executeWorkspaceCommand(command, true), true);
  }
  assert.deepEqual(calls, ['queue', 'knowledge', 'trash', 'secret']);
  assert.equal(executeWorkspaceCommand(values[4], true), false);
  assert.equal(executeWorkspaceCommand(values[0], false), true);
  assert.deepEqual(calls, ['queue', 'knowledge', 'trash', 'secret', 'new']);
});

test('action allowlist cannot become a hidden send, approval or deletion shortcut', () => {
  const calls: string[] = [];
  for (const id of ['send', 'approve', 'delete', 'exec']) {
    const command = { kind: 'action', id, label: id, run: () => calls.push(id) } as WorkspaceCommand;
    assert.deepEqual(availableWorkspaceCommands([command], true), []);
    assert.equal(executeWorkspaceCommand(command, true), false);
  }
  assert.deepEqual(calls, []);
});

test('project changes navigation remains owner-only while templates, find and export are regular navigation', () => {
  const calls: string[] = [];
  const projectChanges: WorkspaceCommand = { kind: 'action', id: 'project-changes', label: 'Project changes', run: () => calls.push('changes') };
  assert.deepEqual(availableWorkspaceCommands([projectChanges], false), []);
  assert.equal(executeWorkspaceCommand(projectChanges, false), false);
  assert.equal(executeWorkspaceCommand(projectChanges, true), true);
  assert.deepEqual(calls, ['changes']);
  for (const id of ['templates', 'find-current', 'export-conversation'] as const) {
    const command: WorkspaceCommand = { kind: 'action', id, label: id, run: () => undefined };
    assert.equal(executeWorkspaceCommand(command, false), true);
  }
});

test('search supports translated labels, aliases and literal Unicode without duplicating a recent draft', () => {
  const { values, calls } = commands();
  const before = [...values];
  assert.equal(searchWorkspaceCommands(values, 'new conversation', false)[0].id, 'new-conversation');
  assert.equal(searchWorkspaceCommands(values, 'LINUX 设计', false)[0].kind, 'draft');
  assert.equal(searchWorkspaceCommands(values, '[report] abc', false)[0].id, 'local:two');
  assert.deepEqual(searchWorkspaceCommands(values, 'not found', true), []);
  const result = searchWorkspaceCommands(values, 'Linux', true);
  assert.equal(result.filter((item) => item.id === 'workflow:one').length, 1);
  assert.equal(workspaceCommandKey(result[0]), 'conversation:workflow:one');
  executeWorkspaceCommand(result[0], true);
  assert.deepEqual(calls, ['draft']);
  assert.deepEqual(values, before);
  assert.equal(searchWorkspaceCommands(values, '', true, 2).length, 2);
  assert.deepEqual(searchWorkspaceCommands(values, '', true, -1), []);
});

test('workspace shortcuts accept exact Ctrl or Cmd chords and preserve unrelated editor shortcuts', () => {
  for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
    assert.equal(workspaceShortcutForEvent({ key: 'k', ...modifier }), 'palette');
    for (const [key, result] of [['N', 'new-conversation'], ['f', 'search-conversations'], ['L', 'focus-composer']] as const)
      assert.equal(workspaceShortcutForEvent({ key, shiftKey: true, ...modifier }), result);
    for (const key of ['Enter', 'n', 'f', 'l', 'c', 'v', 'a', 'z']) assert.equal(workspaceShortcutForEvent({ key, ...modifier }), null);
  }
  assert.equal(workspaceShortcutForEvent({ key: 'k' }), null);
  assert.equal(workspaceShortcutForEvent({ key: 'k', ctrlKey: true, shiftKey: true }), null);
});

test('IME confirmation, repeated keys, AltGr, nested dialogs and consumed keys cannot navigate', () => {
  const chord: WorkspaceKeyEvent = { key: 'k', ctrlKey: true };
  for (const extra of [{ repeat: true }, { altKey: true }, { metaKey: true }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }])
    assert.equal(workspaceShortcutForEvent({ ...chord, ...extra }), null);
  assert.equal(workspaceShortcutForEvent(chord, { blocked: true }), null);
  assert.equal(workspaceShortcutForEvent(chord, { composing: true }), null);
  assert.equal(workspaceShortcutForEvent(chord, { composing: false, blocked: false }), 'palette');
});
