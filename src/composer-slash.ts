import type { PromptTemplate } from '../shared/prompt-templates.ts';

export type ActiveSlashCommand = {
  start: number;
  end: number;
  query: string;
};

export type SlashCommandItem = {
  id: string;
  command: string;
  label: string;
  detail: string;
  group: 'builtin' | 'template';
  keywords?: string;
  insertText?: string;
  action?: 'diff' | 'topology' | 'templates' | 'clear-target';
};

/**
 * Detect an active `/` slash command token ending at `cursor`.
 * Requires `/` at start of text or after whitespace, and ignores file paths/URLs
 * containing another `/` or whitespace inside the token.
 */
export function activeSlashCommand(text: string, cursor: number): ActiveSlashCommand | null {
  if (cursor < 1 || cursor > text.length) return null;
  const before = text.slice(0, cursor);
  const match = before.match(/(?:^|\s)(\/[^\s/]*)$/);
  if (!match) return null;
  const token = match[1];
  const start = cursor - token.length;
  if (start > 0 && !/\s/.test(text[start - 1])) return null;
  return { start, end: cursor, query: token.slice(1) };
}

/** Replace the active `/query` slice cleanly and return the updated text + caret position. */
export function applySlashInsertion(
  text: string,
  slash: ActiveSlashCommand,
  replacement: string,
): { text: string; cursor: number } {
  const head = text.slice(0, slash.start);
  const tail = text.slice(slash.end);
  if (!replacement) {
    const compact = `${head.replace(/[ \t]+$/, head.endsWith('\n') ? '' : '')}${tail.replace(/^[ \t]+/, '')}`;
    return { text: compact, cursor: Math.min(slash.start, compact.length) };
  }
  const suffix = tail && !/^\s/.test(tail) ? ' ' : '';
  const next = `${head}${replacement}${suffix}${tail}`;
  return { text: next, cursor: head.length + replacement.length + suffix.length };
}

export function filterSlashItems(
  items: readonly SlashCommandItem[],
  query: string,
): SlashCommandItem[] {
  const q = query.trim().normalize('NFKC').toLowerCase();
  if (!q) return [...items];
  const scored: { item: SlashCommandItem; rank: number; index: number }[] = [];
  items.forEach((item, index) => {
    const cmd = item.command.normalize('NFKC').toLowerCase();
    const label = item.label.normalize('NFKC').toLowerCase();
    const rest = `${item.detail} ${item.keywords || ''}`.normalize('NFKC').toLowerCase();
    if (cmd === `/${q}` || cmd.startsWith(`/${q}`)) scored.push({ item, rank: 0, index });
    else if (label.startsWith(q)) scored.push({ item, rank: 1, index });
    else if (cmd.includes(q) || label.includes(q)) scored.push({ item, rank: 2, index });
    else if (rest.includes(q)) scored.push({ item, rank: 3, index });
  });
  return scored
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.item);
}

export function templateToSlashItem(template: PromptTemplate): SlashCommandItem {
  const firstLine =
    template.text
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) || '';
  return {
    id: `template:${template.id}`,
    command: `/${template.title}`,
    label: template.title,
    detail: firstLine.slice(0, 72),
    group: 'template',
    keywords: template.text.slice(0, 120),
    insertText: template.text,
  };
}
