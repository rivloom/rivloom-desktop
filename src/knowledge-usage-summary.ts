import type { KnowledgeUsage } from '../shared/knowledge.ts';

export type KnowledgeUsageFileSummary = {
  file: string;
  operations: ('read' | 'materialize')[];
  readCount: number;
  materializeCount: number;
  totalBytes: number;
  totalCharacters: number | null;
  coveredEnd: number;
  complete: boolean;
  lastAt: string;
};

export type KnowledgeUsageItemSummary = {
  key: string;
  id: string;
  kind: 'skill' | 'memory';
  name: string;
  description?: string;
  category?: string;
  sourceNodeID: string;
  brainID: string | null;
  revision: string;
  readsCount: number;
  totalBytes: number;
  lastAt: string;
  files: KnowledgeUsageFileSummary[];
};

export type KnowledgeUsageDigest = {
  items: KnowledgeUsageItemSummary[];
  wikiCount: number;
  skillCount: number;
  totalReads: number;
};

type FileAccumulator = {
  file: string;
  readCount: number;
  materializeCount: number;
  totalBytes: number;
  totalCharacters: number | null;
  ranges: { offset: number; end: number }[];
  lastAt: string;
};

type ItemAccumulator = {
  key: string;
  id: string;
  kind: 'skill' | 'memory';
  name: string;
  description?: string;
  category?: string;
  sourceNodeID: string;
  brainID: string | null;
  revision: string;
  readsCount: number;
  totalBytes: number;
  lastAt: string;
  files: Map<string, FileAccumulator>;
};

function contiguousCoverage(ranges: readonly { offset: number; end: number }[]) {
  const sorted = [...ranges].sort((a, b) => a.offset - b.offset);
  let end = 0;
  for (const range of sorted) {
    if (range.offset > end) break;
    end = Math.max(end, range.end);
  }
  return end;
}

export function summarizeKnowledgeUsage(entries: readonly KnowledgeUsage[]): KnowledgeUsageDigest {
  const byEntry = new Map<string, ItemAccumulator>();

  for (const entry of entries) {
    const key = `${entry.reference.brainID ?? 'local'}:${entry.reference.nodeID}:${entry.reference.id}:${entry.revision}`;
    let group = byEntry.get(key);
    if (!group) {
      group = {
        key,
        id: entry.reference.id,
        kind: entry.kind,
        name: entry.name,
        description: entry.description,
        category: entry.category,
        sourceNodeID: entry.reference.nodeID,
        brainID: entry.reference.brainID,
        revision: entry.revision,
        readsCount: 0,
        totalBytes: 0,
        lastAt: entry.at,
        files: new Map(),
      };
      byEntry.set(key, group);
    }
    group.readsCount++;
    group.totalBytes += entry.contentBytes;
    if (!group.description && entry.description) group.description = entry.description;
    if (!group.category && entry.category) group.category = entry.category;
    if (entry.at > group.lastAt) group.lastAt = entry.at;

    let file = group.files.get(entry.file);
    if (!file) {
      file = {
        file: entry.file,
        readCount: 0,
        materializeCount: 0,
        totalBytes: 0,
        totalCharacters: entry.totalCharacters,
        ranges: [],
        lastAt: entry.at,
      };
      group.files.set(entry.file, file);
    }
    if (entry.operation === 'materialize') file.materializeCount++;
    else file.readCount++;
    file.totalBytes += entry.contentBytes;
    if (file.totalCharacters === null && entry.totalCharacters !== null) {
      file.totalCharacters = entry.totalCharacters;
    }
    if (entry.totalCharacters !== null) {
      file.ranges.push({ offset: entry.offset, end: entry.nextOffset ?? entry.totalCharacters });
    }
    if (entry.at > file.lastAt) file.lastAt = entry.at;
  }

  const items: KnowledgeUsageItemSummary[] = [...byEntry.values()]
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt) || a.name.localeCompare(b.name))
    .map((group) => ({
      key: group.key,
      id: group.id,
      kind: group.kind,
      name: group.name,
      ...(group.description ? { description: group.description } : {}),
      ...(group.category ? { category: group.category } : {}),
      sourceNodeID: group.sourceNodeID,
      brainID: group.brainID,
      revision: group.revision,
      readsCount: group.readsCount,
      totalBytes: group.totalBytes,
      lastAt: group.lastAt,
      files: [...group.files.values()]
        .sort((a, b) => a.file.localeCompare(b.file))
        .map((file) => {
          const coveredEnd = contiguousCoverage(file.ranges);
          const operations: ('read' | 'materialize')[] = [];
          if (file.readCount > 0) operations.push('read');
          if (file.materializeCount > 0) operations.push('materialize');
          return {
            file: file.file,
            operations,
            readCount: file.readCount,
            materializeCount: file.materializeCount,
            totalBytes: file.totalBytes,
            totalCharacters: file.totalCharacters,
            coveredEnd,
            complete: file.totalCharacters !== null && coveredEnd >= file.totalCharacters,
            lastAt: file.lastAt,
          };
        }),
    }));

  const wikiCount = items.filter((item) => item.kind === 'memory').length;
  const skillCount = items.filter((item) => item.kind === 'skill').length;
  return { items, wikiCount, skillCount, totalReads: entries.length };
}
