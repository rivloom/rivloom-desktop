import assert from 'node:assert/strict';

export const desktopNodeVersion = '24.19.0';
export const desktopPlatforms = {
  'windows-x64': {
    platform: 'win32', arch: 'x64', executable: 'node.exe',
    url: `https://nodejs.org/dist/v${desktopNodeVersion}/win-x64/node.exe`,
    sha256: '3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237',
  },
  'darwin-arm64': {
    platform: 'darwin', arch: 'arm64', executable: 'node',
    url: `https://nodejs.org/dist/v${desktopNodeVersion}/node-v${desktopNodeVersion}-darwin-arm64.tar.gz`,
    sha256: '8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d',
  },
} as const;
export type DesktopPlatform = keyof typeof desktopPlatforms;

export function desktopPlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): DesktopPlatform {
  if (platform === 'win32' && arch === 'x64') return 'windows-x64';
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  throw new Error(`Unsupported desktop platform: ${platform}/${arch}. Supported: Windows x64 and macOS ARM64.`);
}

export function assertMacosArm64Executable(bytes: Buffer) {
  assert(bytes.length >= 32 && bytes.readUInt32LE(0) === 0xfeedfacf, 'Expected a thin 64-bit Mach-O executable');
  assert.equal(bytes.readUInt32LE(4), 0x0100000c, 'Expected macOS ARM64');
  assert.equal(bytes.readUInt32LE(8), 0, 'Expected general ARM64');
  assert.equal(bytes.readUInt32LE(12), 2, 'Expected a Mach-O executable');
  assert(bytes.readUInt32LE(16) > 0 && bytes.readUInt32LE(20) >= 8 && bytes.readUInt32LE(20) <= bytes.length - 32, 'Invalid Mach-O load commands');
}

// Match Tauri's JSON Merge Patch platform overrides, including removal via null.
export function mergeDesktopConfig(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    assert(!['__proto__', 'constructor', 'prototype'].includes(key), 'Invalid configuration key');
    if (value === null) delete merged[key];
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const previous = merged[key];
      merged[key] = mergeDesktopConfig(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous as Record<string, unknown> : {}, value as Record<string, unknown>);
    } else merged[key] = structuredClone(value);
  }
  return merged;
}
