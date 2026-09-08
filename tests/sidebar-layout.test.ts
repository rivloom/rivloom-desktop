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
