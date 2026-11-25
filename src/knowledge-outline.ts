import type { LocalKnowledgeEntry } from '../shared/knowledge.ts';

export type KnowledgeScopeFilter = 'all' | 'private' | 'shared' | 'skill' | 'memory';

export type KnowledgeOutlineEntry = {
  id: string;
  nodeID: string;
  kind: 'skill' | 'memory';
  name: string;
  description: string;
  category: string;
  revision: string;
  updatedAt: string;
  brainID: string | null;
  nodeName: string;
  projectID?: string | null;
  sharedBrains?: string[];
  source?: string;
  error?: string | null;
  origin?: string;
  provenance?: LocalKnowledgeEntry['provenance'];
  withdrawnAt?: string;
};

export type KnowledgeLibrarySummary = {
  total: number;
  privateCount: number;
  sharedCount: number;
  skillCount: number;
  memoryCount: number;
  withdrawnCount: number;
  errorCount: number;
};

export type KnowledgeTreeNode = {
  path: string;
  label: string;
  depth: number;
  count: number;
  sharedCount: number;
  skillCount: number;
  memoryCount: number;
  children: KnowledgeTreeNode[];
};

export type FlatKnowledgeTreeRow = KnowledgeTreeNode & {
  hasChildren: boolean;
  expanded: boolean;
};

export function summarizeLocalKnowledge(entries: readonly LocalKnowledgeEntry[]): KnowledgeLibrarySummary {
  let privateCount = 0;
  let sharedCount = 0;
  let skillCount = 0;
  let memoryCount = 0;
  let withdrawnCount = 0;
  let errorCount = 0;

  for (const entry of entries) {
    if (entry.sharedBrains.length > 0) sharedCount++;
    else privateCount++;
    if (entry.kind === 'skill') skillCount++;
    else memoryCount++;
    if (entry.withdrawnAt) withdrawnCount++;
    if (entry.error) errorCount++;
  }

  return {
    total: entries.length,
    privateCount,
    sharedCount,
    skillCount,
    memoryCount,
    withdrawnCount,
    errorCount,
  };
}

export function matchesKnowledgeScopeFilter(
  entry: KnowledgeOutlineEntry,
  filter: KnowledgeScopeFilter,
  localScope: boolean,
) {
  if (filter === 'all') return true;
  if (filter === 'skill') return entry.kind === 'skill';
  if (filter === 'memory') return entry.kind === 'memory';
  if (!localScope) return true;
  const shared = (entry.sharedBrains?.length || 0) > 0;
  return filter === 'shared' ? shared : !shared;
}

export function filterKnowledgeEntries<T extends KnowledgeOutlineEntry>(
  entries: readonly T[],
  options: {
    filter: KnowledgeScopeFilter;
    brainFilter?: string;
    category: string;
    query: string;
    localScope: boolean;
  },
): T[] {
  const needle = options.query.trim().toLocaleLowerCase();
  return entries.filter((entry) => {
    if (!matchesKnowledgeScopeFilter(entry, options.filter, options.localScope)) return false;
    if (options.localScope && options.brainFilter && !(entry.sharedBrains || []).includes(options.brainFilter)) {
      return false;
    }
    if (options.category && entry.category !== options.category && !entry.category.startsWith(`${options.category}/`)) {
      return false;
    }
    if (!needle) return true;
    const haystack = `${entry.name}\n${entry.description}\n${entry.category}\n${entry.nodeName}`.toLocaleLowerCase();
    return haystack.includes(needle);
  });
}

export function buildKnowledgeCategoryTree(entries: readonly KnowledgeOutlineEntry[]): KnowledgeTreeNode[] {
  type MutableNode = KnowledgeTreeNode & { map: Map<string, MutableNode> };
  const roots = new Map<string, MutableNode>();

  for (const entry of entries) {
    const parts = entry.category
      .split('/')
      .map((part) => part.trim())
      .filter(Boolean);
    if (!parts.length) continue;
    const isShared = entry.brainID !== null || (entry.sharedBrains?.length || 0) > 0;
    let level = roots;
    let path = '';
    for (let index = 0; index < parts.length; index++) {
      const label = parts[index];
      path = path ? `${path}/${label}` : label;
      let node = level.get(label);
      if (!node) {
        node = {
          path,
          label,
          depth: index,
          count: 0,
          sharedCount: 0,
          skillCount: 0,
          memoryCount: 0,
          children: [],
          map: new Map(),
        };
        level.set(label, node);
      }
      node.count++;
      if (isShared) node.sharedCount++;
      if (entry.kind === 'skill') node.skillCount++;
      else node.memoryCount++;
      level = node.map;
    }
  }

  const finalize = (map: Map<string, MutableNode>): KnowledgeTreeNode[] =>
    [...map.values()]
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((node) => ({
        path: node.path,
        label: node.label,
        depth: node.depth,
        count: node.count,
        sharedCount: node.sharedCount,
        skillCount: node.skillCount,
        memoryCount: node.memoryCount,
        children: finalize(node.map),
      }));

  return finalize(roots);
}

export function flattenKnowledgeTree(
  nodes: readonly KnowledgeTreeNode[],
  collapsed: ReadonlySet<string>,
): FlatKnowledgeTreeRow[] {
  const rows: FlatKnowledgeTreeRow[] = [];
  const visit = (list: readonly KnowledgeTreeNode[]) => {
    for (const node of list) {
      const hasChildren = node.children.length > 0;
      const expanded = !collapsed.has(node.path);
      rows.push({ ...node, hasChildren, expanded });
      if (hasChildren && expanded) visit(node.children);
    }
  };
  visit(nodes);
  return rows;
}
