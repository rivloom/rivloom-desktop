import type { OfficeDocument } from '../shared/office-files.ts';

/** Return offsets in the original UTF-16 text, as required by DOM Range. */
export function officeSearchOffsets(text: string, query: string, limit = 200): { start: number; end: number }[] {
  if (!query || limit <= 0) return [];
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const offsets: { start: number; end: number }[] = [];
  for (const match of text.matchAll(pattern)) {
    offsets.push({ start: match.index, end: match.index + match[0].length });
    if (offsets.length >= limit) break;
  }
  return offsets;
}

/** PDF pages and Word HTML already show their complete visual content. Their
 * extraction offsets only paginate the text returned to tools. */
export function officePreviewHasParts(document: OfficeDocument | null): boolean {
  return !!document && document.kind !== 'pdf' && !(document.kind === 'word' && document.html)
    && ((document.offset || 0) > 0 || document.nextOffset !== undefined);
}
