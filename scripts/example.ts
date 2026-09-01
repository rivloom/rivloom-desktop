import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { dataRoot } from '../server/engine.ts';
export function createExample(directory: string) {
  if (existsSync(directory)) throw new Error('目录已存在，不会覆盖。');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'slugify.mjs'), 'export function slugify(text) { return text; }\n');
  writeFileSync(
    join(directory, 'slugify.test.mjs'),
    `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from './slugify.mjs';\ntest('slugify', () => { assert.equal(slugify(' Hello, World! '), 'hello-world'); assert.equal(slugify(' a   b '), 'a-b'); assert.equal(slugify('---Hi---'), 'hi'); });\n`,
  );
  execFileSync('git', ['init', '-q'], { cwd: directory });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: directory });
  execFileSync('git', ['add', '.'], { cwd: directory });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Rivloom Example',
      '-c',
      'user.email=example@localhost',
      'commit',
      '-qm',
      'Initial fixture',
    ],
    { cwd: directory },
  );
}
if (process.argv[1]?.endsWith('example.ts')) {
  const directory = join(dataRoot, 'workspaces', 'slugify');
  createExample(directory);
  console.log(
    `测试仓库已创建：${directory}\n建议任务：修复 slugify.mjs，仅修改该文件，执行 node --test slugify.test.mjs，不修改测试。`,
  );
}
