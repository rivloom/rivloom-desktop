import { useEffect, useMemo, useState } from 'react';
import { BookMarked, ChevronDown, ChevronRight, CodeXml, ExternalLink, LibraryBig, LoaderCircle, RefreshCw } from 'lucide-react';
import { t } from '../shared/i18n.ts';
import type { KnowledgeUsage, KnowledgeUsagePage } from '../shared/knowledge.ts';
import { api } from './api';
import { summarizeKnowledgeUsage } from './knowledge-usage-summary';

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function useKnowledgeUsage(taskIDs: readonly string[], revision: string, enabled = true) {
  const [entries, setEntries] = useState<KnowledgeUsage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [manualTick, setManualTick] = useState(0);

  const stableIDs = useMemo(() => [...new Set(taskIDs.filter(Boolean))].slice(0, 20), [taskIDs]);
  const idsKey = stableIDs.join(',');

  useEffect(() => {
    if (!enabled || !stableIDs.length) {
      setEntries([]);
      setHasMore(false);
      setLoading(false);
      setError(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    void Promise.all(
      stableIDs.map((taskID) =>
        api<KnowledgeUsagePage>(`/tasks/${encodeURIComponent(taskID)}/context/knowledge`, undefined, {
          signal: controller.signal,
          timeoutMilliseconds: 15_000,
        }),
      ),
    )
      .then((pages) => {
        if (controller.signal.aborted) return;
        setEntries(pages.flatMap((page) => page.entries));
        setHasMore(pages.some((page) => page.nextOffset !== null));
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [idsKey, revision, enabled, manualTick]);

  return {
    entries,
    hasMore,
    loading,
    error,
    refresh: () => setManualTick((value) => value + 1),
  };
}

export function TaskKnowledgeUsageSection({
  taskIDs,
  revision,
  hasRemoteExecutions = false,
  localNodeID,
  nodeName,
  brainName,
  compact = false,
  onOpenContext,
}: {
  taskIDs: readonly string[];
  revision: string;
  hasRemoteExecutions?: boolean;
  localNodeID: string | null;
  nodeName: (id: string | null) => string;
  brainName?: (id: string | null) => string | null;
  compact?: boolean;
  onOpenContext?: () => void;
}) {
  const { entries, hasMore, loading, error, refresh } = useKnowledgeUsage(taskIDs, revision);
  const digest = useMemo(() => summarizeKnowledgeUsage(entries), [entries]);
  const [collapsed, setCollapsed] = useState(false);

  const hasItems = digest.items.length > 0;
  const effectiveCollapsed = compact && !hasItems && !error ? collapsed : false;

  return (
    <section
      className={`inspector-section inspector-knowledge-section${compact ? ' is-compact' : ''}`}
      aria-label={t('已读取知识记录')}
    >
      <div className="inspector-section-head">
        <span className="inspector-section-title">
          {compact && !hasItems && !error && (
            <button
              type="button"
              className="inspector-collapse-toggle"
              aria-expanded={!effectiveCollapsed}
              aria-label={t('展开或收起已读取知识记录')}
              onClick={() => setCollapsed((value) => !value)}
            >
              {effectiveCollapsed ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
            </button>
          )}
          <LibraryBig size={13} aria-hidden="true" />
          <strong>{t('已读取知识记录')}</strong>
          {hasItems && (
            <small>
              {t('{{count}} 项', { count: digest.items.length })}
            </small>
          )}
        </span>
        <span className="inspector-section-actions">
          {taskIDs.length > 0 && (
            <button
              type="button"
              className="inspector-icon-btn"
              disabled={loading}
              aria-label={t('刷新')}
              title={t('刷新')}
              onClick={refresh}
            >
              {loading ? <LoaderCircle size={12.5} className="spin" /> : <RefreshCw size={12.5} />}
            </button>
          )}
          {onOpenContext && (
            <button
              type="button"
              className="inspector-icon-btn"
              aria-label={t('查看完整读取记录')}
              title={t('查看完整读取记录')}
              onClick={onOpenContext}
            >
              <ExternalLink size={12.5} aria-hidden="true" />
            </button>
          )}
        </span>
      </div>

      {!effectiveCollapsed && (
        <>
          <p className="inspector-knowledge-disclaimer">
            {t('仅展示本机任务工具实际读取过的目录条目与版本，不代表模型已理解全部内容。')}
          </p>

          {error ? (
            <p className="inspector-note is-error" role="alert">
              {t('暂时无法读取知识读取记录，请刷新重试。')}
            </p>
          ) : loading && !hasItems ? (
            <p className="inspector-note" role="status">
              {t('正在加载读取记录…')}
            </p>
          ) : hasItems ? (
            <>
              <div className="inspector-knowledge-counts">
                {digest.wikiCount > 0 && (
                  <span>
                    <BookMarked size={11} aria-hidden="true" />
                    {t('Wiki {{count}}', { count: digest.wikiCount })}
                  </span>
                )}
                {digest.skillCount > 0 && (
                  <span>
                    <CodeXml size={11} aria-hidden="true" />
                    {t('Skill {{count}}', { count: digest.skillCount })}
                  </span>
                )}
                <span>{t('共 {{count}} 次读取', { count: digest.totalReads })}</span>
              </div>
              <ul className="inspector-knowledge-list">
                {digest.items.map((item) => {
                  const isLocalSource = item.brainID === null && (!localNodeID || item.sourceNodeID === localNodeID);
                  const sourceNodeLabel = isLocalSource ? t('本机') : nodeName(item.sourceNodeID);
                  const viaBrain = item.brainID ? brainName?.(item.brainID) || item.brainID.slice(0, 8) : null;
                  return (
                    <li className="inspector-knowledge-item" key={item.key}>
                      <div className="inspector-knowledge-item-head">
                        <span className={`knowledge-kind-pill is-${item.kind}`}>
                          {item.kind === 'skill' ? <CodeXml size={10.5} aria-hidden="true" /> : <BookMarked size={10.5} aria-hidden="true" />}
                          {item.kind === 'skill' ? 'Skill' : 'Wiki'}
                        </span>
                        <strong title={item.name}>{item.name}</strong>
                        <code title={item.revision}>{item.revision.slice(0, 8)}</code>
                      </div>
                      {item.description && (
                        <p className="inspector-knowledge-summary">{item.description}</p>
                      )}
                      <div className="inspector-knowledge-meta">
                        <span>
                          {viaBrain
                            ? t('来源：{{node}} · 经由 {{brain}}', { node: sourceNodeLabel, brain: viaBrain })
                            : t('来源：{{node}}', { node: sourceNodeLabel })}
                        </span>
                        <span>{formatBytes(item.totalBytes)}</span>
                      </div>
                      <div className="inspector-knowledge-files">
                        {item.files.map((file) => (
                          <span className="inspector-knowledge-file" key={file.file} title={file.file}>
                            <code>{file.file}</code>
                            <em>
                              {file.materializeCount > 0
                                ? t('准备文件')
                                : file.complete
                                  ? t('已读完整')
                                  : t('已读片段')}
                            </em>
                          </span>
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {hasMore && (
                <p className="inspector-note">
                  {t('还有更多读取分页，可在“会话上下文 → 读取记录”中查看。')}
                </p>
              )}
            </>
          ) : (
            <p className="inspector-note">
              {taskIDs.length > 0
                ? t('本次任务本机执行尚未记录按需读取的 Wiki 或 Skill。')
                : t('当前会话没有本机执行记录。')}
            </p>
          )}

          {hasRemoteExecutions && (
            <p className="inspector-note inspector-knowledge-remote-note">
              {t('包含远端节点执行；远端读取记录保存在对应执行设备。')}
            </p>
          )}
        </>
      )}
    </section>
  );
}
