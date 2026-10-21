import type { SourceInventory, SourceFile } from './artifact.mjs';
export function portableInventoryDigest(files: SourceFile[]): string;
export function transformSource(bytes: Buffer, patch: { beforeSHA256: string; afterSHA256: string; edits: { before: string; after: string }[] }): Buffer;
export function applyMacosSourceOverlay(root: string, recipeRoot: string, base: SourceInventory): {
  compiled: SourceInventory;
  receipt: object;
  verify(): void;
  package(stage: string): void;
  restore(): void;
};
