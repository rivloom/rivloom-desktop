import { execFileSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const metadata = JSON.parse(
  execFileSync(
    'cargo',
    [
      'metadata',
      '--locked',
      '--format-version',
      '1',
      '--filter-platform',
      'x86_64-pc-windows-msvc',
    ],
    { cwd: join(root, 'src-tauri'), encoding: 'utf8', windowsHide: true, maxBuffer: 20_000_000 },
  ),
);
const inventory = [];
for (const pkg of metadata.packages) {
  if (pkg.name === 'rivloom-desktop') continue;
  const source = dirname(pkg.manifest_path);
  const files = (await readdir(source)).filter((file) =>
    /^(licen[cs]e|copying|notice)([.\-_]|$)/i.test(file),
  );
  if (pkg.license_file && !files.includes(pkg.license_file)) files.push(pkg.license_file);
  const target = join(root, 'docs', 'licenses', 'rust', `${pkg.name}-${pkg.version}`);
  await mkdir(target, { recursive: true });
  for (const file of files) await cp(join(source, file), join(target, file), { recursive: true });
  const upstreamNotices: string[] = [];
  if (!files.length) {
    // Cargo packages sometimes omit their workspace-level license. Resolve it at
    // the exact published VCS commit rather than silently omitting the notice.
    const vcs = JSON.parse(await readFile(join(source, '.cargo_vcs_info.json'), 'utf8'));
    const repository = pkg.repository
      .replace(/\.git$/, '')
      .replace(/\/$/, '')
      .replace('https://github.com/', 'https://raw.githubusercontent.com/');
    for (const name of [
      'LICENSE',
      'LICENSE-MIT',
      'LICENSE-APACHE',
      'LICENSE_MIT',
      'LICENSE_APACHE',
      'LICENSE.txt',
      'LICENSE.md',
    ]) {
      const url = `${repository}/${vcs.git.sha1}/${name}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (response.status === 404) continue;
      if (!response.ok) throw new Error(`License download failed: ${response.status}`);
      await writeFile(join(target, name), await response.text());
      files.push(name);
      upstreamNotices.push(url);
    }
    if (!files.length && pkg.license === 'MPL-2.0') {
      const url = 'https://www.mozilla.org/media/MPL/2.0/index.txt';
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error('Cannot retrieve canonical MPL notice');
      await writeFile(join(target, 'LICENSE-MPL-2.0.txt'), await response.text());
      files.push('LICENSE-MPL-2.0.txt');
      upstreamNotices.push(url);
    }
    if (!files.length) throw new Error(`Missing required license notice: ${pkg.name}`);
  }
  let bundledSource: string | null = null;
  if (pkg.license?.includes('MPL-2.0')) {
    // Preserve the exact unmodified published source for file-level copyleft dependencies.
    const registryRoot = dirname(dirname(source));
    const archive = join(
      registryRoot,
      '..',
      'cache',
      source.split(/[\\/]/).at(-2)!,
      `${pkg.name}-${pkg.version}.crate`,
    );
    await cp(archive, join(target, `${pkg.name}-${pkg.version}.crate`));
    bundledSource = `${pkg.name}-${pkg.version}.crate`;
  }
  inventory.push({
    name: pkg.name,
    version: pkg.version,
    license: pkg.license,
    repository: pkg.repository,
    licenseFiles: files,
    upstreamNotices,
    bundledSource,
  });
}
await writeFile(
  join(root, 'docs', 'desktop-dependency-licenses.json'),
  JSON.stringify(
    {
      date: new Date().toISOString(),
      scope:
        'Cargo resolved packages for Windows build, including build-time dependencies; not a complete binary SBOM',
      packages: inventory,
    },
    null,
    2,
  ),
);
console.log(
  `Recorded ${inventory.length} Rust package licenses; ${inventory.filter((p) => !p.licenseFiles.length).length} packages have SPDX metadata but no top-level notice file.`,
);
