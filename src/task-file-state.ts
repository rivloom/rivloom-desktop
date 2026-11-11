import type { TaskFileConversation, TaskFileScope } from '../shared/task-files.ts';
import { reuseJson } from './desktop-refresh.ts';

export type TaskFileQuery = { scope: TaskFileScope; taskID: string };
export type TaskFileState = {
  route: TaskFileQuery; value: TaskFileConversation | null; loading: boolean;
  fresh: boolean; error: string | null; revision: number;
};
export const taskFileQueryKey = (route: TaskFileQuery) => `${route.scope}:${route.taskID}`;
type Entry = { state: TaskFileState; listeners: Set<() => void>; requested: Set<string>; pending: Set<string>;
  requestVersion: number; requestPhase: Map<string, 'dispatching' | 'unknown' | 'accepted'>;
  requestErrors: Map<string, string>;
  controller?: AbortController; generation: number; nextAt: number; failures: number; touched: number; lastReadAt: number };
type Options = {
  load: (route: TaskFileQuery, signal: AbortSignal) => Promise<TaskFileConversation>;
  now?: () => number; pollMilliseconds?: number; maxInactive?: number;
};
const pending = (value: TaskFileConversation) => [...value.inputs, ...value.results].some(file =>
  file.state === 'receiving' || file.deliveries.some(delivery => ['waiting', 'sending'].includes(delivery.state)));

/** One bounded scheduler for all consumers; acknowledgements remain server-owned. */
export function createTaskFileState(options: Options) {
  const entries = new Map<string, Entry>();
  const requestListeners = new Set<() => void>();
  const now = options.now || Date.now, interval = options.pollMilliseconds ?? 1500;
  let timer: ReturnType<typeof setTimeout> | undefined, running = 0, visible = true, disposed = false, epoch = 0;
  let requestedRoutes: readonly TaskFileQuery[] = [];
  // A retained failure remains visible/retryable, but does not occupy a live
  // retrieval slot. Unconfirmed requests still count until the server settles them.
  const active = (entry: Entry) => entry.listeners.size > 0 || entry.pending.size > 0;
  const pendingCount = () => [...entries.values()].reduce((sum, entry) => sum + entry.pending.size, 0);
  const notify = (entry: Entry, patch: Partial<TaskFileState>) => {
    entry.state = { ...entry.state, ...patch, revision: entry.state.revision + 1 };
    for (const listener of entry.listeners) listener();
  };
  function updateRequested() {
    const next = [...entries.values()].filter(entry => entry.requested.size).map(entry => entry.state.route);
    if (next.length === requestedRoutes.length && next.every((route, i) => taskFileQueryKey(route) === taskFileQueryKey(requestedRoutes[i]))) return;
    requestedRoutes = next;
    for (const listener of requestListeners) listener();
  }
  function trim() {
    const inactive = [...entries].filter(([, entry]) => !active(entry) && !entry.controller).sort((a, b) => a[1].touched - b[1].touched);
    let removedRequest = false;
    for (const [key, entry] of inactive.slice(0, Math.max(0, inactive.length - (options.maxInactive ?? 64)))) {
      removedRequest ||= entry.requested.size > 0;
      entries.delete(key);
    }
    // snapshot() may trim while React reads it. Publish removals after that read,
    // not as a state update during another component's render.
    if (removedRequest) queueMicrotask(() => { if (!disposed) updateRequested(); });
  }
  function get(route: TaskFileQuery) {
    const key = taskFileQueryKey(route);
    let entry = entries.get(key);
    if (!entry) {
      entry = { state: { route: { ...route }, value: null, loading: false, fresh: false, error: null, revision: 0 },
        listeners: new Set(), requested: new Set(), pending: new Set(), requestPhase: new Map(), requestVersion: 0,
        requestErrors: new Map(), generation: 0, nextAt: Infinity, failures: 0, touched: now(), lastReadAt: -Infinity };
      entries.set(key, entry);
    }
    entry.touched = now();
    trim();
    return entry;
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!visible || disposed) return;
    const due = [...entries.values()].filter(entry => active(entry) && !entry.controller);
    if (running < 4) {
      for (const entry of due) {
        if (running >= 4) break;
        if (entry.nextAt <= now()) void run(entry);
      }
    }
    const next = running >= 4 ? Infinity : Math.min(Infinity, ...[...entries.values()]
      .filter(entry => active(entry) && !entry.controller).map(entry => entry.nextAt));
    if (Number.isFinite(next)) timer = setTimeout(schedule, Math.max(1, next - now()));
  }
  async function run(entry: Entry) {
    const controller = new AbortController(), generation = entry.generation, requestVersion = entry.requestVersion;
    entry.controller = controller; entry.nextAt = Infinity; entry.lastReadAt = now(); running++;
    notify(entry, { loading: !entry.state.value });
    try {
      const value = await options.load(entry.state.route, controller.signal);
      if (disposed || controller.signal.aborted || generation !== entry.generation) return;
      entry.failures = 0;
      const next = reuseJson(entry.state.value, value);
      for (const fileID of entry.requested) {
        const file = value.results.find(file => file.id === fileID);
        // A GET started before a retry/POST outcome can contain the previous
        // attempt's failure. It may be displayed, but cannot settle the new slot.
        const currentRequest = requestVersion === entry.requestVersion;
        if (currentRequest && file?.state === 'receiving' && entry.requestPhase.get(fileID) === 'unknown') entry.requestPhase.set(fileID, 'accepted');
        const confirmed = currentRequest && entry.requestPhase.get(fileID) !== 'dispatching'
          && (file?.state === 'complete' || entry.requestPhase.get(fileID) === 'accepted');
        if (confirmed && file && file.state !== 'remote') entry.requestErrors.delete(fileID);
        if (confirmed && (file?.state === 'complete' || file?.state === 'failed')) {
          entry.pending.delete(fileID); entry.requestPhase.delete(fileID);
          if (file.state === 'complete') entry.requested.delete(fileID);
        }
      }
      const error = entry.requestErrors.values().next().value || null;
      notify(entry, { value: next, fresh: !error, loading: false, error });
      updateRequested();
      // Explicit fetches may initially return metadata before the first block arrives.
      const requestedPending = entry.pending.size > 0;
      if (pending(value) || requestedPending) entry.nextAt = Math.min(entry.nextAt, now() + (error ? Math.max(interval, 10_000) : interval));
    } catch (error) {
      if (disposed || controller.signal.aborted || generation !== entry.generation) return;
      entry.failures++;
      notify(entry, { loading: false, fresh: false, error: error instanceof Error ? error.message : String(error) });
      entry.nextAt = Math.min(entry.nextAt, now() + Math.min(30_000, interval * 2 ** Math.min(entry.failures - 1, 5)));
    } finally {
      running--; entry.controller = undefined;
      trim(); schedule();
    }
  }
  function invalidate(entry: Entry) {
    entry.nextAt = 0;
    if (!visible) notify(entry, { fresh: false });
    schedule();
  }
  function request(route: TaskFileQuery, fileID: string) {
    if (!entries.get(taskFileQueryKey(route))?.pending.has(fileID) && pendingCount() >= 64) return false;
    const entry = get(route);
    entry.requested.add(fileID); entry.pending.add(fileID); entry.requestPhase.set(fileID, 'dispatching'); entry.requestVersion++;
    entry.requestErrors.delete(fileID); updateRequested(); invalidate(entry);
    return true;
  }
  function requestAccepted(route: TaskFileQuery, fileID: string) {
    const entry = get(route);
    if (!entry.pending.has(fileID)) return;
    entry.requestPhase.set(fileID, 'accepted'); entry.requestVersion++;
    invalidate(entry);
  }
  function requestFailed(route: TaskFileQuery, fileID: string, error: string, definitive = false) {
    const entry = get(route);
    if (!entry.requested.has(fileID)) return;
    if (definitive) { entry.pending.delete(fileID); entry.requestPhase.delete(fileID); }
    else if (entry.pending.has(fileID)) entry.requestPhase.set(fileID, 'unknown');
    entry.requestVersion++;
    entry.requestErrors.set(fileID, error); notify(entry, { fresh: false, error });
    invalidate(entry);
    trim();
  }
  return {
    snapshot: (route: TaskFileQuery) => get(route).state,
    subscribe(route: TaskFileQuery, listener: () => void) {
      const entry = get(route), wasActive = active(entry);
      entry.listeners.add(listener);
      if (!wasActive) invalidate(entry);
      return () => {
        entry.listeners.delete(listener); entry.touched = now();
        if (!active(entry)) {
          entry.generation++; entry.controller?.abort(); entry.nextAt = Infinity;
          notify(entry, { fresh: false, loading: false });
        }
        trim(); schedule();
      };
    },
    refresh(route: TaskFileQuery) { invalidate(get(route)); },
    revalidate(route: TaskFileQuery) {
      const entry = get(route);
      entry.nextAt = Math.min(entry.nextAt, Math.max(now(), entry.lastReadAt + interval));
      schedule();
    },
    requested: () => requestedRoutes,
    subscribeRequested(listener: () => void) { requestListeners.add(listener); return () => { requestListeners.delete(listener); }; },
    request, requestAccepted, requestFailed,
    async retrieve(route: TaskFileQuery, fileID: string, send: () => Promise<unknown>,
      describeFailure: (cause: unknown) => { message: string; definitive: boolean }) {
      const requestEpoch = epoch;
      const existing = entries.get(taskFileQueryKey(route));
      if (existing?.requestPhase.get(fileID) === 'dispatching') return true;
      if (!request(route, fileID)) return false;
      // The conversation can unmount while the POST is in flight. The shared
      // request still needs its acknowledgement, unless the signed-in user changed.
      try {
        await send();
        if (!disposed && requestEpoch === epoch) requestAccepted(route, fileID);
      } catch (cause) {
        if (!disposed && requestEpoch === epoch) {
          const { message, definitive } = describeFailure(cause);
          requestFailed(route, fileID, message, definitive);
        }
        throw cause;
      }
      return true;
    },
    forgetRequest(route: TaskFileQuery, fileID: string) {
      const entry = get(route); entry.requested.delete(fileID); entry.pending.delete(fileID); entry.requestPhase.delete(fileID); entry.requestErrors.delete(fileID);
      updateRequested(); trim(); schedule();
    },
    setVisible(next: boolean) {
      if (visible === next) return;
      visible = next;
      for (const entry of entries.values()) if (active(entry)) {
        if (!next) { entry.generation++; entry.controller?.abort(); notify(entry, { fresh: false, loading: false }); }
        entry.nextAt = 0;
      }
      schedule();
    },
    reset() {
      epoch++;
      for (const entry of entries.values()) {
        entry.generation++; entry.controller?.abort(); entry.requested.clear(); entry.pending.clear(); entry.requestPhase.clear(); entry.requestVersion++;
        entry.requestErrors.clear(); entry.failures = 0;
        entry.nextAt = entry.listeners.size ? 0 : Infinity;
        notify(entry, { value: null, loading: false, fresh: false, error: null });
      }
      updateRequested(); trim(); schedule();
    },
    epoch: () => epoch,
    stats: () => ({ running, entries: entries.size, requested: requestedRoutes.length, pending: pendingCount() }),
    dispose() {
      disposed = true; if (timer) clearTimeout(timer);
      for (const entry of entries.values()) { entry.generation++; entry.controller?.abort(); }
      entries.clear(); requestListeners.clear(); requestedRoutes = [];
    },
  };
}
