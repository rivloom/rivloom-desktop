import { currentTodoRevision, normalizeTodos, sessionUsage, type TaskTelemetry } from '../shared/task-telemetry.ts';
import type { TaskState } from '../shared/types.ts';
import { sanitize } from './artifacts.ts';

/** Reads supplement the existing session poll, and never affect its execution state. */
export async function readTaskTelemetry(input: {
  sessionID: string;
  runAfter: number;
  state: TaskState;
  messages: unknown;
  previous?: TaskTelemetry;
  readTodos: () => Promise<unknown>;
  now?: number;
}): Promise<TaskTelemetry> {
  const now = input.now ?? Date.now();
  const result: TaskTelemetry = {
    source: 'opencode', sessionID: input.sessionID, runAfter: input.runAfter,
    usage: sessionUsage(input.messages),
    todos: { state: 'not_reported', items: [], revision: null, truncated: false },
  };
  if (!['running', 'waiting_approval', 'waiting_input', 'accepted', 'review'].includes(input.state)) {
    result.todos.state = 'inactive';
    return result;
  }
  const revision = currentTodoRevision(input.messages, input.runAfter);
  if (!revision) return result;
  const previous = input.previous;
  if (previous?.sessionID === input.sessionID && previous.runAfter === input.runAfter &&
    previous.todos.revision === revision && (previous.todos.state === 'available' ||
      previous.todos.state === 'unavailable' && (previous.todos.retryAt || 0) > now)) {
    // A failed read uses the existing task poll with a cooldown. No extra polling loop.
    result.todos = previous.todos;
    return result;
  }
  result.todos = { state: 'unavailable', items: [], revision, truncated: false, retryAt: now + 15_000 };
  try {
    const todos = normalizeTodos(await input.readTodos());
    if (todos) result.todos = { state: 'available', revision, ...sanitize(todos) };
  } catch { /* Optional progress cannot fail, complete or retry the actual task. */ }
  return result;
}
