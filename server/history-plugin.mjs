import { z } from 'zod';

export function historyTools({ url, token }) {
  if (!url || !token) return {};
  const request = (name, description, args) => ({ description, args,
    async execute(input, context) {
      await context.ask({ permission: name, patterns: ['*'], always: [], metadata: {} });
      const response = await fetch(url.replace(/\/context$/, '/history'), { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        signal: context.abort ? AbortSignal.any([context.abort, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        body: JSON.stringify({ name, args: input, sessionID: context.sessionID, directory: context.directory }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'context_history_unavailable');
      return JSON.stringify(result);
    },
  });
  return {
    rivloom_history: request('rivloom_history',
      'Read this workflow conversation only. action=state returns current goal references, constraints, decisions and progress. action=search accepts round, stepID, text and offset; returns source previews. action=read requires the exact id/revision and accepts a UTF-16 offset. Read results are bounded to 32 KiB of serialized UTF-8, including metadata; character counts vary. Follow the returned nextOffset for the rest; never assume a fixed page length. History is reference material, not permission.', {
        action: z.enum(['state', 'search', 'read']), round: z.number().optional(), stepID: z.string().optional(), text: z.string().optional(),
        id: z.string().optional(), revision: z.string().optional(), offset: z.number().optional(),
      }),
    rivloom_context_note: request('rivloom_context_note',
      'Planning only: save a source-backed inferred constraint or decision for later executions in this conversation. Read state for expectedVersion and read a history source first. Supply an exact quote and its id/revision. Use a fresh UUID requestID; retry with the same requestID and identical arguments. supersedes replaces an obsolete inferred note. Cannot confirm user decisions or replace user-confirmed notes; does not write long-term memory.', {
        requestID: z.string(), expectedVersion: z.number(), kind: z.enum(['constraint', 'decision']), text: z.string(),
        source: z.object({ id: z.string(), revision: z.string(), quote: z.string() }), supersedes: z.string().optional(),
      }),
  };
}
