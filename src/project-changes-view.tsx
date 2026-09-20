import { useEffect, useMemo, useState } from 'react';
import { FileDiff, RefreshCw, LoaderCircle, Search, File, GitBranch } from 'lucide-react';
import { t } from '../shared/i18n.ts';
import type { Project } from '../shared/types.ts';
import type { ProjectChanges, ProjectDiff } from '../shared/project-changes.ts';
import { api } from './api';
import { Modal } from './ui';
import './project-changes.css';

const changeState = (state: ProjectChanges['state']) => state === 'not-repository' ? t('此目录没有 Git 仓库。')
  : state === 'too-large' ? t('改动列表过大，请使用本机 Git 工具查看。') : t('暂时无法读取 Git 改动，请确认 Git 已安装且目录可以访问。');
const diffState = (state: ProjectDiff['state']) => state === 'sensitive' ? t('此文件可能包含凭据，内容不在这里展示。')
  : state === 'binary' ? t('二进制或非 UTF-8 文件，请使用本机工具查看。')
    : state === 'too-large' ? t('文件或差异过大，请使用本机工具查看完整内容。')
      : state === 'restricted' ? t('此路径是链接或特殊文件，请在本机检查。') : t('文件状态已改变，请刷新改动列表。');

export function ProjectChangesView({ project, close }: { project: Project; close: () => void }) {
  const [snapshot, setSnapshot] = useState<ProjectChanges | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [area, setArea] = useState<ProjectDiff['area']>('working');
  const [query, setQuery] = useState('');
  const [diff, setDiff] = useState<ProjectDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(false); setDiff(null);
    void api<ProjectChanges>(`/projects/${encodeURIComponent(project.id)}/changes`, undefined, { signal: controller.signal, timeoutMilliseconds: 40_000 })
      .then(value => { if (controller.signal.aborted) return; setSnapshot(value); setSelected(previous => value.files.some(file => file.path === previous) ? previous : value.files[0]?.path || null); })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [project.id, revision]);
  const file = snapshot?.files.find(value => value.path === selected);
  const staged = !!file && !file.untracked && file.index !== ' ';
  const working = !!file && (file.untracked || file.worktree !== ' ');
  const effectiveArea = area === 'staged' && staged ? 'staged' : working ? 'working' : 'staged';
  useEffect(() => {
    if (!selected || loading || error || snapshot?.state !== 'ready') return;
    const controller = new AbortController(); setDiff(null); setDiffLoading(true); setDiffError(false);
    void api<ProjectDiff>(`/projects/${encodeURIComponent(project.id)}/changes/diff`, { path: selected, area: effectiveArea }, { signal: controller.signal, timeoutMilliseconds: 40_000 })
      .then(value => { if (!controller.signal.aborted) setDiff(value); })
      .catch(() => { if (!controller.signal.aborted) setDiffError(true); })
      .finally(() => { if (!controller.signal.aborted) setDiffLoading(false); });
    return () => controller.abort();
  }, [project.id, selected, effectiveArea, loading, error, revision, snapshot]);
  const files = useMemo(() => snapshot?.files.filter(value => value.path.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) || [], [snapshot, query]);
  return <Modal title={t('项目改动')} subtitle={project.name} close={close} className="project-changes-modal">
    <div className="project-changes-toolbar">
      <span><GitBranch size={14} />{snapshot?.branch || t('本机项目')}</span>
      <button className="button" onClick={() => setRevision(value => value + 1)} disabled={loading} aria-label={t('刷新项目改动')}>
        {loading ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}{t('刷新')}
      </button>
    </div>
    <p className="project-changes-scope">{t('这里显示本机项目的当前 Git 改动，可能包含你和其他工具的修改。仅供查看，不会暂存、提交或恢复文件。')}</p>
    {loading ? <p role="status">{t('正在读取项目改动…')}</p> : error ? <p role="alert">{t('读取项目改动失败，请重试。')}</p>
      : snapshot?.state !== 'ready' ? <p role="status">{snapshot && changeState(snapshot.state)}</p>
        : !snapshot.files.length ? <div className="project-changes-empty"><FileDiff size={28} /><p>{t('工作区没有待查看的改动。')}</p></div>
          : <>
            {snapshot.truncated && <p className="project-changes-warning">{t('仅显示前 500 个改动文件，请用本机 Git 工具查看其余文件。')}</p>}
            <div className="project-changes-layout">
              <aside className="project-changes-list" aria-label={t('改动文件')}>
                <label className="project-changes-search"><Search size={15} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('筛选文件路径')} aria-label={t('筛选文件路径')} /></label>
                <div role="list" className="project-change-file-list">
                  {files.map(value => <button key={value.path} role="listitem" className={`project-change-file ${selected === value.path ? 'active' : ''}`} aria-current={selected === value.path ? 'true' : undefined}
                    onClick={() => setSelected(value.path)} title={value.path}>
                    <File size={14} /><span>{value.path}</span><small title={value.conflict ? t('存在合并冲突') : value.untracked ? t('未跟踪') : t('暂存区 / 工作区状态')}>{value.index}{value.worktree}</small>
                  </button>)}
                  {!files.length && <p>{t('没有匹配的文件。')}</p>}
                </div>
              </aside>
              <section className="project-change-detail" aria-label={t('文件差异')}>
                <div className="project-change-detail-heading"><strong title={selected || ''}>{selected}</strong>
                  <div className="project-change-tabs" role="group" aria-label={t('差异范围')}>
                    <button aria-pressed={effectiveArea === 'working'} disabled={!working} onClick={() => setArea('working')}>{t('未暂存')}</button>
                    <button aria-pressed={effectiveArea === 'staged'} disabled={!staged} onClick={() => setArea('staged')}>{t('已暂存')}</button>
                  </div>
                </div>
                {file?.conflict && <p className="project-changes-warning">{t('此文件存在合并冲突，请在编辑器中处理。')}</p>}
                {diffLoading ? <p role="status">{t('正在读取差异…')}</p> : diffError ? <p role="alert">{t('读取差异失败，请刷新后重试。')}</p>
                  : diff?.state !== 'ready' ? <p role="status">{diff && diffState(diff.state)}</p>
                    : diff.text ? <>
                      {diff.kind === 'file' && <p className="project-changes-scope">{t('未跟踪文件：以下是当前文件内容。')}</p>}
                      <pre className="project-change-patch" tabIndex={0} aria-label={t('差异内容')}><code>{diff.text.split('\n').map((line, index) => <span key={index} className={diff.kind === 'patch' ? line.startsWith('+') && !line.startsWith('+++') ? 'added' : line.startsWith('-') && !line.startsWith('---') ? 'removed' : line.startsWith('@@') ? 'hunk' : undefined : undefined}>{line || ' '}</span>)}</code></pre>
                    </> : <p>{t('此范围没有文本差异，可能只有文件属性发生变化。')}</p>}
              </section>
            </div>
          </>}
  </Modal>;
}
