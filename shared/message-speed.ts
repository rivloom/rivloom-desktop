import type { Message } from './types.ts';

/** Average throughput for one assistant message, including request and tool wait time.
 * This is deliberately not advertised as the provider's decoder speed. */
export function messageSpeed(message: Message, active: boolean, now = Date.now()): { value: number; estimated: boolean } | null {
  const timing = message.timing;
  if (!timing || !Number.isFinite(timing.created)) return null;
  const complete = typeof timing.completed === 'number' && Number.isFinite(timing.completed);
  if (!complete && !active) return null;
  const seconds = ((complete ? timing.completed! : now) - timing.created) / 1000;
  if (seconds < 0.5 || !Number.isFinite(seconds)) return null;
  let tokens: number;
  if (complete) {
    if (!Number.isSafeInteger(timing.outputTokens) || timing.outputTokens! < 0 || !Number.isSafeInteger(timing.reasoningTokens) || timing.reasoningTokens! < 0) return null;
    tokens = timing.outputTokens! + timing.reasoningTokens!;
  } else {
    const text = message.parts?.map(part => part.type === 'tool' ? part.input : part.text).join('') || message.text;
    // Visible-character heuristic only. The ≈ label must remain until official usage arrives.
    let units = 0;
    for (const character of text) units += /[\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff]/u.test(character) ? 1.5 : 0.25;
    tokens = units;
  }
  const value = tokens / seconds;
  return tokens > 0 && Number.isFinite(value) ? { value, estimated: !complete } : null;
}
