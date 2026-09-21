import { activeStates, type Message, type Task } from './types.ts';

export type TaskStreamUpdate = { taskID: string; sessionID: string; runAfter: number; message: Message };

/** Snapshot replacement, never concatenation: duplicate events and overlapping polls are harmless. */
export function applyTaskStream(task: Task, update: TaskStreamUpdate): Task {
  if (task.id !== update.taskID || task.sessionID !== update.sessionID || task.runAfter !== update.runAfter || !activeStates.includes(task.state)) return task;
  const index = task.messages.findIndex(message => message.id === update.message.id);
  const previous = task.messages[index];
  if (previous && (previous.streamVersion || 0) >= (update.message.streamVersion || 0)) return task;
  const messages = [...task.messages];
  if (index < 0) messages.push(update.message); else messages[index] = update.message;
  return { ...task, messages };
}

/** An HTTP request in flight may have read a snapshot older than the last SSE frame. */
export function reconcileTaskStream(previous: Task, incoming: Task): Task {
  if (previous.sessionID !== incoming.sessionID || previous.runAfter !== incoming.runAfter) return incoming;
  return previous.messages.reduce((value, message) => message.streamVersion ? applyTaskStream(value,
    { taskID: previous.id, sessionID: previous.sessionID!, runAfter: previous.runAfter, message }) : value, incoming);
}
