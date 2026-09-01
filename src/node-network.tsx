import { BrainCircuit, Fingerprint, Radio, ShieldCheck, WifiOff } from 'lucide-react';
import type { NodeNetwork, RivloomNode } from '../shared/types';

const shortFingerprint = (value: string) => {
  const groups = value.split(':');
  return groups.length > 8
    ? `${groups.slice(0, 4).join(':')} ··· ${groups.slice(-4).join(':')}`
    : value;
};

function NodeCard({ node }: { node: RivloomNode }) {
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
            ? '已建立设备信任'
            : '签名身份已验证，尚未配对授权'}
      </div>
    </article>
  );
}

export function NodeNetworkView({ network }: { network: NodeNetwork }) {
  const online = network.status === 'online';
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
          <strong>{network.local ? 1 + network.nearby.length : network.nearby.length}</strong>
          <span>已验证节点</span>
        </div>
        <div>
          <strong>
            {(network.local?.brains.length || 0) +
              network.nearby.reduce((total, node) => total + node.brains.length, 0)}
          </strong>
          <span>可见 Brain</span>
        </div>
        <div>
          <strong>{network.nearby.filter((node) => node.trusted).length}</strong>
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
            <NodeCard node={network.local} />
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
              ? `发现 ${network.nearby.length} 个签名节点`
              : '等待同网段 Rivloom 出现'}
          </p>
        </div>
        {network.nearby.length ? (
          <div className="network-grid">
            {network.nearby.map((node) => (
              <NodeCard node={node} key={node.id} />
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

      <div className="collaboration-note network-boundary">
        <ShieldCheck size={25} />
        <div>
          <h3>自动发现不会自动授予权限</h3>
          <p>
            当前 M3.1
            已验证节点身份和附近发现。设备配对、撤销以及跨节点任务传输将在下一切片开放；在此之前，附近节点不能读取任务、项目或模型凭据。
          </p>
        </div>
      </div>
    </>
  );
}
