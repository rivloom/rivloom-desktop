import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const out = resolve('docs/licenses');
mkdirSync(out, { recursive: true });
const licenseUrl = 'https://raw.githubusercontent.com/anomalyco/opencode/v1.18.25/LICENSE';
const response = await fetch(licenseUrl);
if (!response.ok) throw new Error('Cannot fetch official release license');
const license = await response.text();
if (!license.startsWith('MIT License')) throw new Error('Unexpected upstream license');
writeFileSync(join(out, 'OpenCode-MIT.txt'), license);
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const entries = Object.entries(lock.packages)
  .filter(([path]) => path && existsSync(path))
  .map(([path, info]) => {
    const value = info as { version: string; license?: string; dev?: boolean; integrity?: string };
    const name = path.split('node_modules/').at(-1)!;
    const found = readdirSync(path).find((file) => /^licen[cs]e(?:\.|$)/i.test(file));
    let licenseFile: string | null = null;
    if (found) {
      const target = name.replaceAll('/', '__').replaceAll('@', '') + '.txt';
      writeFileSync(join(out, target), readFileSync(join(path, found)));
      licenseFile = `licenses/${target}`;
    }
    return {
      name,
      version: value.version,
      license:
        value.license || (name === 'opencode-windows-x64' ? 'MIT (upstream)' : 'see package'),
      developmentOnly: !!value.dev,
      integrity: value.integrity,
      licenseFile,
    };
  });
writeFileSync('docs/dependency-licenses.json', JSON.stringify(entries, null, 2) + '\n');
const binary = readFileSync('node_modules/opencode-windows-x64/bin/opencode.exe');
writeFileSync(
  'docs/engine-lock.json',
  JSON.stringify(
    {
      version: '1.18.25',
      platform: 'windows-x64',
      package: 'opencode-windows-x64',
      sdk: '@opencode-ai/sdk',
      source: 'https://github.com/anomalyco/opencode/releases/tag/v1.18.25',
      license: 'MIT',
      licenseSource: licenseUrl,
      binarySha256: createHash('sha256').update(binary).digest('hex'),
      modified: false,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  `Recorded ${entries.length} installed dependency notices and official OpenCode release license.`,
);
