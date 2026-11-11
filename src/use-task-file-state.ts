import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { api } from './api';
import { createTaskFileState, taskFileQueryKey, type TaskFileQuery, type TaskFileState } from './task-file-state.ts';
export type { TaskFileQuery, TaskFileState } from './task-file-state.ts';

export const taskFileStates = createTaskFileState({
  load: (route, signal) => api(`/task-files/${route.scope}/${route.taskID}`, undefined, { signal }),
});
if (typeof document !== 'undefined') {
  taskFileStates.setVisible(!document.hidden);
  document.addEventListener('visibilitychange', () => taskFileStates.setVisible(!document.hidden));
}
export const refreshTaskFileState = (route: TaskFileQuery) => taskFileStates.refresh(route);
export const resetTaskFileState = () => taskFileStates.reset();
export function useTaskFileRequests() {
  return useSyncExternalStore(taskFileStates.subscribeRequested, taskFileStates.requested);
}

/** revision is an existing task/workflow revision, never an animation tick. */
export function useTaskFileStates(routes: readonly TaskFileQuery[], revision?: unknown): readonly TaskFileState[] {
  const key = JSON.stringify([...new Map(routes.map(route => [taskFileQueryKey(route), route])).values()]);
  const group = useMemo(() => {
    const queries = JSON.parse(key) as TaskFileQuery[];
    let previous: readonly TaskFileState[] = [];
    return {
      queries,
      snapshot() {
        const next = queries.map(route => taskFileStates.snapshot(route));
        if (next.length !== previous.length || next.some((state, i) => state !== previous[i])) previous = next;
        return previous;
      },
      subscribe(listener: () => void) {
        const releases = queries.map(route => taskFileStates.subscribe(route, listener));
        return () => releases.forEach(release => release());
      },
    };
  }, [key]);
  const result = useSyncExternalStore(group.subscribe, group.snapshot);
  const previousRevision = useRef(revision);
  useEffect(() => {
    if (previousRevision.current !== revision) {
      previousRevision.current = revision;
      group.queries.forEach(route => taskFileStates.revalidate(route));
    }
  }, [group, revision]);
  return result;
}
export function useTaskFileState(scope: TaskFileQuery['scope'], taskID: string, revision?: unknown, enabled = true): TaskFileState {
  return useTaskFileStates(enabled ? [{ scope, taskID }] : [], revision)[0] || {
    route: { scope, taskID }, value: null, loading: false, fresh: false, error: null, revision: 0,
  };
}
