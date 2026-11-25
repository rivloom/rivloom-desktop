import { t } from '../shared/i18n.ts';
import type { ProjectChangeFile, ProjectDiff } from '../shared/project-changes.ts';
import type { TaskFileDescriptor } from '../shared/task-files.ts';
import type { Workflow } from '../shared/workflows.ts';

export type ChangeScopeFilter = 'all' | 'working' | 'staged';

export type DeliverableGroup = {
  key: string;
  roundNumber: number;
  stepTitle: string;
  scope: 'local' | 'remote';
  taskID: string;
  outputFiles: TaskFileDescriptor[];
};

export type DeliverableRoundSummary = {
  roundNumber: number;
  isLatest: boolean;
  label: string;
  promptSnippet: string;
  groups: DeliverableGroup[];
  fileCount: number;
};

/**
 * Group workflow deliverable files by execution round (1-based, latest round first in UI if desired
 * or ordered chronologically with latest clearly tagged) without duplicating attempts.
 */
export function collectWorkflowDeliverableRounds(workflow: Workflow): DeliverableRoundSummary[] {
  const pastRounds = workflow.rounds || [];
  const totalRounds = pastRounds.length + 1;
  const summaries: DeliverableRoundSummary[] = [];
  const seen = new Set<string>();

  const extractSteps = (
    roundNumber: number,
    isLatest: boolean,
    description: string,
    planVersion: number,
    planner: Workflow['planner'],
    steps: Workflow['steps'],
  ) => {
    const sourceSteps = planVersion ? steps : [planner];
    const groups: DeliverableGroup[] = [];
    for (const step of sourceSteps) {
      const attempt = step.attempts.at(-1);
      if (!attempt?.outputFiles.length) continue;
      const key = `${attempt.kind}:${attempt.executionID}`;
      if (seen.has(key)) continue;
      seen.add(key);
      groups.push({
        key,
        roundNumber,
        stepTitle: step.title,
        scope: attempt.kind,
        taskID: attempt.executionID,
        outputFiles: attempt.outputFiles,
      });
    }
    const fileCount = groups.reduce((sum, group) => sum + group.outputFiles.length, 0);
    summaries.push({
      roundNumber,
      isLatest,
      label: isLatest && totalRounds > 1
        ? t('第 {{n}} 轮 · 最新', { n: roundNumber })
        : t('第 {{n}} 轮', { n: roundNumber }),
      promptSnippet: description.trim().split('\n')[0]?.slice(0, 60) || '',
      groups,
      fileCount,
    });
  };

  pastRounds.forEach((round, index) => {
    extractSteps(index + 1, false, round.description, round.planVersion, round.planner, round.steps);
  });
  extractSteps(
    totalRounds,
    true,
    workflow.description,
    workflow.planVersion,
    workflow.planner,
    workflow.steps,
  );
  return summaries;
}

export function isChangeStaged(file: ProjectChangeFile): boolean {
  return !file.untracked && file.index !== ' ';
}

export function isChangeUnstaged(file: ProjectChangeFile): boolean {
  return file.untracked || file.worktree !== ' ';
}

export function partitionProjectChanges(files: readonly ProjectChangeFile[]) {
  const working: ProjectChangeFile[] = [];
  const staged: ProjectChangeFile[] = [];
  for (const file of files) {
    if (isChangeUnstaged(file)) working.push(file);
    if (isChangeStaged(file)) staged.push(file);
  }
  return {
    all: [...files],
    working,
    staged,
    counts: {
      all: files.length,
      working: working.length,
      staged: staged.length,
    },
  };
}

export type ChangeBadgeTone = 'staged' | 'working' | 'both' | 'untracked' | 'conflict';

export function changeFileStatusBadge(file: ProjectChangeFile): {
  tone: ChangeBadgeTone;
  label: string;
  code: string;
} {
  const code = `${file.index}${file.worktree}`.trim() || '?';
  if (file.conflict) return { tone: 'conflict', label: t('冲突'), code };
  if (file.untracked) return { tone: 'untracked', label: t('未跟踪'), code: '??' };
  const staged = isChangeStaged(file);
  const working = isChangeUnstaged(file);
  if (staged && working) return { tone: 'both', label: t('暂存+未暂存'), code };
  if (staged) return { tone: 'staged', label: t('已暂存'), code };
  return { tone: 'working', label: t('未暂存'), code };
}

export function defaultDiffAreaForFile(
  file: ProjectChangeFile | undefined,
  preferredArea: ProjectDiff['area'],
  scopeFilter: ChangeScopeFilter,
): ProjectDiff['area'] {
  if (!file) return 'working';
  const staged = isChangeStaged(file);
  const working = isChangeUnstaged(file);
  if (scopeFilter === 'staged' && staged) return 'staged';
  if (scopeFilter === 'working' && working) return 'working';
  if (preferredArea === 'staged' && staged) return 'staged';
  return working ? 'working' : 'staged';
}

export type DiffHunk = {
  id: string;
  index: number;
  header: string;
  lines: string[];
  additions: number;
  deletions: number;
  raw: string;
};

/**
 * Parse a unified git diff patch into individual hunks so each hunk can be
 * quoted directly into the composer for targeted AI review/follow-up.
 */
export function parseDiffHunks(text: string, kind: ProjectDiff['kind']): DiffHunk[] {
  if (!text) return [];
  const allLines = text.replace(/\r\n?/g, '\n').split('\n');
  if (kind !== 'patch') {
    const visible = allLines.slice(0, 140);
    return [
      {
        id: 'file-0',
        index: 0,
        header: t('文件内容'),
        lines: visible,
        additions: visible.length,
        deletions: 0,
        raw: visible.join('\n'),
      },
    ];
  }
  const hunks: DiffHunk[] = [];
  let current: { header: string; lines: string[]; additions: number; deletions: number } | null = null;
  const flush = () => {
    if (!current) return;
    const index = hunks.length;
    hunks.push({
      id: `hunk-${index}`,
      index,
      header: current.header,
      lines: current.lines,
      additions: current.additions,
      deletions: current.deletions,
      raw: [current.header, ...current.lines].join('\n'),
    });
    current = null;
  };
  for (const line of allLines) {
    if (line.startsWith('@@')) {
      flush();
      current = { header: line, lines: [], additions: 0, deletions: 0 };
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
    if (line.startsWith('+') && !line.startsWith('+++')) current.additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) current.deletions++;
  }
  flush();
  return hunks;
}

/**
 * Build a clean, bounded quote payload for the composer MessageQuoteCard
 * so users can ask follow-up questions about a specific file diff or hunk.
 */
export function buildDiffQuoteText(input: {
  path: string;
  area?: ProjectDiff['area'];
  header?: string;
  snippet: string;
  maxLength?: number;
}): string {
  const maxLength = input.maxLength ?? 3600;
  const areaLabel = input.area === 'staged' ? t('已暂存') : input.area === 'working' ? t('未暂存') : '';
  const heading = [input.path, areaLabel, input.header?.trim()].filter(Boolean).join(' · ');
  const normalized = input.snippet.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return heading;
  const budget = Math.max(200, maxLength - heading.length - 16);
  const body =
    normalized.length > budget
      ? `${normalized.slice(0, budget).trimEnd()}\n…`
      : normalized;
  return `${heading}\n\`\`\`diff\n${body}\n\`\`\``;
}

/**
 * Determine whether quick preview / reveal-in-folder is safe for a changed file.
 * Deleted, sensitive, or restricted paths cannot be previewed or opened.
 */
export function canInspectChangedFile(
  file: ProjectChangeFile | undefined,
  diff: ProjectDiff | null,
): { canPreview: boolean; canReveal: boolean } {
  if (!file) return { canPreview: false, canReveal: false };
  const deletedInWorktree = file.worktree === 'D' || (file.index === 'D' && file.worktree === ' ');
  if (deletedInWorktree) return { canPreview: false, canReveal: false };
  if (diff && (diff.state === 'sensitive' || diff.state === 'restricted')) {
    return { canPreview: false, canReveal: false };
  }
  return { canPreview: true, canReveal: true };
}
