import { t } from '../shared/i18n.ts';
import type { LocalKnowledgeEntry } from '../shared/knowledge.ts';
import type { ProjectFileEntry } from '../shared/office-files.ts';
import { sensitiveProjectChangePath, validProjectChangePath } from '../shared/project-changes.ts';
import { quotedMessageText, splitQuotedMessage, type MessageQuote } from './message-quote.ts';

export const composerReferenceLimit = 8;

export type ComposerFileReference = {
  id: string;
  kind: 'file';
  projectID: string;
  projectName: string;
  path: string;
};

export type ComposerKnowledgeReference = {
  id: string;
  kind: 'skill' | 'memory';
  entryID: string;
  nodeID: string;
  revision: string;
  name: string;
  category: string;
  description: string;
};

export type ComposerReference = ComposerFileReference | ComposerKnowledgeReference;

export type ActiveAtTrigger = {
  start: number;
  end: number;
  query: string;
  locked: boolean;
};

export type ActiveKnowledgeTrigger = {
  start: number;
  end: number;
  query: string;
};

export type AtScope = 'devices' | 'files';

function insideCodeSpan(prefix: string): boolean {
  if ((prefix.match(/```/g)?.length || 0) % 2 === 1) return true;
  const line = prefix.split('\n').at(-1) || '';
  return (line.match(/`/g)?.length || 0) % 2 === 1;
}

/**
 * Detect an active `@file` token ending at `cursor`.
 * Requires `@` at line start or after whitespace, ignores `@@` (locked node route),
 * code spans, emails, URLs, and path-traversal segments (`..`).
 */
export function activeFileMention(text: string, cursor: number): ActiveAtTrigger | null {
  if (cursor < 1 || cursor > text.length) return null;
  const prefix = text.slice(0, cursor);
  if (insideCodeSpan(prefix)) return null;
  const match = prefix.match(/(?:^|\s)(@)([^\s@]*)$/u);
  if (!match) return null;
  const query = match[2];
  if (query.startsWith('@')) return null;
  if (/^[a-z]+:\/\//i.test(query) || query.includes('://')) return null;
  if (query.split(/[\\/]/).some((segment) => segment === '..')) return null;
  const start = cursor - query.length - 1;
  if (start > 0 && !/\s/.test(text[start - 1])) return null;
  return { start, end: cursor, query, locked: false };
}

/**
 * Detect an active `#` Wiki/Skill trigger ending at `cursor`.
 * Requires a single `#` at start of text or after whitespace; ignores Markdown headings
 * (`##`, `# `), code spans, URLs (`https://host#frag`), and file anchors (`doc.md#sec`).
 */
export function activeKnowledgeTrigger(text: string, cursor: number): ActiveKnowledgeTrigger | null {
  if (cursor < 1 || cursor > text.length) return null;
  const prefix = text.slice(0, cursor);
  if (insideCodeSpan(prefix)) return null;
  const match = prefix.match(/(?:^|\s)(#)([^#\s]*)$/u);
  if (!match) return null;
  const query = match[2];
  if (query.includes('://')) return null;
  const start = cursor - query.length - 1;
  if (start > 0 && !/\s/.test(text[start - 1])) return null;
  return { start, end: cursor, query };
}

/** Remove an active `@query` or `#query` slice cleanly when attaching a reference chip. */
export function removeTriggerToken(
  text: string,
  trigger: { start: number; end: number },
): { text: string; cursor: number } {
  const head = text.slice(0, trigger.start);
  const tail = text.slice(trigger.end);
  const cleanedHead = head.endsWith(' ') && tail.startsWith(' ') ? head.slice(0, -1) : head;
  const next = `${cleanedHead}${tail}`;
  return { text: next, cursor: Math.min(cleanedHead.length, next.length) };
}

/** Replace the active `@query` slice when drilling into a workspace subfolder (`@src/`). */
export function replaceTriggerQuery(
  text: string,
  trigger: { start: number; end: number },
  symbol: '@' | '#',
  nextQuery: string,
): { text: string; cursor: number } {
  const head = text.slice(0, trigger.start);
  const tail = text.slice(trigger.end);
  const inserted = `${symbol}${nextQuery}`;
  return { text: `${head}${inserted}${tail}`, cursor: head.length + inserted.length };
}

/**
 * Plan safe `/api/projects/:id/files` parameters from a user `@` file query.
 * Preserves server boundary validation and avoids sending traversal segments.
 */
export function planProjectFileQuery(rawQuery: string): { path: string; search: string } {
  const normalized = rawQuery.replaceAll('\\', '/').replace(/^\/+/, '').trim();
  if (!normalized) return { path: '', search: '' };
  if (normalized.endsWith('/')) {
    const dir = normalized.replace(/\/+$/, '');
    return validProjectChangePath(dir) ? { path: dir, search: '' } : { path: '', search: '' };
  }
  const slashIndex = normalized.lastIndexOf('/');
  if (slashIndex > 0) {
    const dir = normalized.slice(0, slashIndex);
    const leaf = normalized.slice(slashIndex + 1);
    if (validProjectChangePath(dir)) {
      return { path: dir, search: leaf.slice(0, 100) };
    }
    return { path: '', search: leaf.slice(0, 100) };
  }
  return { path: '', search: normalized.slice(0, 100) };
}

/**
 * Normalize and fuzzy-score a query against candidate text.
 * Lower score is better; returns null if not matched.
 */
export function fuzzyMatchScore(rawQuery: string, rawTarget: string): number | null {
  const query = rawQuery.trim().normalize('NFKC').toLowerCase();
  if (!query) return 0;
  const target = rawTarget.normalize('NFKC').toLowerCase();
  if (!target) return null;
  if (target === query) return 0;
  if (target.startsWith(query)) return 10 + (target.length - query.length) * 0.01;

  const segments = target.split(/[/_.\-\s]+/);
  for (let i = 0; i < segments.length; i++) {
    if (segments[i]?.startsWith(query)) return 20 + i + target.length * 0.01;
  }

  const index = target.indexOf(query);
  if (index >= 0) return 40 + index * 0.1 + target.length * 0.01;

  // Ordered subsequence match with gap penalty
  let qi = 0;
  let gaps = 0;
  let lastMatch = -1;
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) {
      if (lastMatch >= 0 && ti > lastMatch + 1) gaps += ti - lastMatch - 1;
      lastMatch = ti;
      qi++;
    }
  }
  if (qi < query.length) return null;
  return 80 + gaps * 0.5 + target.length * 0.01;
}

const hiddenDirectoryPattern = /^(?:\.git|node_modules|\.data|\.codex|\.agents|\.rivloom-knowledge)$/i;

export function filterProjectFileEntries(
  entries: readonly ProjectFileEntry[],
  rawQuery: string,
  limit = 10,
): ProjectFileEntry[] {
  const query = rawQuery.replaceAll('\\', '/').replace(/^\/+/, '').trim();
  const safeEntries = entries.filter(
    (entry) =>
      validProjectChangePath(entry.path) &&
      !sensitiveProjectChangePath(entry.path) &&
      !entry.path.split('/').some((part) => hiddenDirectoryPattern.test(part)),
  );
  if (!query || query.endsWith('/')) {
    return safeEntries
      .slice()
      .sort((a, b) => Number(a.directory) - Number(b.directory) || a.path.localeCompare(b.path))
      .slice(0, limit);
  }
  const leafQuery = query.includes('/') ? query.slice(query.lastIndexOf('/') + 1) : query;
  const scored: { entry: ProjectFileEntry; score: number }[] = [];
  for (const entry of safeEntries) {
    const nameScore = leafQuery ? fuzzyMatchScore(leafQuery, entry.name) : null;
    const pathScore = fuzzyMatchScore(query, entry.path);
    const best =
      nameScore !== null && pathScore !== null
        ? Math.min(nameScore, pathScore)
        : (nameScore ?? pathScore);
    if (best === null) continue;
    // Prefer files over folders during active search so Enter picks a referenceable file quickly.
    scored.push({ entry, score: best + (entry.directory ? 18 : 0) });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.entry.path.localeCompare(b.entry.path))
    .slice(0, limit)
    .map((item) => item.entry);
}

export function filterKnowledgeEntries(
  entries: readonly LocalKnowledgeEntry[],
  rawQuery: string,
  options: { projectID?: string | null; kind?: 'all' | 'memory' | 'skill'; limit?: number } = {},
): LocalKnowledgeEntry[] {
  const kind = options.kind || 'all';
  const limit = options.limit ?? 10;
  const projectID = options.projectID || null;
  const query = rawQuery.trim();
  const eligible = entries.filter((entry) => {
    if (entry.withdrawnAt || entry.error) return false;
    if (kind !== 'all' && entry.kind !== kind) return false;
    if (projectID && entry.projectID && entry.projectID !== projectID) return false;
    return true;
  });

  const scored: { entry: LocalKnowledgeEntry; score: number }[] = [];
  for (const entry of eligible) {
    const projectBonus = projectID && entry.projectID === projectID ? -3 : 0;
    if (!query) {
      scored.push({ entry, score: projectBonus });
      continue;
    }
    const nameScore = fuzzyMatchScore(query, entry.name);
    const categoryScore = fuzzyMatchScore(query, entry.category);
    const descScore = entry.description ? fuzzyMatchScore(query, entry.description) : null;
    const candidates = [
      nameScore,
      categoryScore !== null ? categoryScore + 12 : null,
      descScore !== null ? descScore + 28 : null,
    ].filter((value): value is number => value !== null);
    if (!candidates.length) continue;
    scored.push({ entry, score: Math.min(...candidates) + projectBonus });
  }
  return scored
    .sort(
      (a, b) =>
        a.score - b.score ||
        Date.parse(b.entry.updatedAt) - Date.parse(a.entry.updatedAt) ||
        a.entry.name.localeCompare(b.entry.name, 'zh-CN'),
    )
    .slice(0, limit)
    .map((item) => item.entry);
}

/** Decide whether a single `@` popover should display Devices or Workspace Files. */
export function resolveAtScope(
  manualScope: AtScope | null,
  options: {
    locked: boolean;
    canDevices: boolean;
    canFiles: boolean;
    query: string;
    peerCount: number;
    matchingDeviceCount: number;
  },
): AtScope | null {
  if (options.locked) return options.canDevices ? 'devices' : null;
  if (!options.canDevices && !options.canFiles) return null;
  if (!options.canDevices) return 'files';
  if (!options.canFiles) return 'devices';
  if (manualScope) return manualScope;
  if (options.peerCount === 0) return 'files';
  if (options.query && (/[/.\\]/.test(options.query) || options.matchingDeviceCount === 0)) {
    return 'files';
  }
  return 'devices';
}

export function fileReferenceFromEntry(
  projectID: string,
  projectName: string,
  path: string,
): ComposerFileReference {
  return {
    id: `file:${projectID}:${path}`,
    kind: 'file',
    projectID,
    projectName,
    path,
  };
}

export function knowledgeReferenceFromEntry(entry: LocalKnowledgeEntry): ComposerKnowledgeReference {
  return {
    id: `knowledge:${entry.kind}:${entry.id}`,
    kind: entry.kind,
    entryID: entry.id,
    nodeID: entry.nodeID,
    revision: entry.revision,
    name: entry.name,
    category: entry.category,
    description: entry.description.slice(0, 160),
  };
}

export function addComposerReference(
  list: readonly ComposerReference[] | undefined,
  reference: ComposerReference,
): { references: ComposerReference[]; added: boolean; reason?: 'duplicate' | 'limit' } {
  const existing = list || [];
  if (existing.some((item) => item.id === reference.id)) {
    return { references: [...existing], added: false, reason: 'duplicate' };
  }
  if (existing.length >= composerReferenceLimit) {
    return { references: [...existing], added: false, reason: 'limit' };
  }
  return { references: [...existing, reference], added: true };
}

export function removeComposerReference(
  list: readonly ComposerReference[] | undefined,
  id: string,
): ComposerReference[] {
  return (list || []).filter((item) => item.id !== id);
}

export function validComposerReference(value: unknown): value is ComposerReference {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || !item.id || item.id.length > 2100) return false;
  if (item.kind === 'file') {
    return (
      typeof item.projectID === 'string' &&
      item.projectID.length > 0 &&
      item.projectID.length <= 120 &&
      typeof item.projectName === 'string' &&
      item.projectName.length <= 120 &&
      typeof item.path === 'string' &&
      validProjectChangePath(item.path) &&
      !sensitiveProjectChangePath(item.path)
    );
  }
  if (item.kind === 'skill' || item.kind === 'memory') {
    return (
      typeof item.entryID === 'string' &&
      item.entryID.length > 0 &&
      item.entryID.length <= 120 &&
      typeof item.nodeID === 'string' &&
      item.nodeID.length > 0 &&
      item.nodeID.length <= 120 &&
      typeof item.revision === 'string' &&
      /^[a-f0-9]{12,64}$/.test(item.revision) &&
      typeof item.name === 'string' &&
      item.name.trim().length > 0 &&
      item.name.length <= 120 &&
      typeof item.category === 'string' &&
      item.category.length <= 240 &&
      typeof item.description === 'string' &&
      item.description.length <= 600
    );
  }
  return false;
}

const contextHeader = '[Rivloom Context References]';

function sanitizeInline(value: string, maxLength: number): string {
  return value.replace(/[\r\n]+/g, ' ').trim().slice(0, maxLength);
}

/**
 * Progressive-disclosure serialization: includes ONLY file paths or knowledge
 * summary metadata + id + revision prefix, never full file or knowledge bodies.
 */
export function formatComposerReferencesBlock(references: readonly ComposerReference[] | undefined): string {
  if (!references?.length) return '';
  const lines = references.map((ref) => {
    if (ref.kind === 'file') {
      return `- @file ${sanitizeInline(ref.path, 500)}`;
    }
    const prefix = ref.kind === 'skill' ? '#skill' : '#memory';
    const desc = sanitizeInline(ref.description, 140);
    const meta = `category: ${sanitizeInline(ref.category, 120)}, id: ${ref.entryID}, rev: ${ref.revision.slice(0, 12)}`;
    return `- ${prefix} ${sanitizeInline(ref.name, 120)} (${meta})${desc ? ` — ${desc}` : ''}`;
  });
  return `${contextHeader}\n${lines.join('\n')}`;
}

export function composeMessageWithContext(
  text: string,
  quote?: MessageQuote | null,
  references?: readonly ComposerReference[] | null,
): string {
  const block = formatComposerReferencesBlock(references || undefined);
  const body = block ? `${block}\n\n${text}` : text;
  return quotedMessageText(body, quote);
}

export type ParsedContextBadge = {
  kind: 'file' | 'skill' | 'memory';
  label: string;
  detail: string;
};

/** Parse progressive context reference header from a sent user message for compact transcript display. */
export function splitContextMessage(rawText: string): {
  quote?: MessageQuote;
  badges: ParsedContextBadge[];
  text: string;
} {
  const { quote, text: afterQuote } = splitQuotedMessage(rawText);
  if (!afterQuote.startsWith(`${contextHeader}\n`)) {
    return { quote, badges: [], text: afterQuote };
  }
  const separator = afterQuote.indexOf('\n\n');
  if (separator < 0) return { quote, badges: [], text: afterQuote };
  const headerLines = afterQuote.slice(contextHeader.length + 1, separator).split('\n');
  const badges: ParsedContextBadge[] = [];
  for (const line of headerLines) {
    const fileMatch = /^- @file (.+)$/.exec(line);
    if (fileMatch) {
      badges.push({ kind: 'file', label: fileMatch[1], detail: t('工作区文件') });
      continue;
    }
    const knowledgeMatch = /^- #(skill|memory) (.+?) \(([^)]+)\)(?: — (.*))?$/.exec(line);
    if (knowledgeMatch) {
      badges.push({
        kind: knowledgeMatch[1] as 'skill' | 'memory',
        label: knowledgeMatch[2],
        detail: knowledgeMatch[4] || knowledgeMatch[3],
      });
    }
  }
  if (!badges.length) return { quote, badges: [], text: afterQuote };
  return { quote, badges, text: afterQuote.slice(separator + 2) };
}
