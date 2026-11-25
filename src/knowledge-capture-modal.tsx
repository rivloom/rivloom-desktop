import { useEffect, useId, useMemo, useState } from 'react';
import { BookMarked, CodeXml, Lock, ShieldCheck } from 'lucide-react';
import { t, systemText } from '../shared/i18n.ts';
import { knowledgeError } from '../shared/knowledge-errors.ts';
import { knowledgeLimits, safeKnowledgePath, type LocalKnowledgeEntry } from '../shared/knowledge.ts';
import type { Project } from '../shared/types.ts';
import { api } from './api';
import { CopyButton } from './copy-button';
import {
  buildKnowledgeCaptureDraft,
  previewSkillDraftFile,
  type KnowledgeCaptureDraft,
  type KnowledgeCaptureKind,
  type KnowledgeCaptureSource,
} from './knowledge-capture';
import { Button, Field, Modal } from './ui';

export function KnowledgeCaptureModal({
  source,
  initialKind,
  projects,
  onSaved,
  close,
}: {
  source: KnowledgeCaptureSource;
  initialKind: KnowledgeCaptureKind;
  projects: Project[];
  onSaved?: (entry: LocalKnowledgeEntry) => void;
  close: () => void;
}) {
  const resolvedProjectID = useMemo(
    () => (source.projectID && projects.some((p) => p.id === source.projectID) ? source.projectID : null),
    [source.projectID, projects],
  );
  const projectName = useMemo(
    () => source.projectName || projects.find((p) => p.id === resolvedProjectID)?.name || null,
    [source.projectName, projects, resolvedProjectID],
  );
  const enrichedSource = useMemo<KnowledgeCaptureSource>(
    () => ({ ...source, projectID: resolvedProjectID, projectName }),
    [source, resolvedProjectID, projectName],
  );

  const [kind, setKind] = useState<KnowledgeCaptureKind>(initialKind);
  const [draft, setDraft] = useState<KnowledgeCaptureDraft>(() =>
    buildKnowledgeCaptureDraft(initialKind, enrichedSource),
  );
  const [edited, setEdited] = useState(false);
  const [categories, setCategories] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const categoryListID = useId();

  useEffect(() => {
    const controller = new AbortController();
    void api<{ entries: LocalKnowledgeEntry[] }>('/knowledge', undefined, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        const unique = [...new Set(result.entries.map((entry) => entry.category).filter(Boolean))].sort();
        setCategories(unique);
      })
      .catch(() => {
        /* Category suggestions are best-effort only. */
      });
    return () => controller.abort();
  }, []);

  function switchKind(next: KnowledgeCaptureKind) {
    if (next === kind || busy) return;
    setKind(next);
    setError('');
    if (!edited) {
      setDraft(buildKnowledgeCaptureDraft(next, enrichedSource));
      return;
    }
    const suggested = buildKnowledgeCaptureDraft(next, enrichedSource);
    setDraft((prev) => ({
      ...prev,
      kind: next,
      category: suggested.category,
      description: prev.description || suggested.description,
    }));
  }

  function updateField<K extends keyof KnowledgeCaptureDraft>(field: K, value: KnowledgeCaptureDraft[K]) {
    setEdited(true);
    setDraft((prev) => ({ ...prev, [field]: value }));
  }

  const categoryValid = safeKnowledgePath(draft.category.trim());
  const canSubmit =
    !busy &&
    !!draft.name.trim() &&
    categoryValid &&
    !!draft.body.trim() &&
    (kind === 'memory' || !!draft.description.trim());

  const skillMarkdownPreview = useMemo(
    () => (kind === 'skill' ? previewSkillDraftFile(draft) : ''),
    [kind, draft],
  );

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    try {
      const saved =
        kind === 'skill'
          ? await api<LocalKnowledgeEntry>('/knowledge/skills/draft', {
              name: draft.name.trim(),
              description: draft.description.trim(),
              category: draft.category.trim(),
              body: draft.body.trim(),
              projectID: draft.projectID,
            })
          : await api<LocalKnowledgeEntry>('/knowledge/memory', {
              name: draft.name.trim(),
              description: draft.description.trim(),
              category: draft.category.trim(),
              body: draft.body.trim(),
              projectID: draft.projectID,
            });
      onSaved?.(saved);
      close();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(knowledgeError(message) || systemText(message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={kind === 'skill' ? t('沉淀为 Skill 模板草稿') : t('存为项目 Wiki')}
      subtitle={draft.sourceLabel}
      close={() => {
        if (!busy) close();
      }}
      className="knowledge-editor knowledge-capture-modal"
    >
      <div className="knowledge-capture-modes" role="tablist" aria-label={t('沉淀类型')}>
        <button
          type="button"
          role="tab"
          aria-selected={kind === 'memory'}
          disabled={busy}
          onClick={() => switchKind('memory')}
        >
          <BookMarked size={14} aria-hidden="true" />
          <span>{t('存为项目 Wiki')}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={kind === 'skill'}
          disabled={busy}
          onClick={() => switchKind('skill')}
        >
          <CodeXml size={14} aria-hidden="true" />
          <span>{t('沉淀为 Skill 模板草稿')}</span>
        </button>
      </div>

      <div className="knowledge-boundary-banner" role="note">
        {kind === 'skill' ? <ShieldCheck size={15} aria-hidden="true" /> : <Lock size={15} aria-hidden="true" />}
        <p>
          {kind === 'skill'
            ? t('请先人工审校内容。保存后仅生成本机私有 SKILL.md 模板草稿，默认不分享给 Brain，且登记、分享与读取均不执行脚本。')
            : t('请先人工审校内容。保存后仅存为本机私有 Wiki 并保留来源追溯，默认不分享给 Brain，不会覆盖当前任务约束。')}
        </p>
      </div>

      {error && (
        <p className="knowledge-error" role="alert">
          {error}
        </p>
      )}

      <form
        className="knowledge-capture-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label={kind === 'skill' ? t('Skill 名称') : t('名称')}>
          <input
            autoFocus
            required
            disabled={busy}
            maxLength={120}
            value={draft.name}
            onChange={(event) => updateField('name', event.target.value)}
          />
        </Field>

        <Field
          label={t('用途摘要')}
          hint={
            kind === 'skill'
              ? t('必填。写入 SKILL.md 文件头，供 Agent 先通过摘要判断是否按需读取。')
              : t('Agent 先看到这段摘要，再决定是否读取正文。')
          }
        >
          <input
            required={kind === 'skill'}
            disabled={busy}
            maxLength={600}
            value={draft.description}
            onChange={(event) => updateField('description', event.target.value)}
          />
        </Field>

        <div className="knowledge-capture-row">
          <Field
            label={t('分类路径')}
            hint={kind === 'skill' ? t('例如：Skills 或 Skills/项目名。') : t('例如：项目/名称/决定，或人物/张三/工作。')}
          >
            <input
              required
              disabled={busy}
              maxLength={240}
              list={categoryListID}
              value={draft.category}
              onChange={(event) => updateField('category', event.target.value)}
            />
            <datalist id={categoryListID}>
              {categories.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </Field>

          <Field label={t('本机适用范围')}>
            <select
              disabled={busy}
              value={draft.projectID || ''}
              onChange={(event) => updateField('projectID', event.target.value || null)}
            >
              <option value="">{t('本机所有工作目录')}</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {!categoryValid && draft.category.trim().length > 0 && (
          <p className="knowledge-error" role="alert">
            {t('分类路径需使用“/”分层，不能包含特殊字符或保留设备名。')}
          </p>
        )}

        <Field
          label={kind === 'skill' ? t('Skill 模板正文（SKILL.md）') : t('记忆正文')}
          hint={t('已预填来源会话与摘录内容，请删去临时对话细节和敏感信息后再保存。')}
        >
          <textarea
            required
            disabled={busy}
            rows={10}
            maxLength={knowledgeLimits.bodyChars}
            value={draft.body}
            onChange={(event) => updateField('body', event.target.value)}
          />
        </Field>

        {kind === 'skill' && (
          <details className="knowledge-skill-preview">
            <summary>{t('预览生成的 SKILL.md')}</summary>
            <div className="knowledge-skill-preview-bar">
              <small>{t('仅写入 SKILL.md，不附带或运行任何脚本。')}</small>
              <CopyButton text={skillMarkdownPreview} label={t('复制 SKILL.md')} iconOnly={false} />
            </div>
            <pre>
              <code>{skillMarkdownPreview}</code>
            </pre>
          </details>
        )}

        <div className="modal-actions">
          <Button disabled={busy} onClick={close}>
            {t('取消')}
          </Button>
          <Button type="submit" variant="primary" disabled={!canSubmit}>
            {busy
              ? t('正在保存…')
              : kind === 'skill'
                ? t('保存为私有 Skill 草稿')
                : t('保存为私有 Wiki')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
