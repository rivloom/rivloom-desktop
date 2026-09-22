import { z } from 'zod';

export const workflowHistoryCapability = 'workflow-history-v1';
/** UTF-8 bytes of the complete serialized read result, including metadata. */
export const historyReadMaxBytes = 32 * 1024;
export const historyQuerySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('search'), round: z.number().int().min(1).optional(), stepID: z.string().max(48).optional(),
    text: z.string().max(200).optional(), offset: z.number().int().min(0).max(1_000_000).default(0) }).strict(),
  z.object({ action: z.literal('read'), id: z.string().min(1).max(180), revision: z.string().regex(/^[a-f0-9]{64}$/),
    offset: z.number().int().min(0).max(10_000_000).default(0) }).strict(),
  z.object({ action: z.literal('state') }).strict(),
]);
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
export const contextNoteSchema = z.object({ requestID: z.string().uuid(), expectedVersion: z.number().int().min(1),
  kind: z.enum(['constraint', 'decision']), text: z.string().trim().min(1).max(600),
  source: z.object({ id: z.string().min(1).max(180), revision: z.string().regex(/^[a-f0-9]{64}$/),
    quote: z.string().trim().min(1).max(1000) }).strict(), supersedes: z.string().uuid().optional() }).strict();
export type ContextNoteInput = z.infer<typeof contextNoteSchema>;
export type ContextNote = ContextNoteInput & { id: string; version: number; authority: 'user' | 'inferred';
  round: number; createdAt: string; supersededBy: string | null;
  withdrawn?: { requestID: string; expectedVersion: number; at: string } };
export type HistoryRead = { id: string; executionID: string; at: string; sourceID: string; revision: string;
  offset: number; nextOffset: number | null; totalCharacters: number; contentBytes: number };
export const workflowHistoryGuide = `Use rivloom_history to inspect current state or search previous rounds by round, stepID or text. Read only relevant records using their exact id/revision and nextOffset until complete. Search excerpts and handoff previews may be incomplete; never invent omitted details. The latest user request takes precedence over older requests and inferred notes. Use rivloom_context_note during planning to retain source-backed constraints or decisions; these are inferred notes, not user confirmations, permissions or long-term memory. Read state first for expectedVersion and use supersedes for an obsolete inferred note. Never claim unavailable history or remote files were read.`;
