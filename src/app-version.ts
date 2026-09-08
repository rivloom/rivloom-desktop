/** Accept only a short version label, never arbitrary native or engine response text. */
export function displayVersion(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 80) return null;
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(
    value,
  )
    ? value
    : null;
}

/** desktop_info also carries authentication and local paths; select only its version. */
export function installedVersion(info: unknown): string | null {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return null;
  return displayVersion((info as { version?: unknown }).version);
}
