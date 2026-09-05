import { useState, type FormEvent } from 'react';
import {
  BrainCircuit,
  Check,
  Clock3,
  Fingerprint,
  FolderOpen,
  Inbox,
  Link2,
  Pencil,
  Radio,
  Send,
  ShieldCheck,
  ShieldX,
  WifiOff,
  X,
} from 'lucide-react';
import type {
  ApprovalMode,
  BrainTask,
  BrainTopology,
  NodeExecutionPolicy,
  NodeNetwork,
  NodePairing,
  Project,
  RemoteTaskControlAction,
  RemoteTaskInvite,
  RivloomNode,
} from '../shared/types';
import { stateLabels } from '../shared/types';
import { NodeAvatar } from './node-avatar';
import { nodeDisplayName } from './node-mentions';

const shortFingerprint = (value: string) => {
  const groups = value.split(':');
  return groups.length > 8
    ? `${groups.slice(0, 4).join(':')} ··· ${groups.slice(-4).join(':')}`
    : value;
};

type NetworkActions = {
  owner: boolean;
  busy: boolean;
  requestPairing(nodeID: string): void;
  confirmPairing(pairingID: string): void;
  cancelPairing(pairingID: string): void;
  revokeTrust(nodeID: string): void;
  editNodeRemark(nodeID: string): void;
  createRemoteTask(input: {
    title: string;
    description: string;
    criteria: string;
    requestedProjectID: string | null;
    requirements: {
      minimumLogicalCores?: number;
      minimumMemoryBytes?: number;
      gpu?: boolean;
      minimumGpuMemoryBytes?: number;
    };
  }): void;
  cancelRemoteTask(taskID: string): void;
  controlRemoteTask(
    taskID: string,
    expectedExecutionSequence: number,
    action: RemoteTaskControlAction,
  ): void;
  saveExecutionPolicy(input: {
    enabled: boolean;
    approvalMode: ApprovalMode;
    projectID: string | null;
    model: string | null;
  }): void;
};

function NodeCard({
  node,
  pairing,
  actions,
}: {
  node: RivloomNode;
  pairing?: NodePairing;
  actions: NetworkActions;
}) {
  return (
    <article className={`network-node-card ${node.local ? 'local' : ''}`}>
      <div className="network-node-heading">
        <NodeAvatar name={node.name} icon={node.icon} />
        <div>
          <span className="eyebrow">{node.local ? 'THIS DEVICE' : 'NEARBY NODE'}</span>
          <h3>{nodeDisplayName(node)}</h3>
        </div>
        <span className={`network-presence ${node.online ? 'online' : ''}`}>
          <i />
          {node.online ? '在线' : '离线'}
        </span>
      </div>
      <dl className="network-node-details">
        <div>
          <dt>Node ID</dt>
          <dd className="mono">{node.id}</dd>
        </div>
        <div>
          <dt>协议</dt>
          <dd>Rivloom Node v{node.protocolVersion}</dd>
        </div>
        <div>
          <dt>地址</dt>
          <dd className="mono">
            {node.addresses.length
              ? `${node.addresses.join(' / ')}:${node.port}`
              : `端口 ${node.port}`}
          </dd>
        </div>
      </dl>
      <div className="network-fingerprint">
        <Fingerprint size={16} />
        <span>
          <small>设备公钥指纹</small>
          <code>{shortFingerprint(node.fingerprint)}</code>
        </span>
      </div>
      <div className="brain-list">
        {node.brains.map((brain) => (
          <span className="brain-chip" key={brain.id} title={brain.id}>
            <BrainCircuit size={14} />
            {brain.name}
          </span>
        ))}
      </div>
      <div className={`node-trust ${node.trusted ? 'trusted' : ''}`}>
        <ShieldCheck size={16} />
        {node.local
          ? '本机身份已由 Windows DPAPI 保护'
          : node.trusted
            ? node.channelReady
              ? '已建立设备信任 · 加密通道就绪'
              : '已建立设备信任 · 正在建立加密通道'
            : '签名身份已验证，尚未配对授权'}
      </div>
      {!node.local && (
        <div className="node-pairing">
          {node.trusted ? (
            <>
              <div className="node-pairing-actions trusted-actions">
                <span>双方已确认此设备身份，信任记录保存在本机。</span>
                {actions.owner && (
                  <div className="trusted-task-actions">
                    <button
                      className="button compact"
                      disabled={actions.busy}
                      onClick={() => actions.editNodeRemark(node.id)}
                    >
                      <Pencil size={14} />
                      编辑备注名
                    </button>
                    <button
                      className="button danger compact"
                      disabled={actions.busy}
                      onClick={() => actions.revokeTrust(node.id)}
                    >
                      <ShieldX size={14} />
                      撤销信任
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : pairing ? (
            <div className="pairing-request">
              <div className="pairing-request-heading">
                <span>
                  <Link2 size={14} />
                  {pairing.direction === 'incoming' ? '对方请求配对' : '已发起配对'}
                </span>
                <small>有效至 {new Date(pairing.expiresAt).toLocaleTimeString('zh-CN')}</small>
              </div>
              <strong className="pairing-code" aria-label={`配对码 ${pairing.code}`}>
                {pairing.code.slice(0, 3)} <i /> {pairing.code.slice(3)}
              </strong>
              <p>
                {pairing.localConfirmed
                  ? '本机已确认，等待对方在其设备确认。'
                  : pairing.remoteConfirmed
                    ? '对方已确认。请核对两台设备短码和指纹一致后确认。'
                    : '请在两台设备核对短码和公钥指纹，双方都确认后才会建立信任。'}
              </p>
              {actions.owner && (
                <div className="node-pairing-buttons">
                  <button
                    className="button primary compact"
                    disabled={actions.busy || pairing.localConfirmed || !node.online}
                    onClick={() => actions.confirmPairing(pairing.id)}
                  >
                    <Check size={14} />
                    {pairing.localConfirmed ? '已确认' : '短码一致，确认'}
                  </button>
                  <button
                    className="button compact"
                    disabled={actions.busy}
                    onClick={() => actions.cancelPairing(pairing.id)}
                  >
                    <X size={14} />
                    取消
                  </button>
                </div>
              )}
            </div>
          ) : actions.owner ? (
            <button
              className="button compact pair-node-button"
              disabled={actions.busy || !node.online}
              onClick={() => actions.requestPairing(node.id)}
            >
              <Link2 size={14} />
              与此设备配对
            </button>
          ) : (
            <p className="pairing-owner-note">只有本机所有者可以管理设备信任。</p>
          )}
        </div>
      )}
    </article>
  );
}

const remoteTaskStatus: Record<RemoteTaskInvite['status'], string> = {
  pending: '正在接收',
  accepted: '已接受',
  declined: '已拒绝',
  cancelled: '已取消',
  expired: '已过期',
};

const bytes = (value: number | null) => {
  if (value === null) return '未知';
  const gib = value / 1024 ** 3;
  return gib >= 10 ? `${Math.round(gib)} GB` : `${gib.toFixed(1)} GB`;
};

function BrainTopologyCard({ brain, localNodeID }: { brain: BrainTopology; localNodeID?: string }) {
  return (
    <article className={`brain-topology-card ${brain.online ? 'online' : 'paused'}`}>
      <header>
        <div>
          <span className="eyebrow">{brain.hosted ? 'HOSTED BRAIN' : 'REGISTERED BRAIN'}</span>
          <h3>{brain.name}</h3>
        </div>
        <span className={`network-presence ${brain.online ? 'online' : ''}`}>
          <i />
          {brain.state === 'provisional' ? '形成中' : brain.online ? '可调度' : '已暂停'}
        </span>
      </header>
      <dl className="brain-topology-details">
        <div>
          <dt>Master Host</dt>
          <dd className="mono">
            {brain.masterNodeID === localNodeID ? '本机 · ' : ''}
            {brain.masterNodeID}
          </dd>
        </div>
        <div>
          <dt>Brain ID</dt>
          <dd className="mono">{brain.id}</dd>
        </div>
        <div>
          <dt>任务队列</dt>
          <dd>{brain.queueDepth} 个未结束任务</dd>
        </div>
      </dl>
      <div className="brain-worker-list">
        {brain.workers.length ? (
          brain.workers.map((worker) => {
            const fresh = Date.now() - Date.parse(worker.load.sampledAt) <= 30_000;
            return (
              <article key={worker.nodeID} className={!fresh ? 'stale' : ''}>
                <div className="brain-worker-heading">
                  <strong>
                    Worker {worker.nodeID === localNodeID ? '本机' : worker.nodeID.slice(0, 8)}
                  </strong>
                  <span>{fresh ? `${worker.load.availableSlots} 个可用槽位` : '报告已过期'}</span>
                </div>
                <p>
                  {worker.hardware.cpuModel} · {worker.hardware.logicalCores} 线程 · 内存{' '}
                  {bytes(worker.hardware.memoryBytes)}
                </p>
                <p>
                  CPU{' '}
                  {worker.load.cpuPercent === null
                    ? '未知'
                    : `${Math.round(worker.load.cpuPercent)}%`}
                  {' · '}内存 {Math.round(worker.load.memoryUsedPercent)}%{' · '}磁盘可用{' '}
                  {bytes(worker.load.diskAvailableBytes)}
                </p>
                <p>
                  GPU{' '}
                  {worker.hardware.gpus.length
                    ? worker.hardware.gpus
                        .map(
                          (gpu) =>
                            `${gpu.name}${gpu.memoryBytes ? ` ${bytes(gpu.memoryBytes)}` : ''}`,
                        )
                        .join(' / ')
                    : '无或未检测到'}
                </p>
                <small>
                  {worker.projects.length
                    ? `授权项目：${worker.projects.map((project) => project.name).join('、')}`
                    : '没有对 Brain 公开项目资源'}
                  {' · '}采样 {new Date(worker.load.sampledAt).toLocaleTimeString('zh-CN')}
                </small>
              </article>
            );
          })
        ) : (
          <p className="brain-worker-empty">当前没有带可用槽位的受信 Worker 报告。</p>
        )}
      </div>
    </article>
  );
}

function ScheduledTaskForm({
  network,
  actions,
}: {
  network: NodeNetwork;
  actions: NetworkActions;
}) {
  const hostsBrain = network.brains.some((brain) => brain.hosted);
  const remoteProjects = [
    ...new Map(
      network.brains.flatMap((brain) =>
        brain.workers
          .filter((worker) => !hostsBrain || worker.nodeID !== network.local?.id)
          .flatMap((worker) =>
            worker.projects.map(
              (project) => [project.id, { ...project, nodeID: worker.nodeID }] as const,
            ),
          ),
      ),
    ).values(),
  ];
  const eligible = network.brains.some(
    (brain) =>
      brain.state === 'established' &&
      brain.online &&
      brain.workers.some(
        (worker) =>
          (!brain.hosted || worker.nodeID !== network.local?.id) && worker.load.availableSlots > 0,
      ),
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const integer = (name: string) => {
      const value = Number(data.get(name));
      return Number.isSafeInteger(value) && value > 0 ? value : undefined;
    };
    const memoryGB = integer('minimumMemoryGB');
    const gpuMemoryGB = integer('minimumGpuMemoryGB');
    actions.createRemoteTask({
      title: String(data.get('title') || ''),
      description: String(data.get('description') || ''),
      criteria: String(data.get('criteria') || ''),
      requestedProjectID: String(data.get('requestedProjectID') || '') || null,
      requirements: {
        minimumLogicalCores: integer('minimumLogicalCores'),
        minimumMemoryBytes: memoryGB ? memoryGB * 1024 ** 3 : undefined,
        gpu: data.get('gpu') === 'on' ? true : undefined,
        minimumGpuMemoryBytes: gpuMemoryGB ? gpuMemoryGB * 1024 ** 3 : undefined,
      },
    });
    event.currentTarget.reset();
  };
  return (
    <form className="remote-task-form scheduled-task-form" onSubmit={submit}>
      <div>
        <span className="eyebrow">AUTOMATIC PLACEMENT</span>
        <strong>创建由 Brain 自动安排的任务</strong>
        <p>
          系统会先按在线 Brain、项目位置、真实硬件和实时槽位选择
          Worker，再固定任务归属；提交后不会迁移到另一个 Brain。
        </p>
      </div>
      <label>
        <span>任务标题</span>
        <input name="title" required maxLength={120} />
      </label>
      <label>
        <span>项目资源</span>
        <select name="requestedProjectID" defaultValue="">
          <option value="">Portable Task（执行节点创建隔离临时文件夹）</option>
          {remoteProjects.map((project) => (
            <option value={project.id} key={project.id}>
              {project.name} · Node {project.nodeID.slice(0, 8)}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>任务说明</span>
        <textarea name="description" required maxLength={4000} rows={3} />
      </label>
      <label>
        <span>验收标准</span>
        <textarea name="criteria" required maxLength={2000} rows={2} />
      </label>
      <div className="scheduled-requirements">
        <label>
          <span>最少 CPU 线程</span>
          <input name="minimumLogicalCores" type="number" min="1" step="1" />
        </label>
        <label>
          <span>最少内存（GB）</span>
          <input name="minimumMemoryGB" type="number" min="1" step="1" />
        </label>
        <label>
          <span>最少显存（GB）</span>
          <input name="minimumGpuMemoryGB" type="number" min="1" step="1" />
        </label>
        <label className="checkbox">
          <input name="gpu" type="checkbox" />
          必须有 GPU
        </label>
      </div>
      <div className="remote-task-buttons">
        <button
          className="button primary compact"
          disabled={actions.busy || !eligible}
          type="submit"
        >
          <Send size={14} />
          自动选择 Brain 与 Worker
        </button>
        <small>
          {eligible ? '模型与凭据由最终 Worker 在本机复核。' : '暂无带可用槽位的匹配 Worker。'}
        </small>
      </div>
    </form>
  );
}

const brainTaskStatus: Record<BrainTask['status'], string> = {
  submitting: '正在提交 Master',
  queued: 'Master 队列中',
  assigned: '已分配 Worker',
  running: '正在执行',
  waiting: '等待处理',
  review: '等待验收',
  completed: '已完成',
  failed: '执行失败',
};

function BrainTaskCard({ task, network }: { task: BrainTask; network: NodeNetwork }) {
  const brain = network.brains.find((candidate) => candidate.id === task.brainID);
  return (
    <article className={`remote-task-card brain-task-card status-${task.status}`}>
      <div className="remote-task-heading">
        <span className="remote-task-icon">
          <BrainCircuit size={18} />
        </span>
        <div>
          <span className="eyebrow">
            {task.direction === 'owned' ? 'AUTHORITATIVE BRAIN TASK' : 'SUBMITTED BRAIN TASK'}
          </span>
          <h3>{task.title}</h3>
        </div>
        <span className="remote-task-status">{brainTaskStatus[task.status]}</span>
      </div>
      <p className="remote-task-description">{task.description}</p>
      <div className="remote-task-criteria">
        <strong>验收标准</strong>
        <p>{task.criteria}</p>
      </div>
      <div className="remote-task-meta">
        <span>
          <BrainCircuit size={13} />
          {brain?.name || `Brain ${task.brainID.slice(0, 6)}`}
        </span>
        <span>Master {task.masterNodeID.slice(0, 8)}</span>
        <span>
          {task.selectedWorkerID ? `Worker ${task.selectedWorkerID.slice(0, 8)}` : '等待 Worker'}
        </span>
        <span>{task.requestedProjectID ? 'Project Task' : 'Portable Task'}</span>
      </div>
      {task.executionAttempt > 0 && (
        <div className="remote-task-boundary">
          <strong>Task 与 Execution 已分离</strong>
          <p>
            Task {task.id.slice(0, 8)} · 第 {task.executionAttempt} 次尝试 · Execution{' '}
            {task.executionID ? task.executionID.slice(0, 8) : '等待重新分配'} · 序号{' '}
            {task.executionSequence}
          </p>
          {task.executions.length > 1 && (
            <p>
              历史：
              {task.executions
                .map(
                  (execution) =>
                    `#${execution.attempt} ${execution.executionID.slice(0, 8)} / Worker ${execution.workerNodeID.slice(0, 8)} / ${brainTaskStatus[execution.status]}`,
                )
                .join('；')}
            </p>
          )}
          {task.retryNotBefore && Date.parse(task.retryNotBefore) > Date.now() && (
            <p>原 Worker 冷却至 {new Date(task.retryNotBefore).toLocaleTimeString('zh-CN')}。</p>
          )}
        </div>
      )}
      {task.executionSummary && <p className="remote-task-description">{task.executionSummary}</p>}
      {task.deliveryError && <p className="error remote-task-error">{task.deliveryError}</p>}
    </article>
  );
}

function ExecutionPolicyCard({
  policy,
  projects,
  models,
  actions,
}: {
  policy: NodeExecutionPolicy;
  projects: Project[];
  models: { id: string; name: string }[];
  actions: NetworkActions;
}) {
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>(policy.approvalMode);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    actions.saveExecutionPolicy({
      enabled: true,
      approvalMode,
      projectID: String(data.get('projectID') || '') || null,
      model: String(data.get('model') || '') || null,
    });
  };
  return (
    <article className="remote-preparation-form execution-policy-form">
      <div>
        <span className="eyebrow">LOCAL EXECUTION CAPABILITY</span>
        <strong>{policy.enabled ? '本机执行能力已开放' : '本机执行能力已关闭'}</strong>
        <p>
          旧版受信邀请可接收后等待；自动调度只在能力开放且有空闲槽位时接受执行。
          模型和审批模式由本机管理，路径与凭据不外传。Portable 任务使用独立普通文件夹。
        </p>
      </div>
      <form onSubmit={submit}>
        <label>
          <span>AI 审批模式</span>
          <select
            name="approvalMode"
            value={approvalMode}
            onChange={(event) => setApprovalMode(event.target.value as ApprovalMode)}
          >
            <option value="ask">请求批准（默认）</option>
            <option value="auto">帮我批准</option>
            <option value="full">允许任何操作</option>
          </select>
          <small>
            {approvalMode === 'ask'
              ? '修改、命令和联网操作等待指定审批人处理。'
              : approvalMode === 'auto'
                ? '项目内修改和命令自动批准；联网操作仍会询问。'
                : '文件、命令、联网和项目外目录自动批准。敏感凭据与子代理仍禁止。'}
          </small>
        </label>
        <label>
          <span>本机项目</span>
          <select
            name="projectID"
            required
            defaultValue={policy.projectID || projects[0]?.id || ''}
          >
            {!projects.length && <option value="">请先添加本地项目</option>}
            {projects.map((project) => (
              <option value={project.id} key={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>执行模型</span>
          <select name="model" required defaultValue={policy.model || models[0]?.id || ''}>
            {!models.length && <option value="">请先连接本机模型</option>}
            {models.map((model) => (
              <option value={model.id} key={model.id}>
                {model.name}
              </option>
            ))}
          </select>
        </label>
        <label className="checkbox remote-preparation-confirmation">
          <input type="checkbox" required />
          我确认所有已配对设备都可把任务交给该项目；模型请求可能包含任务说明和项目代码。
        </label>
        <div className="remote-task-buttons">
          <button
            className="button primary compact"
            type="submit"
            disabled={actions.busy || !projects.length || !models.length}
          >
            <FolderOpen size={14} />
            {policy.enabled ? '保存执行设置' : '开启执行能力'}
          </button>
          {policy.enabled && (
            <button
              className="button danger compact"
              type="button"
              disabled={actions.busy}
              onClick={() =>
                actions.saveExecutionPolicy({
                  enabled: false,
                  approvalMode: 'ask',
                  projectID: null,
                  model: null,
                })
              }
            >
              关闭执行能力
            </button>
          )}
        </div>
      </form>
    </article>
  );
}

function RemoteTaskCard({
  task,
  network,
  actions,
}: {
  task: RemoteTaskInvite;
  network: NodeNetwork;
  actions: NetworkActions;
}) {
  const peerID = task.direction === 'incoming' ? task.ownerNodeID : task.targetNodeID;
  const peer = network.nearby.find((node) => node.id === peerID);
  const brainID = task.direction === 'incoming' ? task.ownerBrainID : task.targetBrainID;
  const brain = network.brains.find((item) => item.id === brainID);
  return (
    <article className={`remote-task-card ${task.direction} status-${task.status}`}>
      <div className="remote-task-heading">
        <span className="remote-task-icon">
          {task.direction === 'incoming' ? <Inbox size={18} /> : <Send size={18} />}
        </span>
        <div>
          <span className="eyebrow">
            {task.direction === 'incoming'
              ? 'INCOMING COLLABORATION TASK'
              : 'OUTGOING COLLABORATION TASK'}
          </span>
          <h3>{task.title}</h3>
        </div>
        <span className={`remote-task-status status-${task.status}`}>
          {task.executionSequence > 0 && task.executionState !== 'not_started'
            ? stateLabels[task.executionState]
            : task.deliveryPending
              ? '正在同步'
              : remoteTaskStatus[task.status]}
        </span>
      </div>
      <p className="remote-task-description">{task.description}</p>
      <div className="remote-task-criteria">
        <strong>验收标准</strong>
        <p>{task.criteria}</p>
      </div>
      <div className="remote-task-meta">
        <span>
          <BrainCircuit size={13} />
          {brain?.name || `Brain ${brainID.slice(0, 6)}`}
        </span>
        <span>Worker {task.targetNodeID.slice(0, 8)}</span>
        <span>{task.requestedProjectID ? '节点本地 Project Task' : 'Portable Task'}</span>
        <span>
          <Clock3 size={13} />
          {new Date(task.expiresAt).toLocaleString('zh-CN')} 前有效
        </span>
      </div>
      {task.deliveryError && <p className="remote-task-error">{task.deliveryError}</p>}
      {!task.automaticEligible && (
        <p className="remote-task-boundary">
          这是旧版准备流程记录，只保留用于迁移和审计，不会按新策略自动执行。
        </p>
      )}
      {task.executionSequence > 0 && (
        <div className="remote-task-boundary">
          <strong>执行节点状态 · #{task.executionSequence}</strong>
          <p>
            {task.executionSummary ||
              stateLabels[task.executionState === 'not_started' ? 'ready' : task.executionState]}
          </p>
        </div>
      )}
      {task.direction === 'outgoing' &&
        task.executionSequence > 0 &&
        (task.remoteDiffSource || task.remoteArtifacts.length > 0) && (
          <section className="remote-result-card">
            <div className="remote-result-heading">
              <strong>执行结果与官方差异</strong>
              <span>
                {task.remoteArtifacts.length} 个文件 ·{' '}
                {task.remoteDiffSource || '执行节点未提供差异来源'}
              </span>
            </div>
            {task.remoteArtifacts.length > 0 ? (
              <div className="remote-artifact-list">
                {task.remoteArtifacts.map((artifact, index) => (
                  <article key={`${artifact.file}-${index}`}>
                    <div>
                      <strong>{artifact.file}</strong>
                      <span>
                        +{artifact.additions} −{artifact.deletions} · {artifact.status}
                      </span>
                    </div>
                    <pre>{artifact.patch}</pre>
                  </article>
                ))}
              </div>
            ) : (
              <p>
                OpenCode 没有返回可展示的会话差异。Rivloom
                不扫描或哈希执行机文件夹；验收前请结合执行摘要，必要时让执行机参与者直接检查本地文件。
              </p>
            )}
          </section>
        )}
      {task.direction === 'outgoing' && task.remoteApprovals.length > 0 && (
        <div className="remote-intervention-list">
          {task.remoteApprovals.map((approval) => (
            <section className="approval-card remote-approval-card" key={approval.id}>
              <div className="approval-title">
                <span>
                  <ShieldCheck size={20} />
                </span>
                <div>
                  <strong>执行节点请求操作批准</strong>
                  <p>
                    {approval.permission === 'edit'
                      ? '修改文件'
                      : approval.permission === 'bash'
                        ? '执行命令'
                        : approval.permission}
                  </p>
                </div>
              </div>
              <pre>{approval.patterns.join('\n') || '未提供可展示的操作内容'}</pre>
              <div className="approval-footer">
                <small>本机项目根目录已显示为 &lt;project&gt;。只授权这一项请求。</small>
                {actions.owner && (
                  <div className="action-group">
                    <button
                      className="button compact"
                      disabled={actions.busy || task.controlPending || task.deliveryPending}
                      onClick={() =>
                        actions.controlRemoteTask(task.id, task.executionSequence, {
                          kind: 'permission',
                          requestID: approval.id,
                          reply: 'reject',
                        })
                      }
                    >
                      拒绝
                    </button>
                    <button
                      className="button primary compact"
                      disabled={actions.busy || task.controlPending || task.deliveryPending}
                      onClick={() =>
                        actions.controlRemoteTask(task.id, task.executionSequence, {
                          kind: 'permission',
                          requestID: approval.id,
                          reply: 'once',
                        })
                      }
                    >
                      <Check size={14} />
                      仅本次允许
                    </button>
                  </div>
                )}
              </div>
            </section>
          ))}
        </div>
      )}
      {task.direction === 'outgoing' && task.remoteQuestions.length > 0 && (
        <div className="remote-intervention-list">
          {task.remoteQuestions.map((request) => (
            <section className="approval-card remote-question-card" key={request.id}>
              <h3>执行节点上的 AI 需要补充信息</h3>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  actions.controlRemoteTask(task.id, task.executionSequence, {
                    kind: 'question',
                    requestID: request.id,
                    answers: request.questions.map((_, index) => [
                      String(form.get(`remote-answer-${index}`) || ''),
                    ]),
                  });
                }}
              >
                {request.questions.map((question, index) => (
                  <label key={`${request.id}-${index}`}>
                    <span>{question.question}</span>
                    {question.options.length > 0 && (
                      <small>
                        {question.options
                          .map((option) => `${option.label}：${option.description}`)
                          .join('；')}
                      </small>
                    )}
                    <input
                      name={`remote-answer-${index}`}
                      required
                      maxLength={4000}
                      placeholder="输入给 AI 的答案"
                      disabled={!actions.owner}
                    />
                  </label>
                ))}
                {actions.owner && (
                  <button
                    className="button primary compact"
                    type="submit"
                    disabled={actions.busy || task.controlPending || task.deliveryPending}
                  >
                    回复 AI
                  </button>
                )}
              </form>
            </section>
          ))}
        </div>
      )}
      {task.automaticEligible && task.status === 'accepted' && task.executionSequence === 0 && (
        <p className="remote-task-boundary">
          {task.direction === 'incoming'
            ? '任务已接受，正在等待本机项目空闲、模型就绪和加密通道可用；满足条件后会自动启动一次。'
            : '对方已接受任务，正在等待其本机执行能力和项目可用。'}
        </p>
      )}
      {actions.owner &&
        task.direction === 'outgoing' &&
        ['running', 'waiting_approval', 'waiting_input', 'interrupted'].includes(
          task.executionState,
        ) && (
          <div className="remote-task-buttons">
            <button
              className="button danger compact"
              disabled={actions.busy || task.controlPending || task.deliveryPending}
              onClick={() =>
                actions.controlRemoteTask(task.id, task.executionSequence, { kind: 'stop' })
              }
            >
              <X size={14} />
              停止远端执行
            </button>
            <small>停止不会回滚执行节点已经完成的修改。</small>
          </div>
        )}
      {actions.owner &&
        task.direction === 'outgoing' &&
        peer?.capabilities.includes('remote-results-v1') &&
        [
          'running',
          'waiting_approval',
          'waiting_input',
          'stopped',
          'interrupted',
          'failed',
          'review',
        ].includes(task.executionState) && (
          <details className="remote-followup">
            <summary>
              {task.executionState === 'review' ? '退回修改并继续' : '补充任务要求'}
            </summary>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                actions.controlRemoteTask(task.id, task.executionSequence, {
                  kind: 'supplement',
                  text: String(form.get('remote-supplement') || ''),
                });
              }}
            >
              <textarea
                name="remote-supplement"
                required
                maxLength={12000}
                rows={4}
                placeholder="补充新的约束、修改意见或验收要求…"
              />
              <button
                className="button primary compact"
                type="submit"
                disabled={actions.busy || task.controlPending || task.deliveryPending}
              >
                {task.executionState === 'review' ? '退回并继续执行' : '发送补充要求'}
              </button>
            </form>
          </details>
        )}
      {actions.owner &&
        task.direction === 'outgoing' &&
        task.executionState === 'review' &&
        peer?.capabilities.includes('remote-results-v1') && (
          <form
            className="remote-acceptance-form"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              actions.controlRemoteTask(task.id, task.executionSequence, {
                kind: 'accept',
                note: String(form.get('remote-acceptance-note') || ''),
              });
            }}
          >
            <strong>归属 Brain 验收</strong>
            <textarea
              name="remote-acceptance-note"
              required
              maxLength={4000}
              rows={3}
              placeholder="记录已核对的结果、测试和限制…"
            />
            <label>
              <input type="checkbox" required />
              我已根据可见差异、执行摘要和验收标准核对本次交付；验收不会提交、推送或部署。
            </label>
            <button
              className="button primary compact"
              type="submit"
              disabled={actions.busy || task.controlPending || task.deliveryPending}
            >
              <Check size={14} />
              确认远程验收
            </button>
          </form>
        )}
      {actions.owner &&
        task.direction === 'outgoing' &&
        task.executionSequence === 0 &&
        (task.status === 'pending' || (task.status === 'accepted' && !task.brainTaskID)) && (
          <div className="remote-task-buttons">
            <button
              className="button danger compact"
              disabled={actions.busy || task.deliveryPending}
              onClick={() => actions.cancelRemoteTask(task.id)}
            >
              <X size={14} />
              取消任务
            </button>
          </div>
        )}
    </article>
  );
}

export function NodeNetworkView({
  conversationsInSidebar = false,
  network,
  owner,
  projects,
  models,
  executionPolicy,
  busy,
  onRequestPairing,
  onConfirmPairing,
  onCancelPairing,
  onRevokeTrust,
  onEditNodeRemark,
  onCreateRemoteTask,
  onCancelRemoteTask,
  onControlRemoteTask,
  onSaveExecutionPolicy,
}: {
  conversationsInSidebar?: boolean;
  network: NodeNetwork;
  owner: boolean;
  projects: Project[];
  models: { id: string; name: string }[];
  executionPolicy: NodeExecutionPolicy;
  busy: boolean;
  onRequestPairing(nodeID: string): void;
  onConfirmPairing(pairingID: string): void;
  onCancelPairing(pairingID: string): void;
  onRevokeTrust(nodeID: string): void;
  onEditNodeRemark(nodeID: string): void;
  onCreateRemoteTask(input: Parameters<NetworkActions['createRemoteTask']>[0]): void;
  onCancelRemoteTask(taskID: string): void;
  onControlRemoteTask(
    taskID: string,
    expectedExecutionSequence: number,
    action: RemoteTaskControlAction,
  ): void;
  onSaveExecutionPolicy(input: {
    enabled: boolean;
    approvalMode: ApprovalMode;
    projectID: string | null;
    model: string | null;
  }): void;
}) {
  const online = network.status === 'online';
  const onlineNearby = network.nearby.filter((node) => node.online);
  const offlineNearby = network.nearby.length - onlineNearby.length;
  const actions: NetworkActions = {
    owner,
    busy,
    requestPairing: onRequestPairing,
    confirmPairing: onConfirmPairing,
    cancelPairing: onCancelPairing,
    revokeTrust: onRevokeTrust,
    editNodeRemark: onEditNodeRemark,
    createRemoteTask: onCreateRemoteTask,
    cancelRemoteTask: onCancelRemoteTask,
    controlRemoteTask: onControlRemoteTask,
    saveExecutionPolicy: onSaveExecutionPolicy,
  };
  return (
    <>
      <div className="page-heading network-page-heading">
        <div>
          <span className="eyebrow">LOCAL-FIRST INTELLIGENCE</span>
          <h1>
            节点与 Brain<span className="heading-dot">.</span>
          </h1>
          <p>Brain 自动形成并保持独立；受信 Node 可同时为多个 Brain 提供执行资源。</p>
        </div>
        <div className={`discovery-status ${online ? 'online' : ''}`}>
          {online ? <Radio size={18} /> : <WifiOff size={18} />}
          <span>
            {online ? '正在自动发现' : network.status === 'disabled' ? '发现已关闭' : '发现受限'}
            <small>{network.serviceType}</small>
          </span>
        </div>
      </div>

      {network.error && <div className="error network-error">{network.error}</div>}

      <div className="network-overview">
        <div>
          <strong>{network.local ? 1 + onlineNearby.length : onlineNearby.length}</strong>
          <span>在线节点</span>
        </div>
        <div>
          <strong>{network.brains.length}</strong>
          <span>可见 Brain</span>
        </div>
        <div>
          <strong>{onlineNearby.filter((node) => node.trusted).length}</strong>
          <span>受信邻居</span>
        </div>
      </div>

      <section className="network-section">
        <div className="section-title">
          <div>
            <span className="eyebrow">IDENTITY</span>
            <h2>本机节点</h2>
          </div>
          <p>稳定身份随安装数据保留，私钥不会广播。</p>
        </div>
        {network.local ? (
          <div className="network-grid single">
            <NodeCard node={network.local} actions={actions} />
          </div>
        ) : (
          <div className="network-empty compact">
            <WifiOff size={28} />
            <p>节点身份尚未就绪，本机任务仍可继续使用。</p>
          </div>
        )}
      </section>

      <section className="network-section">
        <div className="section-title">
          <div>
            <span className="eyebrow">CONTROL PLANES & RESOURCES</span>
            <h2>Brain 拓扑与共享 Worker</h2>
          </div>
          <p>每个 Brain 固定一个 Master Host；同一 Worker 可直接注册给多个 Brain。</p>
        </div>
        {network.brains.length ? (
          <div className="brain-topology-grid">
            {network.brains.map((brain) => (
              <BrainTopologyCard brain={brain} localNodeID={network.local?.id} key={brain.id} />
            ))}
          </div>
        ) : (
          <div className="network-empty compact">
            <p>正在自动形成 Brain；这里不需要创建或加入按钮。</p>
          </div>
        )}
      </section>

      {owner && !conversationsInSidebar && (
        <section className="network-section">
          <div className="section-title">
            <div>
              <span className="eyebrow">BRAIN-OWNED TASK</span>
              <h2>自动安排跨节点任务</h2>
            </div>
            <p>任务只属于一个 Brain；Brain 之间暂不传递或共同管理任务。</p>
          </div>
          <ScheduledTaskForm network={network} actions={actions} />
        </section>
      )}

      {owner && (
        <section className="network-section">
          <div className="section-title">
            <div>
              <span className="eyebrow">CAPABILITY POLICY</span>
              <h2>本机执行能力</h2>
            </div>
            <p>{executionPolicy.enabled ? '已按本机设置开放' : '已关闭；可信任务仍会接收并等待'}</p>
          </div>
          <ExecutionPolicyCard
            key={executionPolicy.updatedAt || 'new-policy'}
            policy={executionPolicy}
            projects={projects}
            models={models}
            actions={actions}
          />
        </section>
      )}

      <section className="network-section">
        <div className="section-title">
          <div>
            <span className="eyebrow">DISCOVERY</span>
            <h2>附近节点</h2>
          </div>
          <p>
            {network.nearby.length
              ? offlineNearby
                ? `${onlineNearby.length} 个在线，${offlineNearby} 个离线`
                : `发现 ${onlineNearby.length} 个在线签名节点`
              : '等待同网段 Rivloom 出现'}
          </p>
        </div>
        {network.nearby.length ? (
          <div className="network-grid">
            {network.nearby.map((node) => (
              <NodeCard
                node={node}
                pairing={network.pairings.find((pairing) => pairing.nodeID === node.id)}
                actions={actions}
                key={node.id}
              />
            ))}
          </div>
        ) : (
          <div className="network-empty">
            <span className="discovery-radar">
              <i />
              <Radio size={28} />
            </span>
            <h3>正在寻找附近的 Rivloom</h3>
            <p>
              保持另一台设备上的 Rivloom 打开，并允许 Windows
              专用网络通信。发现只交换匿名节点标识、公开指纹和 Brain 能力。
            </p>
          </div>
        )}
      </section>

      {!conversationsInSidebar && (
        <section className="network-section remote-task-section">
          <div className="section-title">
            <div>
              <span className="eyebrow">BRAIN TASKS</span>
              <h2>Brain 权威任务</h2>
            </div>
            <p>
              {network.brainTasks.length ? `${network.brainTasks.length} 条稳定 Task` : '尚无 Task'}
            </p>
          </div>
          {network.brainTasks.length ? (
            <div className="remote-task-grid">
              {network.brainTasks.map((task) => (
                <BrainTaskCard task={task} network={network} key={task.id} />
              ))}
            </div>
          ) : (
            <div className="network-empty compact remote-task-empty">
              <BrainCircuit size={26} />
              <p>创建任务后，提交节点先固定 Brain；Master 保存权威 Task 并创建独立 Execution。</p>
            </div>
          )}
        </section>
      )}

      {!conversationsInSidebar && (
        <section className="network-section remote-task-section">
          <div className="section-title">
            <div>
              <span className="eyebrow">EXECUTION TRANSPORT</span>
              <h2>执行与兼容记录</h2>
            </div>
            <p>
              {network.remoteTasks.length ? `${network.remoteTasks.length} 条持久记录` : '尚无邀请'}
            </p>
          </div>
          {network.remoteTasks.length ? (
            <div className="remote-task-grid">
              {network.remoteTasks.map((task) => (
                <RemoteTaskCard task={task} network={network} actions={actions} key={task.id} />
              ))}
            </div>
          ) : (
            <div className="network-empty compact remote-task-empty">
              <Inbox size={26} />
              <p>与受信节点建立加密通道后，可以发出协作任务；对方会按自己的执行设置处理。</p>
            </div>
          )}
        </section>
      )}

      <div className="collaboration-note network-boundary">
        <ShieldCheck size={25} />
        <div>
          <h3>设备信任与 AI 审批分开管理</h3>
          <p>
            受信任务会自动接收，本机执行开关决定是否开始，AI
            审批模式决定哪些操作询问。远程审批和回答只经过加密任务通道，不开放本机项目路径、模型凭据或通用
            OpenCode 接口。
          </p>
        </div>
      </div>
    </>
  );
}
