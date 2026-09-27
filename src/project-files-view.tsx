import { useEffect, useRef, useState } from 'react';
import { ArrowUp, File, Folder, LoaderCircle, RefreshCw, Search, X } from 'lucide-react';
import type { Project } from '../shared/types';
import type { ProjectFileEntry, ProjectFileListing } from '../shared/office-files';
import type { TaskFileDescriptor } from '../shared/task-files';
import { taskFileBytesLabel } from '../shared/task-files';
import { api } from './api';
import { t } from '../shared/i18n';
import { Modal } from './ui';
import { FilePreview } from './file-preview';
import { officeMessage } from './office-messages';
import { localActivity } from './local-activity';
import './project-files.css';
export function ProjectFilesView({ projects, initialProjectID, close }: { projects: Project[]; initialProjectID?: string; close: () => void }) {
  const [projectID, setProjectID] = useState(projects.some(project => project.id === initialProjectID) ? initialProjectID! : projects[0]?.id || ''), [path, setPath] = useState('');
  const [query, setQuery] = useState(''), [search, setSearch] = useState(''), [revision, setRevision] = useState(0);
  const [listing, setListing] = useState<ProjectFileListing | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<{ file: Pick<TaskFileDescriptor, 'name' | 'bytes'>; path: string } | null>(null);
  const [opening, setOpening] = useState('');
  const selectionRequest = useRef(0);
  const listingLocation = useRef('');
  useEffect(() => {
    selectionRequest.current += 1; setOpening('');
    if (!projectID) return; let alive = true; setLoading(true); setError('');
    const location = JSON.stringify([projectID, path, search]);
    if (listingLocation.current !== location) setListing(null);
    listingLocation.current = location;
    void localActivity.run('file-read', path || t('项目根目录'), () => api<ProjectFileListing>(`/projects/${projectID}/files?${new URLSearchParams({ path, search })}`)).then(value => { if (alive) setListing(value); })
      .catch(error => { if (alive) setError(officeMessage(error.message)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; selectionRequest.current += 1; };
  }, [projectID, path, search, revision]);
  async function choose(entry: ProjectFileEntry) {
    if (entry.directory) { setPath(entry.path); setQuery(''); setSearch(''); return; }
    const filePath = `/projects/${projectID}/file/${encodeURIComponent(entry.path)}`;
    const request = ++selectionRequest.current; setOpening(entry.path);
    try { setError(''); const file = await localActivity.run('file-read', entry.name, () => api<Pick<TaskFileDescriptor, 'name' | 'bytes'>>(filePath)); if (request === selectionRequest.current) setSelected({ file, path: filePath }); }
    catch (error) { if (request === selectionRequest.current) setError(officeMessage((error as Error).message)); }
    finally { if (request === selectionRequest.current) setOpening(''); }
  }
  const project = projects.find(value => value.id === projectID);
  return <><Modal title={t('项目文件')} subtitle={project?.directory} close={close} className="project-files-modal">
    <div className="project-files-controls"><select aria-label={t('项目')} value={projectID} disabled={!projects.length} onChange={event => { setProjectID(event.target.value); setPath(''); setQuery(''); setSearch(''); }}>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
      <button aria-label={t('返回上一级')} disabled={!path} onClick={() => { setPath(path.split('/').slice(0, -1).join('/')); setSearch(''); setQuery(''); }}><ArrowUp size={16} /></button>
      <button aria-label={t('刷新文件列表')} disabled={loading || !projectID} onClick={() => setRevision(value => value + 1)}><RefreshCw size={16} className={loading ? 'spin' : undefined} /></button>
      <form onSubmit={event => { event.preventDefault(); setSearch(query.trim()); }}><input aria-label={t('搜索文件名')} placeholder={t('搜索文件名')} value={query} disabled={!projectID} onChange={event => setQuery(event.target.value)} />{(query || search) && <button type="button" aria-label={t('清空搜索')} onClick={() => { setQuery(''); setSearch(''); }}><X size={15} /></button>}<button aria-label={t('搜索')} disabled={!projectID}><Search size={16} /></button></form>
    </div><p className="project-files-path">{path || t('项目根目录')}{search && ` · ${search}`}</p>
    {loading && !listing && <div className="project-files-state" role="status"><LoaderCircle size={24} className="spin" /><p>{t('正在读取…')}</p></div>}{error && <div className="project-files-error" role="alert"><span>{error}</span><button className="button" disabled={loading} onClick={() => setRevision(value => value + 1)}>{t('重试')}</button></div>}
    {!projects.length && <div className="project-files-state"><Folder size={28} /><p>{t('请先在执行与文件夹中添加工作文件夹。')}</p></div>}
    {listing && !listing.entries.length && <div className="project-files-state" role="status">{search ? <Search size={28} /> : <Folder size={28} />}<p>{search ? t('没有匹配的文件。') : t('没有可显示的文件。')}</p>{search && <button className="button" onClick={() => { setQuery(''); setSearch(''); }}>{t('清空搜索')}</button>}</div>}
    <ul className="project-file-list" aria-busy={loading || !!opening}>{listing?.entries.map(entry => <li key={entry.path}><button disabled={loading || !!opening} onClick={() => void choose(entry)}>
      {opening === entry.path ? <LoaderCircle size={18} className="spin" /> : entry.directory ? <Folder size={18} /> : <File size={18} />}<span><strong>{entry.name}</strong>{search && <small>{entry.path}</small>}</span><small>{entry.directory ? t('文件夹') : taskFileBytesLabel(entry.bytes)}</small>
    </button></li>)}</ul>{listing?.truncated && <p className="muted">{t('列表已限制显示数量，请进入具体文件夹或缩小搜索范围。')}</p>}
  </Modal>{selected && <FilePreview key={selected.path} file={selected.file} path={selected.path} source={project?.name} close={() => { setSelected(null); setRevision(value => value + 1); }} />}</>;
}
