import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainSummary } from '../shared/types.ts';

type StoredBrain = BrainSummary & { hosted: boolean };
type StoredTopology = { version: 1; brains: StoredBrain[] };

const nodePattern = /^[A-Za-z0-9_-]{32}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validBrain(value: unknown): value is StoredBrain {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    Object.keys(item).sort().join(',') === 'hosted,id,masterNodeID,name,state' &&
    typeof item.id === 'string' &&
    uuidPattern.test(item.id) &&
    typeof item.name === 'string' &&
    item.name.length >= 1 &&
    item.name.length <= 80 &&
    typeof item.masterNodeID === 'string' &&
    nodePattern.test(item.masterNodeID) &&
    (item.state === 'provisional' || item.state === 'established') &&
    typeof item.hosted === 'boolean'
  );
}

function validated(value: unknown): StoredTopology {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Brain 拓扑文件不是对象。');
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).sort().join(',') !== 'brains,version' ||
    item.version !== 1 ||
    !Array.isArray(item.brains) ||
    item.brains.length > 32 ||
    !item.brains.every(validBrain)
  )
    throw new Error('Brain 拓扑文件字段无效。');
  const brains = item.brains as StoredBrain[];
  if (new Set(brains.map((brain) => brain.id)).size !== brains.length)
    throw new Error('Brain 拓扑文件包含重复 Brain。');
  return { version: 1, brains };
}

function summary(brain: StoredBrain): BrainSummary {
  return {
    id: brain.id,
    name: brain.name,
    masterNodeID: brain.masterNodeID,
    state: brain.state,
  };
}

export class BrainTopologyStore {
  private readonly path: string;
  private brains: StoredBrain[] = [];

  constructor(root: string) {
    this.path = join(root, 'brain-topology.json');
  }

  load(input: { nodeID: string; legacyBrainID: string; legacyIdentityExisted: boolean }) {
    if (existsSync(this.path)) {
      this.brains = validated(JSON.parse(readFileSync(this.path, 'utf8'))).brains;
      if (this.brains.some((brain) => brain.hosted && brain.masterNodeID !== input.nodeID))
        throw new Error('Brain 拓扑的本机 Master 身份不匹配。');
      return;
    }
    this.brains = [
      {
        id: input.legacyBrainID,
        name: `Brain ${input.legacyBrainID.slice(0, 6)}`,
        masterNodeID: input.nodeID,
        state: input.legacyIdentityExisted ? 'established' : 'provisional',
        hosted: true,
      },
    ];
    this.save();
  }

  all() {
    return this.brains.map(summary).sort((left, right) => left.id.localeCompare(right.id));
  }

  hosted() {
    return this.brains
      .filter((brain) => brain.hosted)
      .map(summary)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  established() {
    return this.all().filter((brain) => brain.state === 'established');
  }

  settleProvisional(blockedByNearbyEstablished = false) {
    if (blockedByNearbyEstablished) return false;
    let changed = false;
    this.brains = this.brains.map((brain) => {
      if (!brain.hosted || brain.state !== 'provisional') return brain;
      changed = true;
      return { ...brain, state: 'established' };
    });
    if (changed) this.save();
    return changed;
  }

  reconcile(peerNodeID: string, peerHosted: BrainSummary[]) {
    if (!nodePattern.test(peerNodeID)) return false;
    const remote = peerHosted.filter(
      (brain) =>
        uuidPattern.test(brain.id) &&
        nodePattern.test(brain.masterNodeID) &&
        brain.masterNodeID === peerNodeID &&
        (brain.state === 'provisional' || brain.state === 'established'),
    );
    const before = JSON.stringify(this.brains);
    // Only that Master's authenticated directory may withdraw its empty bootstrap Brain.
    // Established histories remain stable even when their Master stops advertising them.
    this.brains = this.brains.filter(
      (brain) =>
        brain.hosted ||
        brain.state === 'established' ||
        brain.masterNodeID !== peerNodeID ||
        remote.some((item) => item.id === brain.id),
    );
    const localHosted = this.brains.filter((brain) => brain.hosted);
    const localEstablished = localHosted.some((brain) => brain.state === 'established');
    const remoteEstablished = remote.some((brain) => brain.state === 'established');

    if (remote.length && !localEstablished && localHosted.length) {
      if (remoteEstablished) {
        this.brains = this.brains.filter((brain) => !brain.hosted);
      } else {
        const localWinner = localHosted.some(
          (brain) => brain.masterNodeID.localeCompare(peerNodeID) < 0,
        );
        if (localWinner) {
          this.brains = this.brains.map((brain) =>
            brain.hosted && brain.state === 'provisional'
              ? { ...brain, state: 'established' }
              : brain,
          );
        } else {
          this.brains = this.brains.filter((brain) => !brain.hosted);
        }
      }
    }

    for (const brain of remote) {
      const existing = this.brains.find((candidate) => candidate.id === brain.id);
      if (existing) {
        if (existing.masterNodeID !== brain.masterNodeID) continue;
        if (existing.state === 'provisional' && brain.state === 'established')
          existing.state = 'established';
        continue;
      }
      this.brains.push({
        id: brain.id,
        name: brain.name,
        masterNodeID: brain.masterNodeID,
        state: brain.state,
        hosted: false,
      });
    }
    this.brains.sort((left, right) => left.id.localeCompare(right.id));
    const changed = JSON.stringify(this.brains) !== before;
    if (changed) this.save();
    return changed;
  }

  removeRegistrationsForMaster(masterNodeID: string) {
    const before = this.brains.length;
    this.brains = this.brains.filter(
      (brain) => brain.hosted || brain.masterNodeID !== masterNodeID,
    );
    if (this.brains.length !== before) this.save();
    return this.brains.length !== before;
  }

  private save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, brains: this.brains }, null, 2), {
        mode: 0o600,
        flag: 'wx',
      });
      renameSync(temporary, this.path);
      try {
        chmodSync(this.path, 0o600);
      } catch {
        /* Windows access control is inherited from the local application data directory. */
      }
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}
