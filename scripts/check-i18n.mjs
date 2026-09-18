import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8');
const en = JSON.parse(read('shared/locales/en.json'));
const zh = JSON.parse(read('shared/locales/zh-CN.json'));
const system = JSON.parse(read('shared/locales/system-en.json'));
const han = /[\u3400-\u9fff]/;
const slots = (value) => [...value.matchAll(/\{\{\w+\}\}/g)].map((m) => m[0]).sort();
assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), 'UI locale key parity');
for (const [key, value] of Object.entries({ ...en, ...system })) {
  assert.equal(typeof value, 'string', key);
  assert(value.trim(), `Empty English translation: ${key}`);
  assert(!han.test(value), `Untranslated English value: ${key}`);
  assert.deepEqual(slots(value), slots(key), `Interpolation parity: ${key}`);
}
for (const [key, value] of Object.entries(zh))
  assert.equal(value, key, 'Chinese catalog preserves source keys');

const failures = [];
let phrases = 0;
function sourceFiles(directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? sourceFiles(path) : /\.(?:tsx?|mjs)$/.test(path) ? [path] : [];
  });
}
for (const file of [...sourceFiles('src'), ...sourceFiles('shared'), ...sourceFiles('server')]) {
  const ast = parse(read(file), { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  const service = file.startsWith('server/');
  function fail(node, message) {
    failures.push(`${file}:${node.loc.start.line}: ${message}`);
  }
  function visit(node, parent) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'StringLiteral' && han.test(node.value)) {
      const key = node.value;
      const persistedDelimiter =
        file === 'src/conversation-workspace.tsx' && key === '\n\n补充要求：';
      const storedLanguageError =
        file === 'src/language-switcher.tsx' &&
        parent?.type === 'CallExpression' &&
        parent.callee.name === 'setError';
      const translated =
        parent?.type === 'CallExpression' &&
        parent.callee.name === 't' &&
        parent.arguments[0] === node;
      if (!persistedDelimiter && !/^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i.test(key)) {
        phrases++;
        if (!Object.hasOwn(service ? { ...en, ...system } : en, key))
          fail(node, `Missing English key: ${key}`);
        if (!service && !translated && !storedLanguageError) fail(node, `Raw UI string: ${key}`);
      }
    }
    if (node.type === 'JSXText' && han.test(node.value) && node.value.trim() !== '简体中文')
      fail(node, `Raw JSX text: ${node.value.trim()}`);
    if (node.type === 'TemplateLiteral') {
      let key = node.quasis[0].value.cooked;
      for (let index = 0; index < node.expressions.length; index++)
        key += `{{value${index + 1}}}` + node.quasis[index + 1].value.cooked;
      if (han.test(key)) {
        phrases++;
        if (!service) fail(node, `Raw UI template: ${key}`);
        else if (!Object.hasOwn({ ...en, ...system }, key))
          fail(node, `Missing system template: ${key}`);
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (
        [
          'loc',
          'start',
          'end',
          'extra',
          'comments',
          'leadingComments',
          'trailingComments',
          'innerComments',
        ].includes(key)
      )
        continue;
      if (Array.isArray(value)) for (const child of value) visit(child, node);
      else if (value && typeof value === 'object') visit(value, node);
    }
  }
  visit(ast, null);
}
// These two pre-window diagnostics occur before a locale can be loaded.
const nativeDiagnostics = new Set(['RIVLOOM_DATA_DIR 必须是绝对路径', 'Rivloom 桌面初始化失败']);
for (const file of ['src-tauri/src/main.rs', 'src-tauri/src/desktop_tray.rs']) {
  for (const match of read(file).matchAll(/"((?:\\.|[^"\\])*)"/g)) {
    const source = match[1];
    if (han.test(source) && !nativeDiagnostics.has(source) && !Object.hasOwn(en, source))
      failures.push(`${file}: Native translation missing: ${source}`);
  }
}
assert.equal(failures.length, 0, failures.join('\n'));
console.log(
  `Localization coverage passed: ${Object.keys(en).length} UI/native keys, ${Object.keys(system).length} system keys, ${phrases} source phrases.`,
);
