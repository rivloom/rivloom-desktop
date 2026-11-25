import { t } from '../shared/i18n.ts';
import { formatSkillDraftMarkdown, knowledgeLimits, safeKnowledgePath } from '../shared/knowledge.ts';

export type KnowledgeCaptureKind = 'memory' | 'skill';

export type KnowledgeCaptureSource = {
  conversationTitle: string;
  conversationID?: string;
  projectID: string | null;
  projectName?: string | null;
  originLabel?: string;
  excerpt: string;
  capturedAt?: string;
  noteKind?: 'goal' | 'constraint' | 'decision';
  noteID?: string;
  sourceRevision?: string;
  sourceQuote?: string;
};

export type KnowledgeCaptureDraft = {
  kind: KnowledgeCaptureKind;
  name: string;
  description: string;
  category: string;
  projectID: string | null;
  body: string;
  sourceLabel: string;
};

const RESERVED_SEGMENT = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function sanitizeCategorySegment(value: string, fallback = 'General') {
  const cleaned = value
    .replace(/[\\/\u0000-\u001f\u007f:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!cleaned || cleaned === '.' || cleaned === '..' || RESERVED_SEGMENT.test(cleaned)) {
    return fallback;
  }
  return cleaned.slice(0, 64);
}

export function suggestCaptureCategory(
  kind: KnowledgeCaptureKind,
  projectName?: string | null,
  noteKind?: KnowledgeCaptureSource['noteKind'],
) {
  const projectSegment = projectName ? sanitizeCategorySegment(projectName, '') : '';
  if (kind === 'skill') {
    const candidate = projectSegment ? `Skills/${projectSegment}` : 'Skills';
    return safeKnowledgePath(candidate) ? candidate : 'Skills';
  }
  const leaf =
    noteKind === 'decision'
      ? t('决定')
      : noteKind === 'constraint'
        ? t('约束')
        : noteKind === 'goal'
          ? t('目标')
          : t('经验');
  const root = t('项目');
  const candidate = projectSegment ? `${root}/${projectSegment}/${leaf}` : `${root}/${leaf}`;
  return safeKnowledgePath(candidate) ? candidate : 'Wiki';
}

function summarizeText(text: string, maxChars: number) {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>#-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return '';
  return plain.length > maxChars ? `${plain.slice(0, maxChars - 1).trimEnd()}…` : plain;
}

function singleLine(text: string, maxChars: number) {
  const clean = text.replace(/[\r\n\u0000]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > maxChars ? clean.slice(0, maxChars).trimEnd() : clean;
}

export function buildKnowledgeCaptureDraft(
  kind: KnowledgeCaptureKind,
  source: KnowledgeCaptureSource,
): KnowledgeCaptureDraft {
  const baseTitle = singleLine(
    source.originLabel && source.conversationTitle && source.originLabel !== source.conversationTitle
      ? `${source.conversationTitle} · ${source.originLabel}`
      : source.conversationTitle || source.originLabel || summarizeText(source.excerpt, 60) || t('会话经验'),
    120,
  );
  const excerptSummary = summarizeText(source.excerpt, 180);
  const description = singleLine(
    kind === 'skill'
      ? excerptSummary
        ? t('基于会话经验整理的复用步骤：{{summary}}', { summary: excerptSummary })
        : t('基于会话「{{title}}」整理的 Skill 模板草稿。', { title: source.conversationTitle || baseTitle })
      : excerptSummary || t('来自会话「{{title}}」的整理记录。', { title: source.conversationTitle || baseTitle }),
    600,
  );
  const category = suggestCaptureCategory(kind, source.projectName, source.noteKind);
  const capturedAt = source.capturedAt || new Date().toISOString();
  const sourceLines = [
    t('- 来源会话：{{title}}', { title: source.conversationTitle || t('未命名会话') }),
    ...(source.conversationID ? [t('- 会话标识：{{id}}', { id: source.conversationID })] : []),
    ...(source.originLabel ? [t('- 来源位置：{{label}}', { label: source.originLabel })] : []),
    ...(source.noteID ? [t('- 确认条目：{{id}}', { id: source.noteID })] : []),
    ...(source.sourceRevision ? [t('- 来源版本：{{revision}}', { revision: source.sourceRevision.slice(0, 12) })] : []),
    t('- 沉淀时间：{{time}}', { time: capturedAt }),
  ];
  const quoteBlock = source.sourceQuote
    ? `\n\n> ${source.sourceQuote.replace(/\r?\n/g, '\n> ')}`
    : '';
  const provenanceHeading = `## ${t('来源追溯')}`;
  const provenanceNote =
    kind === 'skill'
      ? t('由本机创建者人工审校保存为 Skill 模板草稿；默认本机私有，登记、分享与读取均不执行脚本。')
      : t('由本机创建者人工审校保存为项目 Wiki 参考；默认本机私有，不覆盖当前任务要求与权限。');
  const provenanceBlock = `${provenanceHeading}\n\n${sourceLines.join('\n')}${quoteBlock}\n\n${provenanceNote}`;

  const rawExcerpt = source.excerpt.replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim();
  let body = '';
  if (kind === 'skill') {
    const heading = `# ${baseTitle}`;
    const templatePrefix = [
      heading,
      '',
      `## ${t('适用场景')}`,
      '',
      description,
      '',
      `## ${t('执行步骤与参考摘录')}`,
      '',
    ].join('\n');
    const templateSuffix = [
      '',
      '',
      `## ${t('检查清单')}`,
      '',
      `- ${t('先核对当前任务要求与已确认约束，避免直接套用过期前提。')}`,
      `- ${t('如需运行命令或脚本，请先人工审校内容并沿用当前任务审批模式。')}`,
      '',
      provenanceBlock,
    ].join('\n');
    const budget = Math.max(200, knowledgeLimits.bodyChars - templatePrefix.length - templateSuffix.length);
    const trimmedExcerpt =
      rawExcerpt.length > budget ? `${rawExcerpt.slice(0, budget - 1).trimEnd()}…` : rawExcerpt;
    body = `${templatePrefix}${trimmedExcerpt || t('请在此补充可复用的操作步骤与注意事项。')}${templateSuffix}`;
  } else {
    const suffix = `\n\n${provenanceBlock}`;
    const budget = Math.max(200, knowledgeLimits.bodyChars - suffix.length);
    const trimmedExcerpt =
      rawExcerpt.length > budget ? `${rawExcerpt.slice(0, budget - 1).trimEnd()}…` : rawExcerpt;
    body = `${trimmedExcerpt || t('请补充需要长期保留的项目背景、决定或规范。')}${suffix}`;
  }

  return {
    kind,
    name: baseTitle,
    description,
    category,
    projectID: source.projectID,
    body: body.slice(0, knowledgeLimits.bodyChars),
    sourceLabel: source.originLabel
      ? `${source.conversationTitle} · ${source.originLabel}`
      : source.conversationTitle,
  };
}

export function previewSkillDraftFile(draft: Pick<KnowledgeCaptureDraft, 'name' | 'description' | 'body'>) {
  return formatSkillDraftMarkdown({
    name: draft.name.trim() || 'Skill',
    description: draft.description.trim() || 'Skill draft',
    body: draft.body,
  });
}
