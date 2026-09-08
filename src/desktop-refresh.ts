/** Reuse unchanged branches of a parsed JSON response, without mutating either input.
 * Task versions alone are insufficient: streamed messages and permission data must
 * still be compared. Only JSON containers are traversed; other values are replaced.
 */
export function reuseJson<T>(previous: unknown, incoming: T): T {
  if (Object.is(previous, incoming)) return incoming;
  if (
    !previous ||
    !incoming ||
    typeof previous !== 'object' ||
    typeof incoming !== 'object' ||
    Array.isArray(previous) !== Array.isArray(incoming)
  )
    return incoming;
  if (
    !Array.isArray(incoming) &&
    (Object.getPrototypeOf(previous) !== Object.prototype ||
      Object.getPrototypeOf(incoming) !== Object.prototype)
  )
    return incoming;
  const old = previous as Record<string, unknown>,
    next = incoming as Record<string, unknown>;
  const keys = Object.keys(next);
  let equal =
    Object.keys(old).length === keys.length &&
    (!Array.isArray(incoming) || (previous as unknown[]).length === incoming.length);
  let result = next;
  for (const key of keys) {
    const exists = Object.hasOwn(old, key);
    const value = exists ? reuseJson(old[key], next[key]) : next[key];
    if (!exists || !Object.is(value, old[key])) equal = false;
    if (!Object.is(value, next[key])) {
      if (result === next)
        result = (Array.isArray(incoming) ? [...incoming] : { ...next }) as Record<string, unknown>;
      Object.defineProperty(result, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
  return (equal ? previous : result) as T;
}

export type RefreshScope = 'full' | 'network';

/** Serialize refreshes and retain an invalidation that arrives during an HTTP request. */
export function createRefreshQueue(run: (scope: RefreshScope) => Promise<void>) {
  let pending: RefreshScope | null = null;
  let active: Promise<void> | null = null;
  return function refresh(scope: RefreshScope = 'full'): Promise<void> {
    pending = pending === 'full' || scope === 'full' ? 'full' : 'network';
    if (!active) {
      active = (async () => {
        try {
          while (pending) {
            const next = pending;
            pending = null;
            await Promise.resolve().then(() => run(next));
          }
        } finally {
          active = null;
        }
      })();
    }
    return active;
  };
}
