import { createHash } from 'node:crypto';

/** The fixed V1 runtime shares the selected user object with LLM request preparation.
 * Compaction transforms a clone of the history; changing info.system there does not
 * inject execution policy into the summarizer. Verified against the pinned binary. */
export function contextHooks({ url, token, directory }) {
  if (!url || !token) return {};
  const selected = new Map();
  const digest = value => createHash('sha256').update(value).digest('hex');
  async function call(body) {
    const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000), body: JSON.stringify({ ...body, directory }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'context_request_failed');
    return result;
  }
  const identity = info => ({ sessionID: info.sessionID, messageID: info.id, createdAt: info.time.created });
  return {
    'experimental.chat.messages.transform': async (_input, output) => {
      const user = output.messages.findLast(message => message.info.role === 'user');
      if (!user) return;
      const autoContinue = user.parts.some(part => part.type === 'text' && part.synthetic === true && part.metadata?.compaction_continue === true);
      let restored = false;
      if (autoContinue && user.info.system === undefined) {
        const context = await call({ operation: 'restore', ...identity(user.info) });
        if (context) { user.info.system = context.system; restored = true; }
      }
      selected.set(user.info.sessionID, { messageID: user.info.id, restored, selectedMessages: output.messages.length,
        summaryIDs: output.messages.filter(message => message.info.role === 'assistant' && message.info.summary && !message.info.error)
          .map(message => message.info.id).slice(-8) });
      if (selected.size > 256) selected.delete(selected.keys().next().value);
    },
    'chat.params': async (input) => {
      if (['title', 'summary'].includes(input.agent)) return;
      const info = input.message;
      const context = await call({ operation: 'resolve', ...identity(info) });
      const history = selected.get(input.sessionID);
      selected.delete(input.sessionID);
      if (!context) return;
      await call({ operation: 'observe', ...identity(info), contextID: context.id, agent: input.agent,
        model: `${input.model.providerID}/${input.model.id}`,
        systemRevision: typeof info.system === 'string' ? digest(info.system) : null,
        restored: history?.messageID === info.id && history.restored === true,
        ...(history?.messageID === info.id ? { selectedMessages: history.selectedMessages, summaryIDs: history.summaryIDs } : {}) });
    },
    dispose: async () => { selected.clear(); },
  };
}
