export type LocalActivityKind = 'file-read' | 'file-save';
export type LocalActivity = Readonly<{
  id: string;
  kind: LocalActivityKind;
  state: 'running' | 'completed' | 'failed';
  label?: string;
  errorCode?: string;
  startedAt: number;
  finishedAt?: number;
}>;

const fileErrors = new Set([
  'office_destination_exists', 'office_too_large', 'office_invalid', 'office_encrypted',
  'office_unsupported', 'office_busy', 'office_timeout', 'office_unavailable', 'office_path',
  'office_changed', 'office_edit_unavailable', 'office_owner_only', 'office_project_missing',
  'office_page', 'office_sheet',
]);

function safeError(cause: unknown) {
  const value = typeof cause === 'string' ? cause : cause && typeof cause === 'object'
    ? ('code' in cause && typeof cause.code === 'string' ? cause.code : 'message' in cause ? cause.message : '') : '';
  return typeof value === 'string' && fileErrors.has(value) ? value : 'office_unavailable';
}

function safeLabel(value?: string) {
  // Keep only a display name. Activity must never retain document contents or paths.
  const name = value?.replaceAll('\\', '/').split('/').filter(Boolean).at(-1)
    ?.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 80);
  return name && !/^[a-z]:$/i.test(name) && name !== '.' && name !== '..' ? name : undefined;
}

/** An in-memory store; no persistence, broadcasting or React component lifetime. */
export function createLocalActivityStore(options: { limit?: number; completedMilliseconds?: number } = {}) {
  const limit = Math.max(1, Math.min(128, Math.floor(options.limit ?? 32)));
  const completedMilliseconds = Math.max(0, options.completedMilliseconds ?? 2000);
  const listeners = new Set<() => void>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let snapshot: readonly LocalActivity[] = Object.freeze([]), sequence = 0;
  const publish = (next: readonly LocalActivity[]) => {
    snapshot = Object.freeze(next); for (const listener of listeners) listener();
  };
  const cancelTimer = (id: string) => {
    const timer = timers.get(id); if (timer !== undefined) clearTimeout(timer); timers.delete(id);
  };
  const dismiss = (id: string) => {
    if (!snapshot.some(activity => activity.id === id)) return;
    cancelTimer(id); publish(snapshot.filter(activity => activity.id !== id));
  };
  const begin = (kind: LocalActivityKind, label?: string) => {
    // Never reuse IDs after clear: promises from a previous identity cannot write into a new one.
    const id = `local-activity-${++sequence}`;
    const next = [...snapshot];
    if (next.length >= limit) {
      const completed = next.findIndex(activity => activity.state === 'completed');
      const terminal = next.findIndex(activity => activity.state !== 'running');
      const [removed] = next.splice(completed >= 0 ? completed : terminal >= 0 ? terminal : 0, 1);
      cancelTimer(removed.id);
    }
    next.push(Object.freeze({ id, kind, state: 'running', label: safeLabel(label), startedAt: Date.now() }));
    publish(next); return id;
  };
  const settle = (id: string, state: 'completed' | 'failed', errorCode?: string) => {
    const current = snapshot.find(activity => activity.id === id);
    if (!current || current.state !== 'running') return;
    if (state === 'completed') {
      const timer = setTimeout(() => dismiss(id), completedMilliseconds);
      // In Node tests, a completed visual acknowledgement must not keep the process alive.
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
      timers.set(id, timer);
    }
    publish(snapshot.map(activity => activity.id === id
      ? Object.freeze({ ...activity, state, finishedAt: Date.now(), ...(errorCode ? { errorCode } : {}) }) : activity));
  };
  const finish = (id: string) => settle(id, 'completed');
  const fail = (id: string, cause?: unknown) => settle(id, 'failed', safeError(cause));
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    begin, finish, fail, dismiss,
    clear: () => {
      for (const id of timers.keys()) cancelTimer(id);
      if (snapshot.length) publish([]);
    },
    async run<T>(kind: LocalActivityKind, label: string | undefined, action: () => Promise<T>): Promise<T> {
      const id = begin(kind, label);
      try { const value = await action(); finish(id); return value; }
      catch (cause) { fail(id, cause); throw cause; }
    },
  };
}

export const localActivity = createLocalActivityStore();
