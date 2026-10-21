export interface SourceFile {
  path: string;
  mode: string;
  tracked: boolean;
  type: string;
  bytes: number;
  sha256: string;
}
export interface SourceInventory {
  schemaVersion: number;
  commit: string;
  tree: string;
  dirty: boolean;
  status: string[];
  files: SourceFile[];
}
export function sourceInventory(root: string, requireClean?: boolean): SourceInventory;
export function verifyArtifact(directory: string, manifest: object): unknown;
