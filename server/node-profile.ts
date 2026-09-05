import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validNodeProfile, validNodeRemark, type NodeProfile } from '../shared/node-profile.ts';

type PeerProfile = NodeProfile & {
  fingerprint: string;
  remark?: string;
  lastUsedAt?: string;
};
type StoredProfiles = { version: 1; local: NodeProfile | null; peers: Record<string, PeerProfile> };

/** Display metadata only. This store never creates an identity or grants trust. */
export class NodeProfileStore {
  private value: StoredProfiles = { version: 1, local: null, peers: {} };
  private readonly path: string;
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
    this.path = join(root, 'node-profiles.json');
    if (!existsSync(this.path)) return;
    const stored = JSON.parse(readFileSync(this.path, 'utf8')) as StoredProfiles;
    if (
      stored.version !== 1 ||
      (stored.local !== null && !validNodeProfile(stored.local)) ||
      !stored.peers ||
      Array.isArray(stored.peers) ||
      typeof stored.peers !== 'object' ||
      !Object.entries(stored.peers).every(
        ([id, peer]) =>
          /^[A-Za-z0-9_-]{32}$/.test(id) &&
          validNodeProfile(peer) &&
          typeof peer.fingerprint === 'string' &&
          (peer.remark === undefined || validNodeRemark(peer.remark)) &&
          (peer.lastUsedAt === undefined || Number.isFinite(Date.parse(peer.lastUsedAt))),
      )
    )
      throw new Error('节点显示资料无效，请检查 node-profiles.json。');
    this.value = stored;
  }
  local(nodeID: string): NodeProfile {
    return { ...(this.value.local || { name: `Rivloom ${nodeID.slice(0, 6)}`, icon: 'monitor' }) };
  }
  peer(nodeID: string, fingerprint: string): PeerProfile | null {
    const peer = this.value.peers[nodeID];
    return peer?.fingerprint === fingerprint ? { ...peer } : null;
  }
  saveLocal(profile: NodeProfile) {
    if (!validNodeProfile(profile)) throw new Error('节点名称或图标无效。');
    this.save({ ...this.value, local: { name: profile.name.trim(), icon: profile.icon } });
  }
  remember(nodeID: string, fingerprint: string, profile: NodeProfile) {
    if (!/^[A-Za-z0-9_-]{32}$/.test(nodeID) || !validNodeProfile(profile)) return;
    const previous = this.value.peers[nodeID];
    const metadata = previous?.fingerprint === fingerprint ? previous : null;
    const peer: PeerProfile = {
      name: profile.name,
      icon: profile.icon,
      fingerprint,
      ...(metadata?.remark ? { remark: metadata.remark } : {}),
      ...(metadata?.lastUsedAt ? { lastUsedAt: metadata.lastUsedAt } : {}),
    };
    if (JSON.stringify(this.value.peers[nodeID]) === JSON.stringify(peer)) return;
    this.save({ ...this.value, peers: { ...this.value.peers, [nodeID]: peer } });
  }
  saveRemark(nodeID: string, fingerprint: string, profile: NodeProfile, remark: string | null) {
    if (!/^[A-Za-z0-9_-]{32}$/.test(nodeID) || !validNodeProfile(profile))
      throw new Error('节点显示资料无效。');
    const normalized = remark?.trim() || null;
    if (normalized !== null && !validNodeRemark(normalized)) throw new Error('节点备注名无效。');
    this.remember(nodeID, fingerprint, profile);
    const current = this.value.peers[nodeID];
    const { remark: _remark, ...rest } = current;
    this.save({
      ...this.value,
      peers: {
        ...this.value.peers,
        [nodeID]: normalized ? { ...rest, remark: normalized } : rest,
      },
    });
  }
  markUsed(
    nodeID: string,
    fingerprint: string,
    profile: NodeProfile,
    at = new Date().toISOString(),
  ) {
    if (!Number.isFinite(Date.parse(at))) throw new Error('节点使用时间无效。');
    this.remember(nodeID, fingerprint, profile);
    const current = this.value.peers[nodeID];
    this.save({
      ...this.value,
      peers: { ...this.value.peers, [nodeID]: { ...current, lastUsedAt: at } },
    });
  }
  private save(value: StoredProfiles) {
    mkdirSync(this.root, { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(temporary, this.path);
    this.value = value;
  }
}
