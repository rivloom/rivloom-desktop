import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultSidebarWidths,
  resizeSidebar,
  sidebarBounds,
  sidebarLayout,
} from '../shared/sidebar-layout.ts';
import { WorkspacePreferences } from '../server/workspace-preferences.ts';
import { directoryDisplayName } from '../shared/directory-aliases.ts';

test('sidebar defaults preserve desktop, narrow-window and unpaired layouts', () => {
  for (const [width, paired, history, network] of [
    [1280, true, 252, 280],
    [960, true, 218, 244],
    [860, true, 200, 205],
    [1280, false, 252, 0],
    [860, false, 226, 0],
  ] as const) {
    const actual = sidebarLayout(width, paired, defaultSidebarWidths());
    assert.equal(actual.history, history);
    assert.equal(actual.network, network);
  }
});

test('oversized saved sidebars fit the center at every desktop width without changing preferences', () => {
  const saved = { history: 480, network: 480 };
  for (let width = 741; width <= 1600; width++) {
    const layout = sidebarLayout(width, true, saved);
    assert(layout.history >= sidebarBounds.history.min);
    assert(layout.network >= sidebarBounds.network.min);
    assert(layout.history + layout.network + layout.minimumCenter <= width);
    assert(layout.historyMax >= layout.history);
    assert(layout.networkMax >= layout.network);
  }
  assert.deepEqual(saved, { history: 480, network: 480 });
  assert.equal(sidebarLayout(1600, true, saved).history, 480);
  assert.equal(sidebarLayout(1600, true, saved).network, 480);
});

test('dragging one sidebar holds the opposite visible width and clamps both edges', () => {
  const saved = { history: 480, network: 480 };
  const layout = sidebarLayout(860, true, saved);
  const left = resizeSidebar(layout, saved, 'history', 10000);
  assert.equal(left.network, layout.network);
  assert.equal(left.history, layout.historyMax);
  const right = resizeSidebar(layout, saved, 'network', -10000);
  assert.equal(right.history, layout.history);
  assert.equal(right.network, sidebarBounds.network.min);
  const alone = resizeSidebar(sidebarLayout(1000, false, saved), saved, 'history', 300);
  assert.deepEqual(alone, { history: 300, network: 480 });
});

test('sidebar widths persist across database reopen, stay per user and support default reset', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rivloom-sidebar-widths-'));
  const file = join(directory, 'preferences.sqlite');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file);
    db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    let store = new WorkspacePreferences(db);
    assert.deepEqual(store.sidebarWidths('one'), defaultSidebarWidths());
    store.saveSidebarWidths('one', { history: 320, network: 360 });
    store.saveSidebarWidths('two', { history: 250, network: null });
    db.close();
    db = new DatabaseSync(file);
    store = new WorkspacePreferences(db);
    assert.deepEqual(store.sidebarWidths('one'), { history: 320, network: 360 });
    assert.deepEqual(store.sidebarWidths('two'), { history: 250, network: null });
    assert.deepEqual(store.sidebarWidths('unknown'), defaultSidebarWidths());
    store.saveSidebarWidths('one', defaultSidebarWidths());
    assert.deepEqual(store.sidebarWidths('one'), defaultSidebarWidths());
  } finally {
    db?.close();
    rmSync(file, { force: true });
    rmdirSync(directory);
  }
});

test('invalid width writes are rejected without replacing stored values; malformed storage falls back', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const store = new WorkspacePreferences(db);
    const valid = { history: 300, network: 280 };
    store.saveSidebarWidths('one', valid);
    for (const invalid of [
      { history: 199, network: 280 },
      { history: 300, network: 481 },
      { history: 250.5, network: null },
      { history: '300', network: null },
      { ...valid, userID: 'someone-else' },
      {},
      null,
    ]) {
      assert.throws(() => store.saveSidebarWidths('one', invalid));
      assert.deepEqual(store.sidebarWidths('one'), valid);
    }
    db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(
      'broken',
      'ui.sidebar-widths:one',
    );
    assert.deepEqual(store.sidebarWidths('one'), defaultSidebarWidths());
  } finally {
    db.close();
  }
});

test('directory aliases persist per user and stable directory key, without replacing neighboring aliases', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rivloom-directory-aliases-'));
  const file = join(directory, 'preferences.sqlite');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file);
    db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    let store = new WorkspacePreferences(db);
    store.saveDirectoryAlias('one', { key: 'local:c:/work/site', alias: '  官网  ' });
    store.saveDirectoryAlias('one', { key: 'remote:peer:project', alias: '远端项目' });
    store.saveDirectoryAlias('two', { key: 'local:c:/work/site', alias: '我的网站' });
    db.close(); db = new DatabaseSync(file); store = new WorkspacePreferences(db);
    assert.deepEqual(store.directoryAliases('one'), { 'local:c:/work/site': '官网', 'remote:peer:project': '远端项目' });
    assert.deepEqual(store.directoryAliases('two'), { 'local:c:/work/site': '我的网站' });
    assert.deepEqual(store.directoryAliases('unknown'), {});
    store.saveDirectoryAlias('one', { key: 'local:c:/work/site', alias: null });
    assert.deepEqual(store.directoryAliases('one'), { 'remote:peer:project': '远端项目' });
    assert.equal(directoryDisplayName({ key: 'local:c:/work/site', label: 'C:\\work\\site\\' }, store.directoryAliases('one')), 'site');
  } finally { db?.close(); rmSync(file, { force: true }); rmdirSync(directory); }
});

test('invalid aliases and failed writes preserve prior values; unrelated user fields cannot change ownership', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const store = new WorkspacePreferences(db), key = 'local:c:/work/site';
    store.saveDirectoryAlias('one', { key, alias: 'Keep' });
    for (const input of [{ key, alias: '' }, { key, alias: '   ' }, { key, alias: 'x'.repeat(65) },
      { key, alias: 'line\nbreak' }, { key, alias: 'hidden\u0000text' }, { key: '__proto__', alias: 'bad' },
      { key: 'local:\nsecret', alias: 'bad' }, { key, alias: 'other', userID: 'two' }, { key }, null]) {
      assert.throws(() => store.saveDirectoryAlias('one', input));
      assert.deepEqual(store.directoryAliases('one'), { [key]: 'Keep' });
      assert.deepEqual(store.directoryAliases('two'), {});
    }
    db.exec("CREATE TRIGGER reject_alias_write BEFORE UPDATE ON app_settings BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
    assert.throws(() => store.saveDirectoryAlias('one', { key, alias: 'Changed' }));
    assert.deepEqual(store.directoryAliases('one'), { [key]: 'Keep' });
  } finally { db.close(); }
});
