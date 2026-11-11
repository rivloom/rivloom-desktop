import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createThemeState, normalizeTheme, resolveTheme } from '../src/theme.ts';

test('the real document bootstrap applies the native or browser choice before app loading', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const bootstrap = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  for (const [native, stored, systemDark, expected] of [
    ['dark', 'light', false, 'dark'], ['light', 'dark', true, 'light'],
    [undefined, 'dark', false, 'dark'], [undefined, 'system', true, 'dark'],
    [undefined, 'invalid', false, 'light'],
  ] as const) {
    const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
    vm.runInNewContext(bootstrap, { window: { __RIVLOOM_THEME__: native },
      localStorage: { getItem: () => stored }, matchMedia: () => ({ matches: systemDark }),
      document: { documentElement: root, querySelector: () => ({ content: '' }) },
    });
    assert.equal(root.dataset.theme, expected);
    assert.equal(root.style.colorScheme, expected);
    assert.equal(root.style.backgroundColor, expected === 'dark' ? '#1e2025' : '#ffffff');
  }
});

test('explicit themes override the system; invalid stored preferences fall back safely', () => {
  for (const value of [null, undefined, '', 'Dark', '<script>', {}, 'system']) assert.equal(normalizeTheme(value), 'system');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
});

test('system changes preserve the preference and explicit selection ignores them', async () => {
  const writes: string[] = [], applied: string[] = [];
  const state = createThemeState({ preference: 'system', systemDark: false, save: async value => { writes.push(value); }, apply: value => { applied.push(value); } });
  state.systemChanged(true);
  assert.deepEqual(state.getSnapshot(), { preference: 'system', resolved: 'dark', saving: false, failed: false });
  assert.deepEqual(writes, []);
  await state.select('light');
  state.systemChanged(false); state.systemChanged(true);
  assert.equal(state.getSnapshot().resolved, 'light');
  assert.deepEqual(writes, ['light']);
  assert.equal(applied.at(-1), 'light');
});

test('failed persistence keeps the previously selected theme and allows retry', async () => {
  let fail = true;
  const state = createThemeState({ preference: 'light', systemDark: true, save: async () => { if (fail) throw new Error('disk full'); }, apply: () => {} });
  await state.select('dark');
  assert.deepEqual(state.getSnapshot(), { preference: 'light', resolved: 'light', saving: false, failed: true });
  fail = false; await state.select('dark');
  assert.deepEqual(state.getSnapshot(), { preference: 'dark', resolved: 'dark', saving: false, failed: false });
});

test('a pending save cannot be overwritten and resolves using the current system appearance', async () => {
  let finish!: () => void;
  const writes: string[] = [];
  const state = createThemeState({ preference: 'light', systemDark: false, save: value => { writes.push(value); return new Promise<void>(resolve => { finish = resolve; }); }, apply: () => {} });
  const pending = state.select('system');
  await state.select('dark');
  state.systemChanged(true);
  assert.equal(state.getSnapshot().preference, 'light');
  finish(); await pending;
  assert.deepEqual(writes, ['system']);
  assert.deepEqual(state.getSnapshot(), { preference: 'system', resolved: 'dark', saving: false, failed: false });
});
