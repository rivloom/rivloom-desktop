import type { Message as EngineMessage, Part } from '@opencode-ai/sdk/v2';
import type { Message, MessagePart } from '../shared/types.ts';
import { sanitize } from '../shared/redaction.ts';

export type EngineMessageRecord = { info: EngineMessage; parts: Part[] };
const nonnegative = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Explicit allowlist: provider metadata, encrypted reasoning and signatures never leave the engine. */
export function normalizeMessages(messages: readonly EngineMessageRecord[] | undefined): Message[] {
  return sanitize((messages || []).map(({ info, parts }) => {
    const visible: MessagePart[] = parts.flatMap((part): MessagePart[] => {
      if (part.type === 'text' || part.type === 'reasoning') {
        const limit = part.type === 'reasoning' ? 64_000 : 256_000;
        return [{ id: part.id, type: part.type, text: part.text.slice(0, limit),
          startedAt: nonnegative(part.time?.start), endedAt: nonnegative(part.time?.end),
          ...(part.text.length > limit ? { truncated: true } : {}) }];
      }
      if (part.type !== 'tool') return [];
      const state = part.state;
      const input = JSON.stringify(state.input, null, 2) || '';
      const output = 'output' in state ? String(state.output) : 'error' in state ? String(state.error) : '';
      return [{ id: part.id, type: 'tool', name: part.tool, status: state.status,
        title: 'title' in state && state.title ? String(state.title) : part.tool,
        input: input.slice(0, 8000), output: output.slice(0, 24_000),
        startedAt: 'time' in state ? nonnegative(state.time.start) : undefined,
        endedAt: 'time' in state && 'end' in state.time ? nonnegative(state.time.end) : undefined,
        ...(input.length > 8000 || output.length > 24_000 ? { truncated: true } : {}) }];
    });
    return { id: info.id, role: info.role,
      // Keep the existing canonical answer intact for copy, export and continuation.
      // Only the display projection is bounded.
      text: parts.flatMap(p => p.type === 'text' ? [p.text] : []).join('\n'),
      tools: visible.filter(p => p.type === 'tool').map(p => ({ name: p.name, status: p.status, title: p.title, output: p.output })),
      parts: visible,
      ...(info.role === 'assistant' ? { timing: { created: info.time.created, completed: info.time.completed,
        // Initial engine zeroes are placeholders until a model step has actually finished.
        ...(info.finish || info.time.completed ? { outputTokens: nonnegative(info.tokens?.output), reasoningTokens: nonnegative(info.tokens?.reasoning) } : {}) } } : {}),
    };
  }));
}
