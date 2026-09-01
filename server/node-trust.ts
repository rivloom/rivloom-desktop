import { createHash, createPublicKey, verify } from 'node:crypto';
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
import { fingerprintForPublicKey, nodeIDForPublicKey } from './node-identity.ts';

export type PairingMessage = {
  protocol: 'rivloom-node-pairing';
  version: 1;
  type: 'request' | 'ack' | 'confirm' | 'cancel';
  pairingID: string;
  requesterNodeID: string;
  responderNodeID: string;
  nonce: string;
  actorNodeID: string;
  issuedAt: number;
  publicKey: string;
  signature: string;
};

export type RevocationMessage = {
  protocol: 'rivloom-node-trust';
  version: 1;
  type: 'revoke';
  nodeID: string;
  peerNodeID: string;
  issuedAt: number;
  publicKey: string;
  signature: string;
};

export type TrustedNodeRecord = {
  nodeID: string;
  fingerprint: string;
  publicKey: string;
  pairedAt: string;
};

type RevokedNodeRecord = {
  nodeID: string;
  fingerprint: string;
  revokedAt: string;
};

type StoredTrust = {
  version: 1;
  trusted: TrustedNodeRecord[];
  revoked: RevokedNodeRecord[];
};

const nodePattern = /^[A-Za-z0-9_-]{32}$/;
const fingerprintPattern = /^[0-9A-F:]{79}$/i;
const pairingPattern = /^[0-9a-f-]{36}$/i;
const noncePattern = /^[A-Za-z0-9_-]{32}$/;

export function unsignedPairingMessage(value: Omit<PairingMessage, 'signature'>) {
  return JSON.stringify({
    protocol: value.protocol,
    version: value.version,
    type: value.type,
    pairingID: value.pairingID,
    requesterNodeID: value.requesterNodeID,
    responderNodeID: value.responderNodeID,
    nonce: value.nonce,
    actorNodeID: value.actorNodeID,
    issuedAt: value.issuedAt,
    publicKey: value.publicKey,
  });
}

export function unsignedRevocationMessage(value: Omit<RevocationMessage, 'signature'>) {
  return JSON.stringify({
    protocol: value.protocol,
    version: value.version,
    type: value.type,
    nodeID: value.nodeID,
    peerNodeID: value.peerNodeID,
    issuedAt: value.issuedAt,
    publicKey: value.publicKey,
  });
}

export function validPairingMessage(value: unknown): value is PairingMessage {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    item.protocol === 'rivloom-node-pairing' &&
    item.version === 1 &&
    ['request', 'ack', 'confirm', 'cancel'].includes(String(item.type)) &&
    typeof item.pairingID === 'string' &&
    pairingPattern.test(item.pairingID) &&
    typeof item.requesterNodeID === 'string' &&
    nodePattern.test(item.requesterNodeID) &&
    typeof item.responderNodeID === 'string' &&
    nodePattern.test(item.responderNodeID) &&
    typeof item.nonce === 'string' &&
    noncePattern.test(item.nonce) &&
    typeof item.actorNodeID === 'string' &&
    nodePattern.test(item.actorNodeID) &&
    Number.isInteger(item.issuedAt) &&
    typeof item.publicKey === 'string' &&
    item.publicKey.length <= 512 &&
    typeof item.signature === 'string' &&
    item.signature.length <= 256
  );
}

export function validRevocationMessage(value: unknown): value is RevocationMessage {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    item.protocol === 'rivloom-node-trust' &&
    item.version === 1 &&
    item.type === 'revoke' &&
    typeof item.nodeID === 'string' &&
    nodePattern.test(item.nodeID) &&
    typeof item.peerNodeID === 'string' &&
    nodePattern.test(item.peerNodeID) &&
    Number.isInteger(item.issuedAt) &&
    typeof item.publicKey === 'string' &&
    item.publicKey.length <= 512 &&
    typeof item.signature === 'string' &&
    item.signature.length <= 256
  );
}

export function verifySignedNodeMessage(
  publicKey: string,
  nodeID: string,
  fingerprint: string,
  value: string,
  signature: string,
) {
  try {
    const publicBytes = Buffer.from(publicKey, 'base64');
    return (
      nodeIDForPublicKey(publicBytes) === nodeID &&
      fingerprintForPublicKey(publicBytes) === fingerprint &&
      verify(
        null,
        Buffer.from(value),
        createPublicKey({ key: publicBytes, format: 'der', type: 'spki' }),
        Buffer.from(signature, 'base64url'),
      )
    );
  } catch {
    return false;
  }
}

export function pairingShortCode(
  pairingID: string,
  nonce: string,
  requesterNodeID: string,
  requesterFingerprint: string,
  responderNodeID: string,
  responderFingerprint: string,
) {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        purpose: 'rivloom-pairing-code-v1',
        pairingID,
        nonce,
        requesterNodeID,
        requesterFingerprint,
        responderNodeID,
        responderFingerprint,
      }),
    )
    .digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

function validTrusted(value: unknown): value is TrustedNodeRecord {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  if (
    typeof item.nodeID !== 'string' ||
    !nodePattern.test(item.nodeID) ||
    typeof item.fingerprint !== 'string' ||
    !fingerprintPattern.test(item.fingerprint) ||
    typeof item.publicKey !== 'string' ||
    item.publicKey.length > 512 ||
    typeof item.pairedAt !== 'string' ||
    !Number.isFinite(Date.parse(item.pairedAt))
  )
    return false;
  try {
    const publicBytes = Buffer.from(item.publicKey, 'base64');
    return (
      nodeIDForPublicKey(publicBytes) === item.nodeID &&
      fingerprintForPublicKey(publicBytes) === item.fingerprint
    );
  } catch {
    return false;
  }
}

function validRevoked(value: unknown): value is RevokedNodeRecord {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.nodeID === 'string' &&
    nodePattern.test(item.nodeID) &&
    typeof item.fingerprint === 'string' &&
    fingerprintPattern.test(item.fingerprint) &&
    typeof item.revokedAt === 'string' &&
    Number.isFinite(Date.parse(item.revokedAt))
  );
}

export class NodeTrustStore {
  private readonly path: string;
  private readonly trustedNodes = new Map<string, TrustedNodeRecord>();
  private readonly revokedNodes = new Map<string, RevokedNodeRecord>();

  constructor(root: string) {
    this.path = join(root, 'trusted-nodes.json');
  }

  load() {
    this.trustedNodes.clear();
    this.revokedNodes.clear();
    if (!existsSync(this.path)) return;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
    } catch {
      throw new Error('节点信任记录无法读取；节点网络保持关闭。');
    }
    const item = value as Partial<StoredTrust>;
    if (
      !value ||
      typeof value !== 'object' ||
      item.version !== 1 ||
      !Array.isArray(item.trusted) ||
      !item.trusted.every(validTrusted) ||
      !Array.isArray(item.revoked) ||
      !item.revoked.every(validRevoked)
    )
      throw new Error('节点信任记录字段无效；节点网络保持关闭。');
    const trustedIDs = item.trusted.map((record) => record.nodeID);
    const revokedIDs = item.revoked.map((record) => record.nodeID);
    if (
      new Set(trustedIDs).size !== trustedIDs.length ||
      new Set(revokedIDs).size !== revokedIDs.length ||
      trustedIDs.some((nodeID) => revokedIDs.includes(nodeID))
    )
      throw new Error('节点信任记录存在冲突；节点网络保持关闭。');
    for (const record of item.trusted) this.trustedNodes.set(record.nodeID, record);
    for (const record of item.revoked) this.revokedNodes.set(record.nodeID, record);
  }

  trusted(nodeID: string, fingerprint: string) {
    return this.trustedNodes.get(nodeID)?.fingerprint === fingerprint;
  }

  record(nodeID: string) {
    return this.trustedNodes.get(nodeID) || null;
  }

  revocation(nodeID: string, fingerprint: string) {
    const record = this.revokedNodes.get(nodeID);
    return record?.fingerprint === fingerprint ? record : null;
  }

  trust(record: TrustedNodeRecord) {
    if (!validTrusted(record)) throw new Error('不能保存无效的节点信任记录。');
    this.trustedNodes.set(record.nodeID, record);
    this.revokedNodes.delete(record.nodeID);
    this.save();
  }

  revoke(nodeID: string, fingerprint: string, revokedAt = new Date().toISOString()) {
    this.trustedNodes.delete(nodeID);
    this.revokedNodes.set(nodeID, { nodeID, fingerprint, revokedAt });
    this.save();
  }

  private save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const value: StoredTrust = {
      version: 1,
      trusted: [...this.trustedNodes.values()].sort((a, b) => a.nodeID.localeCompare(b.nodeID)),
      revoked: [...this.revokedNodes.values()].sort((a, b) => a.nodeID.localeCompare(b.nodeID)),
    };
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.path);
      try {
        chmodSync(this.path, 0o600);
      } catch {
        /* Windows access is primarily enforced by the current user profile. */
      }
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}
