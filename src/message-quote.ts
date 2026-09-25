export type MessageQuote = { text: string; author: 'user' | 'assistant' };

export function validMessageQuote(value: unknown): value is MessageQuote {
  if (!value || typeof value !== 'object') return false;
  const quote = value as MessageQuote;
  return typeof quote.text === 'string' && !!quote.text.trim() && quote.text.length <= 12000 &&
    (quote.author === 'user' || quote.author === 'assistant');
}

/** Keep transport stable across language switches and retries; existing APIs accept plain text. */
export function quotedMessageText(text: string, quote?: MessageQuote | null): string {
  if (!quote) return text;
  return `> [${quote.author === 'assistant' ? 'Rivloom' : 'User'}]\n${quote.text.replace(/\r\n?/g, '\n').split('\n').map(line => `> ${line}`).join('\n')}\n\n${text}`;
}

/** Only the exact reply envelope is rendered as a card; ordinary Markdown remains untouched. */
export function splitQuotedMessage(text: string): { text: string; quote?: MessageQuote } {
  const match = /^(> \[(Rivloom|User)\]\n)((?:> [^\n]*(?:\n|$))+)(?:\n)([\s\S]*)$/.exec(text);
  if (!match) return { text };
  const quoted = match[3].replace(/\n$/, '').split('\n').map(line => line.slice(2)).join('\n');
  const quote: MessageQuote = { text: quoted, author: match[2] === 'Rivloom' ? 'assistant' : 'user' };
  return validMessageQuote(quote) ? { text: match[4], quote } : { text };
}
