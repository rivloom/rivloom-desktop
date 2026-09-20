import type { Conversation } from '../shared/conversations.ts';
import type { TaskFileDescriptor } from '../shared/task-files.ts';
import type { Workflow } from '../shared/workflows.ts';
import { workflowPendingMessages } from '../shared/workflows.ts';
import { t } from '../shared/i18n.ts';
import { executionSummaryText } from './system-display.ts';
import { workflowResults } from './workflow-results.ts';
import { workflowAttemptResponse } from './conversation-search.ts';

export type ConversationExportFormat = 'markdown' | 'json';
export type ExportAttachment = { name: string; bytes: number; mime: string };
export type ExportEntry = {
  kind: 'request' | 'response' | 'plan' | 'step-result' | 'queued-request';
  text: string;
  stepTitle?: string;
  attempt?: number;
  attachments?: ExportAttachment[];
};
export type ConversationExport = {
  schemaVersion: 1;
  format: 'rivloom-visible-conversation';
  exportedAt: string;
  conversation: { key: string; title: string; kind: 'workflow' | 'task' | 'brain' | 'remote'; createdAt: string; updatedAt: string; incoming: boolean };
  coverage: 'workflow-rounds' | 'local-messages' | 'summary-only' | 'request-only';
  limitations: ('visible-records-only' | 'no-tool-payloads' | 'attachment-metadata-only' | 'remote-transcript-unavailable' | 'no-response-recorded')[];
  rounds: { number: number; entries: ExportEntry[] }[];
  queuedRequests: ExportEntry[];
};

const attachments = (files: readonly TaskFileDescriptor[] = []): ExportAttachment[] =>
  files.map(file => ({ name: file.name, bytes: file.bytes, mime: file.mime }));

/** Accept only an already-authorized UI Conversation, never a Bootstrap or engine record.
 * Every output property is selected explicitly; this is a readable snapshot, not a backup.
 */
export function exportVisibleConversation(item: Conversation, exportedAt = new Date().toISOString()): ConversationExport {
  if (!Number.isFinite(Date.parse(exportedAt))) throw new TypeError('Invalid export timestamp');
  const document: ConversationExport = {
    schemaVersion: 1, format: 'rivloom-visible-conversation', exportedAt,
    conversation: { key: item.key, title: item.title, kind: item.workflow ? 'workflow' : item.brainTask ? 'brain' : item.remote ? 'remote' : 'task',
      createdAt: item.createdAt, updatedAt: item.updatedAt, incoming: item.incoming },
    coverage: 'request-only', limitations: ['visible-records-only', 'no-tool-payloads', 'attachment-metadata-only'], rounds: [], queuedRequests: [],
  };
  if (item.workflow) {
    const workflow = item.workflow;
    const rounds = [...(workflow.rounds || []).map(round => ({ ...workflow, ...round, roundRequestID: round.requestID })), workflow];
    document.coverage = 'workflow-rounds';
    document.rounds = rounds.map((round, index) => {
      const roundID = round.roundRequestID || round.requestID;
      // Match the UI: generated continuity files are not user attachments.
      const files = workflow.messages?.find(message => message.requestID === roundID)?.inputFiles
        || (roundID === workflow.requestID ? round.inputFiles : []);
      const entries: ExportEntry[] = [{ kind: 'request', text: round.description, attachments: attachments(files) }];
      const results = workflowResults(round as Workflow);
      for (const { step, attempt, summary } of results) if (summary.trim())
        entries.push({ kind: 'response', text: summary, stepTitle: step.title, attempt: attempt.number, attachments: attachments(attempt.outputFiles) });
      if (round.summary.trim()) entries.push({ kind: 'plan', text: round.summary });
      for (const step of round.steps) for (const attempt of step.attempts) {
        if (results.some(result => result.step === step && result.attempt === attempt)) continue;
        const text = workflowAttemptResponse(step, attempt);
        if (text.trim()) entries.push({ kind: 'step-result', text, stepTitle: step.title, attempt: attempt.number, attachments: attachments(attempt.outputFiles) });
      }
      return { number: index + 1, entries };
    });
    document.queuedRequests = workflowPendingMessages(workflow).map(message => ({ kind: 'queued-request', text: message.text, attachments: attachments(message.inputFiles) }));
  } else if (item.localTask) {
    const messages = item.localTask.messages;
    const firstUser = messages.find(message => message.role === 'user');
    const entries: ExportEntry[] = [];
    if (!firstUser) entries.push({ kind: 'request', text: item.description, attachments: attachments(item.localTask.inputFiles) });
    for (const message of messages) {
      // The initial engine prompt wraps internal task instructions. Export its displayed replacement.
      const first = message === firstUser;
      const text = first ? item.description : message.text;
      if (text.trim()) entries.push({ kind: message.role === 'user' ? 'request' : 'response', text, ...(first ? { attachments: attachments(item.localTask.inputFiles) } : {}) });
    }
    document.coverage = messages.length ? 'local-messages' : 'request-only';
    document.rounds = [{ number: 1, entries }];
  } else {
    const summary = executionSummaryText(item.brainTask?.executionSummary || item.remote?.executionSummary,
      item.brainTask?.status || item.remote?.executionState);
    const entries: ExportEntry[] = [{ kind: 'request', text: item.description, attachments: attachments(item.brainTask?.inputFiles || item.remote?.inputFiles) }];
    if (summary.trim()) entries.push({ kind: 'response', text: summary });
    document.coverage = summary.trim() ? 'summary-only' : 'request-only';
    document.limitations.push('remote-transcript-unavailable');
    document.rounds = [{ number: 1, entries }];
  }
  if (!document.rounds.some(round => round.entries.some(entry => ['response', 'step-result'].includes(entry.kind))))
    document.limitations.push('no-response-recorded');
  return document;
}

export function conversationExportNotes(document: ConversationExport): string[] {
  const descriptions = {
    'visible-records-only': t('仅导出当前账号可见的已同步记录，不是应用备份。'),
    'no-tool-payloads': t('不额外导出工具记录、内部执行提示、应用保存的模型配置或凭据；消息正文按原文保留。'),
    'attachment-metadata-only': t('附件仅保留名称、类型和大小，不包含文件内容或下载权限。'),
    'remote-transcript-unavailable': t('本机没有此会话的完整执行消息，仅导出已同步的需求和结果摘要。'),
    'no-response-recorded': t('当前记录中没有可导出的回答。'),
  };
  return document.limitations.map(reason => descriptions[reason]);
}

/** Text fences keep arbitrary message Markdown/HTML inert and cannot be closed by its contents. */
export function exportTextFence(text: string): string {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}`;
}
function heading(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/[\\`*_{}[\]<>#!|]/g, '\\$&');
}
export function serializeConversationExport(document: ConversationExport, format: ConversationExportFormat): string {
  if (format === 'json') return JSON.stringify(document, null, 2) + '\n';
  const labels: Record<ExportEntry['kind'], string> = { request: t('用户要求'), response: t('回答'), plan: t('计划说明'), 'step-result': t('步骤结果'), 'queued-request': t('待执行消息') };
  const lines = [`# ${heading(document.conversation.title)}`, '', `${t('导出时间')}：${document.exportedAt}`, '', ...conversationExportNotes(document).map(note => `- ${note}`), ''];
  const entry = (value: ExportEntry) => {
    lines.push(`### ${labels[value.kind]}${value.stepTitle ? ` · ${heading(value.stepTitle)}` : ''}`, '', exportTextFence(value.text), '');
    if (value.attachments?.length) {
      lines.push(t('附件清单'), '', exportTextFence(value.attachments.map(file => `${file.name} (${file.bytes} bytes; ${file.mime})`).join('\n')), '');
    }
  };
  for (const round of document.rounds) { lines.push(`## ${t('第 {{count}} 轮', { count: round.number })}`, ''); round.entries.forEach(entry); }
  if (document.queuedRequests.length) { lines.push(`## ${t('待执行消息')}`, ''); document.queuedRequests.forEach(entry); }
  return lines.join('\n');
}

export function conversationExportFilename(title: string, format: ConversationExportFormat, exportedAt: string): string {
  const clean = title.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '-').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '');
  let name = '';
  for (const char of clean) { if (new TextEncoder().encode(name + char).length > 140) break; name += char; }
  name = name.replace(/[. ]+$/g, '') || 'conversation';
  const date = /^\d{4}-\d{2}-\d{2}/.exec(exportedAt)?.[0] || 'export';
  return `rivloom-${name}-${date}.${format === 'json' ? 'json' : 'md'}`;
}

export function createConversationExportFile(document: ConversationExport, format: ConversationExportFormat) {
  return { fileName: conversationExportFilename(document.conversation.title, format, document.exportedAt),
    mime: format === 'json' ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8', text: serializeConversationExport(document, format) };
}
