import { useState } from 'react';
import { FolderOpen, RefreshCw } from 'lucide-react';
import { t, systemText } from '../shared/i18n.ts';
import type { ResourceDiscoveryNode } from '../shared/resources.ts';
import type { Project } from '../shared/types.ts';
import { api } from './api';
import { Button } from './ui';
import './resource-discovery.css';

export function resourceStatus(node: ResourceDiscoveryNode) {
  if (node.status !== 'current') return { stale: t('等待更新'), offline: t('离线 · 保留上次目录'), unsupported: t('此版本未提供资源目录'),
    unknown: t('目录尚未确认'), timeout: t('查询超时') }[node.status];
  return node.head ? { unconfigured: t('尚未选择工作目录'), scanning: t('正在建立目录'), ready: t('目录已更新'),
    partial: t('已建立部分目录'), error: t('目录更新失败') }[node.head.state] : t('目录尚未确认');
}
export function ResourceDiscovery({ nodes, refresh, nodeName, localNodeID, projects }: {
  nodes: ResourceDiscoveryNode[]; refresh: () => Promise<unknown>; nodeName: (id: string | null) => string;
  localNodeID?: string; projects: Pick<Project, 'id' | 'directory'>[];
}) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function update() {
    setBusy(true); setError('');
    try {
      await api('/resources/refresh', {}); await refresh();
    } catch (cause) { setError(systemText(cause instanceof Error ? cause.message : String(cause))); }
    finally { setBusy(false); }
  }
  return <section className="network-section resource-discovery" aria-label={t('资源目录')}>
    <div className="section-title"><h2><FolderOpen size={17} />{t('资源目录')}</h2>
      <Button disabled={busy} onClick={() => void update()}><RefreshCw size={14} />{t('更新目录')}</Button></div>
    <p className="muted">{t('各机器已登记的工作目录。本机显示完整路径，其他机器显示对端登记的目录名称。')}</p>
    <div className="resource-directory-nodes">{nodes.map((node) => {
      const localProject = node.nodeID === localNodeID
        ? projects.find((project) => project.id === node.head?.workspaceID) : undefined;
      return <article key={node.nodeID}>
        <header><strong>{nodeName(node.nodeID)}</strong><span>{resourceStatus(node)}</span></header>
        <dl className="resource-workspace"><dt>{t('工作目录')}</dt><dd>
          {localProject?.directory || node.head?.workspaceName || (node.head?.state === 'unconfigured' ? t('尚未选择工作目录') : t('目录尚未确认'))}
        </dd></dl>
        {node.head?.error && <p role="status">{systemText(node.head.error)}</p>}
        {!!node.head?.capabilities.length && <details className="resource-capabilities">
          <summary>{t('工具与模型')} <span>{node.head.capabilities.length}</span></summary>
          <ul>{node.head.capabilities.map((cap) => <li key={cap.id}><span>{cap.name}</span><small>{cap.status === 'available' ? cap.version || t('可用') : cap.status === 'unavailable' ? t('未发现') : t('待确认')}</small></li>)}</ul>
        </details>}
        {!!node.head?.checkedAt && <small>{t('最后检查')}：{new Date(node.head.checkedAt).toLocaleString()}</small>}
      </article>;
    })}{!nodes.length && <p className="muted">{t('资源目录正在初始化，请稍后重试。')}</p>}</div>
    {error && <p className="resource-directory-error" role="alert">{error}</p>}
  </section>;
}
