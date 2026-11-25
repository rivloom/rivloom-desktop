import { useEffect, useState } from 'react';
import { ArrowRight, Check, Cpu, FolderOpen, Network, Plug, Plus, Sparkles } from 'lucide-react';
import { t } from '../shared/i18n.ts';
import type { Bootstrap, Project, RivloomNode } from '../shared/types';
import { evaluateCockpitOnboarding } from './cockpit-onboarding';
import { isFileTransfer } from './composer-files';
import { ConversationStarters } from './conversation-starters';
import { machineStatus } from './machine-status';
import { NodeAvatar } from './node-avatar';
import { nodeDisplayName } from './node-mentions';
import { Wordmark } from './ui';

function compactPath(directory: string) {
  const normalized = directory.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return normalized;
  return `…/${parts.slice(-2).join('/')}`;
}

export function MissionCockpit({
  awaitingCreatedConversation,
  owner,
  connected,
  disabled,
  local,
  peers,
  projects,
  projectID,
  engine,
  modelName,
  targetNodeID,
  targetMode,
  onboardingDismissed,
  onDismissOnboarding,
  onOpenConnections,
  onSelectProject,
  onAddFolder,
  onChooseStarter,
  onRouteNode,
  onManageDevices,
}: {
  awaitingCreatedConversation: boolean;
  owner: boolean;
  connected: boolean;
  disabled: boolean;
  local: RivloomNode | null;
  peers: readonly RivloomNode[];
  projects: readonly Project[];
  projectID: string;
  engine: Bootstrap['engine'];
  modelName: string;
  targetNodeID: string | null;
  targetMode: 'preferred' | 'locked';
  onboardingDismissed: boolean;
  onDismissOnboarding: () => void;
  onOpenConnections: () => void;
  onSelectProject: (id: string) => void;
  onAddFolder: () => void;
  onChooseStarter: (text: string) => void;
  onRouteNode: (node: RivloomNode | null, forcedMode?: 'preferred' | 'locked' | null) => void;
  onManageDevices: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  const [dragNodeID, setDragNodeID] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  const clusterNodes = [...(local ? [local] : []), ...peers].slice(0, 6);
  const onlineCount = (local && connected ? 1 : 0) + peers.filter((node) => node.online && node.channelReady).length;
  const recentProjects = projects.slice(0, 5);
  const onboarding = evaluateCockpitOnboarding({
    owner,
    dismissed: onboardingDismissed,
    engine,
    projects,
  });

  if (awaitingCreatedConversation) {
    return (
      <div className="blank-conversation mission-cockpit is-awaiting">
        <span className="blank-mark">
          <Wordmark />
        </span>
        <h1>{t('会话已保存')}</h1>
        <p>{t('正在等待会话状态更新。')}</p>
      </div>
    );
  }

  return (
    <div className="blank-conversation mission-cockpit">
      {onboarding.visible && (
        <section className="mission-onboarding" aria-label={t('快速开始')}>
          <div className="mission-onboarding-head">
            <span className="mission-onboarding-title">
              <Sparkles size={13} aria-hidden="true" />
              <strong>{t('快速开始')}</strong>
              <small>
                {t('已完成 {{done}} / {{total}}', {
                  done: onboarding.completedSteps,
                  total: onboarding.totalSteps,
                })}
              </small>
            </span>
            <button
              type="button"
              className="mission-inline-link"
              onClick={onDismissOnboarding}
            >
              {t('稍后配置')}
            </button>
          </div>
          <div className="mission-onboarding-steps">
            <div
              className={`mission-onboarding-step${onboarding.modelReady ? ' is-done' : onboarding.activeStep === 1 ? ' is-current' : ''}`}
            >
              <span className="mission-onboarding-index" aria-hidden="true">
                {onboarding.modelReady ? <Check size={12} /> : '1'}
              </span>
              <div className="mission-onboarding-copy">
                <strong>{t('接入模型')}</strong>
                <small>
                  {onboarding.modelReady
                    ? t('已就绪 · {{count}} 个可用模型', { count: engine.models.length })
                    : !onboarding.engineReady && !onboarding.engineError
                      ? t('本地引擎启动中，保存连接不会自动发起请求')
                      : t('保存模型服务地址或账号，不会自动触发连通测试')}
                </small>
              </div>
              {onboarding.modelReady ? (
                <span className="mission-onboarding-done-tag">{t('已配置')}</span>
              ) : (
                <button
                  type="button"
                  className="mission-onboarding-cta"
                  onClick={onOpenConnections}
                >
                  <Plug size={12} aria-hidden="true" />
                  <span>{t('连接模型')}</span>
                  <ArrowRight size={12} aria-hidden="true" />
                </button>
              )}
            </div>

            <div
              className={`mission-onboarding-step${onboarding.workspaceReady ? ' is-done' : onboarding.activeStep === 2 ? ' is-current' : ''}`}
            >
              <span className="mission-onboarding-index" aria-hidden="true">
                {onboarding.workspaceReady ? <Check size={12} /> : '2'}
              </span>
              <div className="mission-onboarding-copy">
                <strong>{t('选择首个工作文件夹')}</strong>
                <small>
                  {onboarding.workspaceReady
                    ? t('已登记 · {{name}}', { name: projects[0]?.name || '' })
                    : t('选择项目目录后即可补全文件与查看工作区改动')}
                </small>
              </div>
              {onboarding.workspaceReady ? (
                <span className="mission-onboarding-done-tag">{t('已配置')}</span>
              ) : (
                <button
                  type="button"
                  className="mission-onboarding-cta"
                  disabled={disabled}
                  onClick={onAddFolder}
                >
                  <FolderOpen size={12} aria-hidden="true" />
                  <span>{t('选择文件夹')}</span>
                  <ArrowRight size={12} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        </section>
      )}

      <header className="mission-masthead">
        <div className="mission-masthead-copy">
          <span className="blank-mark">
            <Wordmark />
          </span>
          <h1>{t('今天，想完成什么？')}</h1>
          <p>{t('说说你的目标，Rivloom 帮你一步步完成。')}</p>
        </div>
        <div className="mission-masthead-meta">
          <span className="mission-status-pill" title={t('集群就绪')}>
            <i className={`status-dot ${connected ? 'online' : ''}`} aria-hidden="true" />
            <span>{t('{{count}} 台在线', { count: onlineCount })}</span>
          </span>
          {modelName && (
            <span className="mission-model-pill" title={modelName}>
              <Cpu size={12} aria-hidden="true" />
              <span>{modelName}</span>
            </span>
          )}
        </div>
      </header>

      <section className="mission-cluster" aria-label={t('集群就绪')}>
        <div className="mission-section-head">
          <span className="mission-section-title">
            <Network size={13} aria-hidden="true" />
            <strong>{t('集群就绪')}</strong>
          </span>
          <span className="mission-section-actions">
            {owner && <small className="mission-drop-hint">{t('拖入文件可直派设备')}</small>}
            {owner && (
              <button type="button" className="mission-inline-link" onClick={onManageDevices}>
                {t('管理设备')}
              </button>
            )}
          </span>
        </div>

        <div className="mission-cluster-strip" role="group" aria-label={t('选择执行 Node')}>
          {owner && (
            <button
              type="button"
              className={`mission-node-pill is-auto${!targetNodeID ? ' is-selected' : ''}`}
              disabled={disabled}
              aria-pressed={!targetNodeID}
              title={t('自动分配到可用节点')}
              onClick={() => onRouteNode(null, null)}
            >
              <span className="mission-node-icon is-auto" aria-hidden="true">
                <Sparkles size={13} />
              </span>
              <span className="mission-node-copy">
                <strong>{t('自动调度')}</strong>
                <small>{t('{{count}} 台在线', { count: onlineCount })}</small>
              </span>
            </button>
          )}

          {clusterNodes.map((node) => {
            const isLocal = !!local && node.id === local.id;
            const online = isLocal ? connected : node.online && node.channelReady;
            const view = machineStatus(node, now, connected);
            const selected = targetNodeID === node.id;
            const dragOver = dragNodeID === node.id;
            const telemetry = !online
              ? t('离线')
              : view.cpu !== null
                ? `CPU ${Math.round(view.cpu)}% · ${view.label}`
                : view.label;
            const stateBadge = selected
              ? targetMode === 'locked'
                ? t('锁定')
                : t('首选')
              : isLocal && nodeDisplayName(node) !== t('本机')
                ? t('本机')
                : null;
            return (
              <button
                key={node.id}
                type="button"
                data-mission-node={node.id}
                className={`mission-node-pill${selected ? ` is-selected is-${targetMode}` : ''}${!online ? ' is-offline' : ''}${dragOver ? ' is-drop-target' : ''}`}
                disabled={disabled || !owner}
                aria-pressed={selected}
                title={
                  owner
                    ? `${nodeDisplayName(node)} · ${telemetry}\n${t('点击切换执行目标，或将文件直接拖到设备卡片上')}`
                    : `${nodeDisplayName(node)} · ${telemetry}`
                }
                onClick={() => {
                  if (!owner || disabled) return;
                  onRouteNode(node);
                }}
                onDragOver={(event) => {
                  if (!owner || disabled || !isFileTransfer(event.dataTransfer)) return;
                  if (dragNodeID !== node.id) setDragNodeID(node.id);
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setDragNodeID((current) => (current === node.id ? null : current));
                  }
                }}
                onDrop={(event) => {
                  setDragNodeID(null);
                  if (!owner || disabled || !isFileTransfer(event.dataTransfer)) return;
                  onRouteNode(node, isLocal ? 'locked' : 'preferred');
                }}
              >
                <span className="mission-node-avatar">
                  <NodeAvatar small icon={node.icon} name={node.name} />
                  <i className={`status-dot ${online ? 'online' : ''}`} aria-hidden="true" />
                </span>
                <span className="mission-node-copy">
                  <strong>{nodeDisplayName(node)}</strong>
                  <small>{telemetry}</small>
                </span>
                {stateBadge && (
                  <span className={`mission-node-badge${selected ? ' is-active' : ''}`}>
                    {stateBadge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </section>

      <div className="mission-launchpad">
        <section className="mission-panel mission-workspaces" aria-label={t('最近工作区')}>
          <div className="mission-section-head">
            <span className="mission-section-title">
              <FolderOpen size={13} aria-hidden="true" />
              <strong>{t('最近工作区')}</strong>
            </span>
            {owner && (
              <button
                type="button"
                className="mission-inline-link"
                disabled={disabled}
                onClick={onAddFolder}
              >
                <Plus size={12} aria-hidden="true" />
                {t('添加文件夹…')}
              </button>
            )}
          </div>
          {recentProjects.length > 0 ? (
            <div className="mission-workspace-list" role="group" aria-label={t('工作文件夹')}>
              {recentProjects.map((project) => {
                const active = project.id === projectID && (!targetNodeID || targetNodeID === local?.id);
                return (
                  <button
                    key={project.id}
                    type="button"
                    className={`mission-workspace-item${active ? ' is-active' : ''}`}
                    aria-pressed={active}
                    disabled={disabled}
                    title={project.directory}
                    onClick={() => onSelectProject(project.id)}
                  >
                    <FolderOpen size={14} aria-hidden="true" />
                    <span className="mission-workspace-copy">
                      <strong>{project.name}</strong>
                      <small>{compactPath(project.directory)}</small>
                    </span>
                    {active && (
                      <span className="mission-workspace-check" aria-label={t('当前使用')}>
                        <Check size={13} aria-hidden="true" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="mission-workspace-empty">
              {owner ? (
                <button
                  type="button"
                  className="mission-workspace-add"
                  disabled={disabled}
                  onClick={onAddFolder}
                >
                  <Plus size={14} aria-hidden="true" />
                  <span>{t('添加第一个工作文件夹')}</span>
                </button>
              ) : (
                <p>{t('工作文件夹')}</p>
              )}
            </div>
          )}
        </section>

        <section className="mission-panel mission-starters-col" aria-label={t('快捷任务')}>
          <div className="mission-section-head">
            <span className="mission-section-title">
              <Sparkles size={13} aria-hidden="true" />
              <strong>{t('快捷任务')}</strong>
            </span>
          </div>
          <ConversationStarters compact disabled={disabled} choose={onChooseStarter} />
        </section>
      </div>
    </div>
  );
}
