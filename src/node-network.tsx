import { useState, type FormEvent } from 'react';
import {
  BrainCircuit,
  Check,
  Clock3,
  Fingerprint,
  Inbox,
  Link2,
  Radio,
  Send,
  ShieldCheck,
  ShieldX,
  WifiOff,
  X,
} from 'lucide-react';
import type { NodeNetwork, NodePairing, RemoteTaskInvite, RivloomNode } from '../shared/types';

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
  createRemoteTask(
    nodeID: string,
    targetBrainID: string,
    input: { title: string; description: string; criteria: string },
  ): void;
  respondRemoteTask(taskID: string, decision: 'accepted' | 'declined'): void;
  cancelRemoteTask(taskID: string): void;
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
  const [taskForm, setTaskForm] = useState(false);
  const submitRemoteTask = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const targetBrainID = node.brains[0]?.id;
    if (!targetBrainID) return;
    const value = Object.fromEntries(new FormData(event.currentTarget));
    actions.createRemoteTask(node.id, targetBrainID, {
      title: String(value.title || ''),
      description: String(value.description || ''),
      criteria: String(value.criteria || ''),
    });
    event.currentTarget.reset();
    setTaskForm(false);
  };
  return (
    <article className={`network-node-card ${node.local ? 'local' : ''}`}>
      <div className="network-node-heading">
        <span className="network-node-icon">
          <BrainCircuit size={22} />
        </span>
        <div>
          <span className="eyebrow">{node.local ? 'THIS DEVICE' : 'NEARBY NODE'}</span>
          <h3>{node.name}</h3>
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
                      className="button primary compact"
                      disabled={actions.busy || !node.channelReady || !node.brains.length}
                      onClick={() => setTaskForm((visible) => !visible)}
                    >
                      <Send size={14} />
                      发起协作任务
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
              {taskForm && (
                <form className="remote-task-form" onSubmit={submitRemoteTask}>
                  <div>
                    <span className="eyebrow">ENCRYPTED TASK INVITE</span>
                    <strong>向 {node.brains[0]?.name} 发出任务邀请</strong>
                    <p>
                      先由对方人工接受；此步骤不会传项目路径、选择模型或启动
                      AI。不要填写密码、密钥或生产敏感信息。
                    </p>
                  </div>
                  <label>
                    <span>任务标题</span>
                    <input name="title" required maxLength={120} />
                  </label>
                  <label>
                    <span>任务说明</span>
                    <textarea name="description" required maxLength={4000} rows={3} />
                  </label>
                  <label>
                    <span>验收标准</span>
                    <textarea name="criteria" required maxLength={2000} rows={2} />
                  </label>
                  <div className="node-pairing-buttons">
                    <button
                      className="button primary compact"
                      disabled={actions.busy}
                      type="submit"
                    >
                      <Send size={14} />
                      加密发送邀请
                    </button>
                    <button
                      className="button compact"
                      disabled={actions.busy}
                      type="button"
                      onClick={() => setTaskForm(false)}
                    >
                      取消
                    </button>
                  </div>
                </form>
              )}
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
  pending: '等待处理',
  accepted: '已接受',
  declined: '已拒绝',
  cancelled: '已取消',
  expired: '已过期',
};

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
  const brain = peer?.brains.find((item) => item.id === brainID);
  return (
    <article className={`remote-task-card ${task.direction} status-${task.status}`}>
      <div className="remote-task-heading">
        <span className="remote-task-icon">
          {task.direction === 'incoming' ? <Inbox size={18} /> : <Send size={18} />}
        </span>
        <div>
          <span className="eyebrow">
            {task.direction === 'incoming' ? 'INCOMING TASK INVITE' : 'OUTGOING TASK INVITE'}
          </span>
          <h3>{task.title}</h3>
        </div>
        <span className={`remote-task-status status-${task.status}`}>
          {task.deliveryPending ? '等待发送' : remoteTaskStatus[task.status]}
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
        <span>
          <Clock3 size={13} />
          {new Date(task.expiresAt).toLocaleString('zh-CN')} 前有效
        </span>
      </div>
      {task.deliveryError && <p className="remote-task-error">{task.deliveryError}</p>}
      {task.status === 'accepted' && (
        <p className="remote-task-boundary">
          双方已确认任务范围；尚未绑定本机项目、模型或启动 AI。
        </p>
      )}
      {actions.owner && task.direction === 'incoming' && task.status === 'pending' && (
        <div className="remote-task-buttons">
          <button
            className="button primary compact"
            disabled={actions.busy || task.deliveryPending}
            onClick={() => actions.respondRemoteTask(task.id, 'accepted')}
          >
            <Check size={14} />
            接受任务邀请
          </button>
          <button
            className="button compact"
            disabled={actions.busy || task.deliveryPending}
            onClick={() => actions.respondRemoteTask(task.id, 'declined')}
          >
            <X size={14} />
            拒绝
          </button>
        </div>
      )}
      {actions.owner &&
        task.direction === 'outgoing' &&
        (task.status === 'pending' || task.status === 'accepted') && (
          <div className="remote-task-buttons">
            <button
              className="button danger compact"
              disabled={actions.busy || task.deliveryPending}
              onClick={() => actions.cancelRemoteTask(task.id)}
            >
              <X size={14} />
              取消邀请
            </button>
          </div>
        )}
    </article>
  );
}

export function NodeNetworkView({
  network,
  owner,
  busy,
  onRequestPairing,
  onConfirmPairing,
  onCancelPairing,
  onRevokeTrust,
  onCreateRemoteTask,
  onRespondRemoteTask,
  onCancelRemoteTask,
}: {
  network: NodeNetwork;
  owner: boolean;
  busy: boolean;
  onRequestPairing(nodeID: string): void;
  onConfirmPairing(pairingID: string): void;
  onCancelPairing(pairingID: string): void;
  onRevokeTrust(nodeID: string): void;
  onCreateRemoteTask(
    nodeID: string,
    targetBrainID: string,
    input: { title: string; description: string; criteria: string },
  ): void;
  onRespondRemoteTask(taskID: string, decision: 'accepted' | 'declined'): void;
  onCancelRemoteTask(taskID: string): void;
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
    createRemoteTask: onCreateRemoteTask,
    respondRemoteTask: onRespondRemoteTask,
    cancelRemoteTask: onCancelRemoteTask,
  };
  return (
    <>
      <div className="page-heading network-page-heading">
        <div>
          <span className="eyebrow">LOCAL-FIRST INTELLIGENCE</span>
          <h1>
            节点与 Brain<span className="heading-dot">.</span>
          </h1>
          <p>附近的 Rivloom 自动相遇。Brain 可以独立工作，也可以在信任建立后协同任务。</p>
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
          <strong>
            {(network.local?.brains.length || 0) +
              onlineNearby.reduce((total, node) => total + node.brains.length, 0)}
          </strong>
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

      <section className="network-section remote-task-section">
        <div className="section-title">
          <div>
            <span className="eyebrow">CROSS-DEVICE TASKS</span>
            <h2>跨设备任务邀请</h2>
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
            <p>与受信节点建立加密通道后，可以发出任务邀请；对方必须在自己的设备上决定。</p>
          </div>
        )}
      </section>

      <div className="collaboration-note network-boundary">
        <ShieldCheck size={25} />
        <div>
          <h3>任务邀请不会自动执行</h3>
          <p>
            当前加密协议只开放任务邀请、接受、拒绝和取消。接受后仍不会暴露项目、模型凭据或
            OpenCode，也不会自动运行工具；项目授权、角色映射、执行与审批将在后续切片逐步接入。
          </p>
        </div>
      </div>
    </>
  );
}
