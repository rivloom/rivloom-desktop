/** Only values reported by the official engine. Missing values are never estimated. */
export type TaskUsage = {
  scope: 'session';
  assistantMessages: number;
  /** OpenCode's raw cost value; its source may use provider estimates or another billing unit. */
  cost: number | null;
  tokens: {
    input: number | null;
    output: number | null;
    reasoning: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    /** Present only when every assistant message reports an explicit total. */
    total: number | null;
  };
};

export type TaskTodo = {
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled' | 'unknown';
  priority: 'high' | 'medium' | 'low' | 'unknown';
};
export type TaskTodoSnapshot = {
  state: 'available' | 'not_reported' | 'unavailable' | 'inactive';
  items: TaskTodo[];
  /** Last completed todowrite in this run; prevents stale plans crossing runs. */
  revision: string | null;
  truncated: boolean;
  /** Failed optional reads retry on the existing task poll, at most once per 15 seconds. */
  retryAt?: number;
};
export type TaskTelemetry = {
  source: 'opencode';
  sessionID: string;
  runAfter: number;
  usage: TaskUsage | null;
  todos: TaskTodoSnapshot;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function sumReported(values: unknown[], integer = true): number | null {
  if (!values.length || values.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 ||
    (integer && !Number.isSafeInteger(value)))) return null;
  const sum = (values as number[]).reduce((total, value) => total + value, 0);
  return Number.isFinite(sum) && sum <= Number.MAX_SAFE_INTEGER ? sum : null;
}

/** Replace from a session snapshot, never add a polling result to the previous total. */
export function sessionUsage(messages: unknown): TaskUsage | null {
  if (!Array.isArray(messages)) return null;
  const assistants = new Map<string, Record<string, unknown>>();
  for (const message of messages) {
    const info = record(record(message)?.info);
    if (info?.role === 'assistant' && typeof info.id === 'string' && info.id) assistants.set(info.id, info);
  }
  if (!assistants.size) return null;
  const infos = [...assistants.values()];
  const tokens = infos.map(info => record(info.tokens));
  return {
    scope: 'session', assistantMessages: infos.length,
    cost: sumReported(infos.map(info => info.cost), false),
    tokens: {
      input: sumReported(tokens.map(value => value?.input)),
      output: sumReported(tokens.map(value => value?.output)),
      reasoning: sumReported(tokens.map(value => value?.reasoning)),
      cacheRead: sumReported(tokens.map(value => record(value?.cache)?.read)),
      cacheWrite: sumReported(tokens.map(value => record(value?.cache)?.write)),
      total: sumReported(tokens.map(value => value?.total)),
    },
  };
}

/** A session todo list has no timestamp. Read it only after this run actually writes one. */
export function currentTodoRevision(messages: unknown, runAfter: number): string | null {
  if (!Array.isArray(messages) || !Number.isFinite(runAfter) || runAfter <= 0) return null;
  let latest: { ended: number; revision: string } | null = null;
  for (const message of messages) {
    const item = record(message), info = record(item?.info), time = record(info?.time);
    if (info?.role !== 'assistant' || typeof time?.created !== 'number' || time.created < runAfter ||
      typeof info.id !== 'string' || !Array.isArray(item?.parts)) continue;
    for (const part of item.parts) {
      const tool = record(part), state = record(tool?.state), timing = record(state?.time);
      if (tool?.type !== 'tool' || tool.tool !== 'todowrite' || state?.status !== 'completed' ||
        typeof tool.id !== 'string' || typeof timing?.end !== 'number' || !Number.isFinite(timing.end) || timing.end < runAfter) continue;
      const revision = `${info.id}:${tool.id}:${timing.end}`;
      if (!latest || timing.end >= latest.ended) latest = { ended: timing.end, revision };
    }
  }
  return latest?.revision || null;
}

export function normalizeTodos(value: unknown): Pick<TaskTodoSnapshot, 'items' | 'truncated'> | null {
  if (!Array.isArray(value)) return null;
  let truncated = value.length > 200;
  const items: TaskTodo[] = [];
  for (const entry of value.slice(0, 200)) {
    const item = record(entry);
    if (!item || typeof item.content !== 'string' || !item.content.trim() || typeof item.status !== 'string' || typeof item.priority !== 'string') return null;
    truncated ||= item.content.length > 4000;
    items.push({
      content: item.content.slice(0, 4000),
      status: ['pending', 'in_progress', 'completed', 'cancelled'].includes(item.status) ? item.status as TaskTodo['status'] : 'unknown',
      priority: ['high', 'medium', 'low'].includes(item.priority) ? item.priority as TaskTodo['priority'] : 'unknown',
    });
  }
  return { items, truncated };
}

export function inactiveTelemetry(previous: TaskTelemetry | undefined): TaskTelemetry | undefined {
  return previous ? { ...previous, todos: { state: 'inactive', items: [], revision: null, truncated: false } } : undefined;
}
