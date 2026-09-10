import { ChevronDown, ChevronRight, FolderOpen, MoreHorizontal, Pencil, Copy } from 'lucide-react';
import { t } from '../shared/i18n.ts';
import { validDirectoryKey } from '../shared/directory-aliases';
import { desktop, openProjectDirectory } from './desktop';
import { ContextMenu, useContextMenu } from './context-menu';

export function HistoryDirectoryHeading({ group, expanded, toggle, alias, busy, perform, copied }: {
  group: { key: string; name: string; label: string; items: unknown[] }; expanded: boolean; toggle: () => void;
  alias: () => void; busy: boolean; perform: (action: () => Promise<unknown>) => Promise<boolean>; copied: () => void;
}) {
  const menu = useContextMenu();
  const local = group.key.startsWith('local:');
  const hint = !local ? t('仅本机工作目录提供完整路径。') : undefined;
  return <div className="history-directory-heading" onContextMenu={menu.context} onKeyDown={menu.keyboard}>
    <button type="button" className="history-directory-toggle" title={`${group.name}\n${group.label}`} aria-expanded={expanded} onClick={toggle}>
      {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<FolderOpen size={14} /><span>{group.name}</span><small>{group.items.length}</small>
    </button>
    <button type="button" className="context-more icon-button" aria-label={t('目录操作：{{name}}', { name: group.name })} title={t('更多操作')} {...menu.trigger}><MoreHorizontal size={15} /></button>
    <ContextMenu menu={menu} label={t('目录操作')} actions={[
      { id: 'alias', label: t('设置目录别名'), icon: <Pencil />, disabled: busy || !validDirectoryKey(group.key), select: alias },
      { id: 'copy', label: t('复制完整路径'), icon: <Copy />, disabled: busy || !local, hint, select: () => void perform(async () => {
        try { await navigator.clipboard.writeText(group.label); copied(); } catch { throw new Error(t('复制失败，请重试。')); }
      }) },
      { id: 'open', label: t('打开文件夹'), icon: <FolderOpen />, disabled: busy || !local || !desktop,
        hint: hint || (!desktop ? t('请在桌面端打开本机文件夹。') : undefined), select: () => void perform(() => openProjectDirectory(group.label)) },
    ]} />
  </div>;
}
