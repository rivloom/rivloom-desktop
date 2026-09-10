export type DirectoryAliases = Record<string, string>;
export const maximumDirectoryAliasLength = 64;
export const maximumDirectoryAliases = 1000;

export function validDirectoryKey(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && /^(?:local|local-project|remote):[^\u0000-\u001f\u007f]+$/.test(value);
}
export function validDirectoryAlias(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximumDirectoryAliasLength && !/[\u0000-\u001f\u007f]/.test(value);
}

/** A local display name never replaces the stable directory identity or its full path. */
export function directoryDisplayName(directory: { key: string; label: string }, aliases: DirectoryAliases = {}): string {
  const alias = Object.hasOwn(aliases, directory.key) ? aliases[directory.key] : undefined;
  if (validDirectoryAlias(alias)) return alias;
  return directory.key.startsWith('local:') ? directory.label.split(/[\\/]+/).filter(Boolean).at(-1) || directory.label : directory.label;
}
