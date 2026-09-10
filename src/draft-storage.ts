import { createWorkflowDraft, type ConversationDraft } from './conversation-drafts.ts';
import { validTaskFileDescriptor } from '../shared/task-files.ts';
import { validWorkflowTarget } from '../shared/workflows.ts';
import { t } from '../shared/i18n.ts';
import type { ApprovalMode } from '../shared/types.ts';

export type DraftSnapshot = { savedAt?: number; drafts: Record<string, ConversationDraft>; settings?: {
  projectID: string; model: string; approvalChoice: ApprovalMode | 'default'; criteria: string;
} };
export const draftStorageKey = (userID: string, nodeID: string) => `rivloom:drafts:v1:${nodeID}:${userID}`;
export function latestDrafts(local: string | null, server?: string | null): DraftSnapshot {
  const a = decodeDrafts(local), b = decodeDrafts(server || null);
  return (b.savedAt || 0) >= (a.savedAt || 0) && server ? b : a;
}
export function encodeDrafts(snapshot: DraftSnapshot) {
  return JSON.stringify({ version: 1, ...snapshot, drafts: Object.fromEntries(Object.entries(snapshot.drafts).map(([key, value]) => [key, {
    ...value, files: (value.files || []).map((f) => ({ ...f, file: { name: f.file.name, size: f.file.size, type: f.file.type } })),
  }])) });
}
export function decodeDrafts(text: string | null): DraftSnapshot {
  const empty = () => ({ drafts: { new: createWorkflowDraft() } });
  if (!text) return empty();
  try {
    const value = JSON.parse(text);
    if (value?.version !== 1 || !value.drafts || typeof value.drafts !== 'object') return empty();
    const drafts: Record<string, ConversationDraft> = {};
    for (const [key, raw] of Object.entries(value.drafts)) {
      const draft = raw as ConversationDraft;
      if (key !== 'new' && !/^(workflow|local|remote|brain):[\da-f-]{36}$/i.test(key)) continue;
      if (!draft || typeof draft.text !== 'string' || draft.text.length > 12_000 || !/^[\da-f-]{36}$/i.test(draft.requestID) ||
        !draft.routing || !['local', 'automatic', 'node', 'workflow'].includes(draft.routing.kind) ||
        draft.routing.kind === 'workflow' && !validWorkflowTarget(draft.routing.target)) continue;
      const files = (Array.isArray(draft.files) ? draft.files : []).slice(0, 5).filter((f) => f && typeof f.id === 'string' &&
        typeof f.file?.name === 'string' && Number.isFinite(f.file.size)).map((f) => ({ ...f,
          state: f.state === 'complete' && validTaskFileDescriptor(f.descriptor) ? 'complete' as const : 'failed' as const,
          error: f.state === 'complete' && validTaskFileDescriptor(f.descriptor) ? null : t('上传尚未完成，请移除此附件后重新选择。'),
          file: { name: f.file.name, size: f.file.size, type: f.file.type || '' },
        }));
      drafts[key] = { ...draft, files };
    }
    const settings = value.settings;
    return { savedAt: Number.isSafeInteger(value.savedAt) ? value.savedAt : 0, drafts: { new: createWorkflowDraft(), ...drafts }, ...(settings && typeof settings.projectID === 'string' &&
      typeof settings.model === 'string' && typeof settings.criteria === 'string' && settings.criteria.length <= 4000 &&
      ['default', 'ask', 'auto', 'full'].includes(settings.approvalChoice) ? { settings } : {}) };
  } catch { return empty(); }
}
