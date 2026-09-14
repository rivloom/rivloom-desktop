import type { Conversation } from '../shared/conversations.ts';
import type { Workflow, WorkflowAttempt, WorkflowStep } from '../shared/workflows.ts';
import { workflowPendingMessages } from '../shared/workflows.ts';
import { workflowResults } from './workflow-results.ts';
import { executionSummaryText } from './system-display.ts';

export type SearchTarget = {
  kind: 'requirement' | 'response' | 'plan' | 'step' | 'queued' | 'message' | 'summary' | 'title' | 'device' | 'directory';
  roundID?: string; stepID?: string; attempt?: number; messageID?: string;
};
export type SearchSegment = { id: string; text: string; target: SearchTarget; round?: number };
export type SearchMatch = SearchSegment & { start: number; end: number };
export type ConversationSearchIndex = { item: Conversation; segments: SearchSegment[] };

/** JSON components avoid collisions without interpolating untrusted IDs into selectors. */
export function searchTargetID(target: SearchTarget): string {
  return JSON.stringify([target.kind, target.roundID || '', target.stepID || '', target.attempt || 0, target.messageID || '']);
}

export function workflowAttemptResponse(step: WorkflowStep, attempt: WorkflowAttempt): string {
  const outcome = attempt.outcome;
  if (outcome?.kind === 'completed') return outcome.summary;
  if (outcome && 'checkpoint' in outcome) return outcome.checkpoint;
  return attempt === step.attempts.at(-1) ? step.checkpoint : attempt.summary;
}

/** Only user-visible messages/results, never workflow context, tools or engine prompts. */
export function conversationSearchSegments(item: Conversation): SearchSegment[] {
  const segments: SearchSegment[] = [];
  const add = (text: string | undefined, target: SearchTarget, round?: number) => {
    if (text?.trim()) segments.push({ id: searchTargetID(target), text, target, ...(round ? { round } : {}) });
  };
  add(item.title, { kind: 'title' });
  if (item.workflow) {
    const workflow = item.workflow;
    const rounds = [...(workflow.rounds || []).map((round) => ({ ...workflow, ...round, roundRequestID: round.requestID })), workflow];
    rounds.forEach((value, i) => {
      const roundID = value.roundRequestID || value.requestID, round = i + 1;
      add(value.description, { kind: 'requirement', roundID }, round);
      const results = workflowResults(value as Workflow);
      for (const { step, attempt, summary } of results)
        add(summary, { kind: 'response', roundID, stepID: step.id, attempt: attempt.number }, round);
      add(value.summary, { kind: 'plan', roundID }, round);
      for (const step of value.steps) for (const attempt of step.attempts) {
        if (results.some((result) => result.step === step && result.attempt === attempt)) continue;
        add(workflowAttemptResponse(step, attempt), { kind: 'step', roundID, stepID: step.id, attempt: attempt.number }, round);
      }
    });
    for (const message of workflowPendingMessages(workflow)) add(message.text, { kind: 'queued', messageID: message.requestID });
  } else {
    add(item.description, { kind: 'requirement' });
    for (const message of item.localTask?.messages || [])
      if (message.role === 'assistant') add(message.text, { kind: 'message', messageID: message.id });
    if (!item.localTask) add(executionSummaryText(item.brainTask?.executionSummary || item.remote?.executionSummary,
      item.brainTask?.status || item.remote?.executionState), { kind: 'summary' });
  }
  return segments;
}

export function indexConversations(
  items: readonly Conversation[],
  metadata: (item: Conversation) => { device: string; directory: string },
): ConversationSearchIndex[] {
  return items.map((item) => {
    const { device, directory } = metadata(item);
    const segments = conversationSearchSegments(item);
    for (const [kind, text] of [['device', device], ['directory', directory]] as const)
      if (text) segments.push({ id: searchTargetID({ kind }), text, target: { kind } });
    return { item, segments };
  });
}

export function literalSearchPattern(query: string): RegExp | null {
  const value = query.trim();
  return value ? new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu') : null;
}

/** One result per matching segment, in conversation order. No cross-message matches. */
export function searchConversations(index: readonly ConversationSearchIndex[], query: string): Map<string, SearchMatch[]> {
  const pattern = literalSearchPattern(query), found = new Map<string, SearchMatch[]>();
  if (!pattern) return found;
  for (const { item, segments } of index) {
    const matches: SearchMatch[] = [];
    for (const segment of segments) {
      pattern.lastIndex = 0;
      const match = pattern.exec(segment.text);
      if (match) matches.push({ ...segment, start: match.index, end: match.index + match[0].length });
    }
    if (matches.length) found.set(item.key, matches);
  }
  return found;
}

export function contentSearchMatch(matches: readonly SearchMatch[]): SearchMatch | undefined {
  return matches.find((match) => !['title', 'device', 'directory'].includes(match.target.kind)) || matches[0];
}

export function searchExcerpt(match: SearchMatch, context = 42): string {
  // Avoid slicing a surrogate pair at either edge of the preview.
  let start = Math.max(0, match.start - context), end = Math.min(match.text.length, match.end + context);
  if (start && /[\uDC00-\uDFFF]/.test(match.text[start])) start--;
  if (end < match.text.length && /[\uDC00-\uDFFF]/.test(match.text[end])) end++;
  return `${start ? '…' : ''}${match.text.slice(start, end).replace(/\s+/g, ' ')}${end < match.text.length ? '…' : ''}`;
}

export function searchTextParts(text: string, query: string): { text: string; match: boolean }[] {
  const pattern = literalSearchPattern(query);
  if (!pattern) return [{ text, match: false }];
  const parts: { text: string; match: boolean }[] = [];
  let cursor = 0;
  for (const found of text.matchAll(pattern)) {
    if (found.index > cursor) parts.push({ text: text.slice(cursor, found.index), match: false });
    parts.push({ text: found[0], match: true }); cursor = found.index + found[0].length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
  return parts;
}
