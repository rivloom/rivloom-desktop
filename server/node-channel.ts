import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  type KeyObject,
} from 'node:crypto';
import type { NodeIdentity } from './node-identity.ts';

export type ChannelOpen = {
  protocol: 'rivloom-secure-channel';
  version: 1;
  type: 'open';
  sessionID: string;
  initiatorNodeID: string;
  responderNodeID: string;
  nonce: string;
  issuedAt: number;
  ephemeralPublicKey: string;
  publicKey: string;
  signature: string;
};

export type ChannelAck = {
  protocol: 'rivloom-secure-channel';
  version: 1;
  type: 'ack';
  sessionID: string;
  initiatorNodeID: string;
  responderNodeID: string;
  requestNonce: string;
  responseNonce: string;
  issuedAt: number;
  ephemeralPublicKey: string;
  publicKey: string;
  signature: string;
};

export type ChannelRecovery = {
  protocol: 'rivloom-secure-channel';
  version: 1;
  type: 'recover';
  recoveryID: string;
  requesterNodeID: string;
  responderNodeID: string;
  issuedAt: number;
  publicKey: string;
  signature: string;
};

export type ChannelEnvelope = {
  protocol: 'rivloom-secure-channel';
  version: 1;
  type: 'message';
  sessionID: string;
  senderNodeID: string;
  recipientNodeID: string;
  sequence: number;
  issuedAt: number;
  iv: string;
  ciphertext: string;
  tag: string;
};

export type SecureChannelSession = {
  id: string;
  localNodeID: string;
  peerNodeID: string;
  sendKey: Buffer;
  receiveKey: Buffer;
  sendSequence: number;
  receiveSequence: number;
  expiresAt: number;
};

/** A response authenticates one encrypted request without consuming stream sequence numbers. */
export type ChannelEventAck = {
  protocol: 'rivloom-secure-channel';
  version: 1;
  type: 'event-ack';
  sessionID: string;
  senderNodeID: string;
  recipientNodeID: string;
  iv: string;
  ciphertext: string;
  tag: string;
};

export type PendingChannelOpen = {
  message: ChannelOpen;
  privateKey: KeyObject;
};

const nodePattern = /^[A-Za-z0-9_-]{32}$/;
const uuidPattern = /^[0-9a-f-]{36}$/i;
const noncePattern = /^[A-Za-z0-9_-]{32}$/;
const maximumCiphertextCharacters = 128 * 1024;
export const channelSessionLifetimeMilliseconds = 10 * 60_000;
export const channelMessageWindowMilliseconds = 60_000;

export function unsignedChannelOpen(value: Omit<ChannelOpen, 'signature'>) {
  return JSON.stringify({
    protocol: value.protocol,
    version: value.version,
    type: value.type,
    sessionID: value.sessionID,
    initiatorNodeID: value.initiatorNodeID,
    responderNodeID: value.responderNodeID,
    nonce: value.nonce,
    issuedAt: value.issuedAt,
    ephemeralPublicKey: value.ephemeralPublicKey,
    publicKey: value.publicKey,
  });
}

export function unsignedChannelAck(value: Omit<ChannelAck, 'signature'>) {
  return JSON.stringify({
    protocol: value.protocol,
    version: value.version,
    type: value.type,
    sessionID: value.sessionID,
    initiatorNodeID: value.initiatorNodeID,
    responderNodeID: value.responderNodeID,
    requestNonce: value.requestNonce,
    responseNonce: value.responseNonce,
    issuedAt: value.issuedAt,
    ephemeralPublicKey: value.ephemeralPublicKey,
    publicKey: value.publicKey,
  });
}

export function unsignedChannelRecovery(value: Omit<ChannelRecovery, 'signature'>) {
  return JSON.stringify({
    protocol: value.protocol,
    version: value.version,
    type: value.type,
    recoveryID: value.recoveryID,
    requesterNodeID: value.requesterNodeID,
    responderNodeID: value.responderNodeID,
    issuedAt: value.issuedAt,
    publicKey: value.publicKey,
  });
}

function envelopeAAD(value: Omit<ChannelEnvelope, 'ciphertext' | 'tag'>) {
  return Buffer.from(
    JSON.stringify({
      protocol: value.protocol,
      version: value.version,
      type: value.type,
      sessionID: value.sessionID,
      senderNodeID: value.senderNodeID,
      recipientNodeID: value.recipientNodeID,
      sequence: value.sequence,
      issuedAt: value.issuedAt,
      iv: value.iv,
    }),
  );
}

export function validChannelOpen(value: unknown): value is ChannelOpen {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    item.protocol === 'rivloom-secure-channel' &&
    item.version === 1 &&
    item.type === 'open' &&
    typeof item.sessionID === 'string' &&
    uuidPattern.test(item.sessionID) &&
    typeof item.initiatorNodeID === 'string' &&
    nodePattern.test(item.initiatorNodeID) &&
    typeof item.responderNodeID === 'string' &&
    nodePattern.test(item.responderNodeID) &&
    typeof item.nonce === 'string' &&
    noncePattern.test(item.nonce) &&
    Number.isInteger(item.issuedAt) &&
    typeof item.ephemeralPublicKey === 'string' &&
    item.ephemeralPublicKey.length <= 512 &&
    typeof item.publicKey === 'string' &&
    item.publicKey.length <= 512 &&
    typeof item.signature === 'string' &&
    item.signature.length <= 256
  );
}

export function validChannelAck(value: unknown): value is ChannelAck {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    item.protocol === 'rivloom-secure-channel' &&
    item.version === 1 &&
    item.type === 'ack' &&
    typeof item.sessionID === 'string' &&
    uuidPattern.test(item.sessionID) &&
    typeof item.initiatorNodeID === 'string' &&
    nodePattern.test(item.initiatorNodeID) &&
    typeof item.responderNodeID === 'string' &&
    nodePattern.test(item.responderNodeID) &&
    typeof item.requestNonce === 'string' &&
    noncePattern.test(item.requestNonce) &&
    typeof item.responseNonce === 'string' &&
    noncePattern.test(item.responseNonce) &&
    Number.isInteger(item.issuedAt) &&
    typeof item.ephemeralPublicKey === 'string' &&
    item.ephemeralPublicKey.length <= 512 &&
    typeof item.publicKey === 'string' &&
    item.publicKey.length <= 512 &&
    typeof item.signature === 'string' &&
    item.signature.length <= 256
  );
}

export function validChannelRecovery(value: unknown): value is ChannelRecovery {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    item.protocol === 'rivloom-secure-channel' &&
    item.version === 1 &&
    item.type === 'recover' &&
    typeof item.recoveryID === 'string' &&
    uuidPattern.test(item.recoveryID) &&
    typeof item.requesterNodeID === 'string' &&
    nodePattern.test(item.requesterNodeID) &&
    typeof item.responderNodeID === 'string' &&
    nodePattern.test(item.responderNodeID) &&
    Number.isInteger(item.issuedAt) &&
    typeof item.publicKey === 'string' &&
    item.publicKey.length <= 512 &&
    typeof item.signature === 'string' &&
    item.signature.length <= 256
  );
}

export function validChannelEnvelope(value: unknown): value is ChannelEnvelope {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    item.protocol === 'rivloom-secure-channel' &&
    item.version === 1 &&
    item.type === 'message' &&
    typeof item.sessionID === 'string' &&
    uuidPattern.test(item.sessionID) &&
    typeof item.senderNodeID === 'string' &&
    nodePattern.test(item.senderNodeID) &&
    typeof item.recipientNodeID === 'string' &&
    nodePattern.test(item.recipientNodeID) &&
    Number.isSafeInteger(item.sequence) &&
    Number(item.sequence) >= 1 &&
    Number.isInteger(item.issuedAt) &&
    typeof item.iv === 'string' &&
    /^[A-Za-z0-9_-]{16}$/.test(item.iv) &&
    typeof item.ciphertext === 'string' &&
    item.ciphertext.length <= maximumCiphertextCharacters &&
    /^[A-Za-z0-9_-]*$/.test(item.ciphertext) &&
    typeof item.tag === 'string' &&
    /^[A-Za-z0-9_-]{22}$/.test(item.tag)
  );
}

function publicKeyBytes(key: KeyObject) {
  return key.export({ format: 'der', type: 'spki' }) as Buffer;
}

function peerEphemeralKey(value: string) {
  return createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' });
}

function keys(
  sharedSecret: Buffer,
  sessionID: string,
  requestNonce: string,
  responseNonce: string,
  initiatorNodeID: string,
  responderNodeID: string,
) {
  const salt = createHash('sha256')
    .update(
      JSON.stringify({
        purpose: 'rivloom-secure-channel-v1',
        sessionID,
        requestNonce,
        responseNonce,
        initiatorNodeID,
        responderNodeID,
      }),
    )
    .digest();
  const derive = (direction: string) =>
    Buffer.from(hkdfSync('sha256', sharedSecret, salt, Buffer.from(direction), 32));
  return {
    initiatorToResponder: derive('rivloom-channel-v1:initiator-to-responder'),
    responderToInitiator: derive('rivloom-channel-v1:responder-to-initiator'),
  };
}

function session(
  id: string,
  localNodeID: string,
  peerNodeID: string,
  sendKey: Buffer,
  receiveKey: Buffer,
): SecureChannelSession {
  return {
    id,
    localNodeID,
    peerNodeID,
    sendKey,
    receiveKey,
    sendSequence: 0,
    receiveSequence: 0,
    expiresAt: Date.now() + channelSessionLifetimeMilliseconds,
  };
}

export function beginSecureChannel(
  identity: NodeIdentity,
  responderNodeID: string,
): PendingChannelOpen {
  const ephemeral = generateKeyPairSync('x25519');
  const unsigned: Omit<ChannelOpen, 'signature'> = {
    protocol: 'rivloom-secure-channel',
    version: 1,
    type: 'open',
    sessionID: randomUUID(),
    initiatorNodeID: identity.nodeID,
    responderNodeID,
    nonce: randomBytes(24).toString('base64url'),
    issuedAt: Date.now(),
    ephemeralPublicKey: publicKeyBytes(ephemeral.publicKey).toString('base64'),
    publicKey: identity.publicKey,
  };
  return {
    message: { ...unsigned, signature: identity.sign(unsignedChannelOpen(unsigned)) },
    privateKey: ephemeral.privateKey,
  };
}

export function acceptSecureChannel(open: ChannelOpen, identity: NodeIdentity) {
  const ephemeral = generateKeyPairSync('x25519');
  const responseNonce = randomBytes(24).toString('base64url');
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: peerEphemeralKey(open.ephemeralPublicKey),
  });
  const derived = keys(
    shared,
    open.sessionID,
    open.nonce,
    responseNonce,
    open.initiatorNodeID,
    open.responderNodeID,
  );
  const unsigned: Omit<ChannelAck, 'signature'> = {
    protocol: 'rivloom-secure-channel',
    version: 1,
    type: 'ack',
    sessionID: open.sessionID,
    initiatorNodeID: open.initiatorNodeID,
    responderNodeID: open.responderNodeID,
    requestNonce: open.nonce,
    responseNonce,
    issuedAt: Date.now(),
    ephemeralPublicKey: publicKeyBytes(ephemeral.publicKey).toString('base64'),
    publicKey: identity.publicKey,
  };
  return {
    ack: { ...unsigned, signature: identity.sign(unsignedChannelAck(unsigned)) },
    session: session(
      open.sessionID,
      open.responderNodeID,
      open.initiatorNodeID,
      derived.responderToInitiator,
      derived.initiatorToResponder,
    ),
  };
}

export function finishSecureChannel(pending: PendingChannelOpen, ack: ChannelAck) {
  const open = pending.message;
  const shared = diffieHellman({
    privateKey: pending.privateKey,
    publicKey: peerEphemeralKey(ack.ephemeralPublicKey),
  });
  const derived = keys(
    shared,
    open.sessionID,
    open.nonce,
    ack.responseNonce,
    open.initiatorNodeID,
    open.responderNodeID,
  );
  return session(
    open.sessionID,
    open.initiatorNodeID,
    open.responderNodeID,
    derived.initiatorToResponder,
    derived.responderToInitiator,
  );
}

export function encryptChannelPayload(session: SecureChannelSession, value: unknown) {
  if (session.expiresAt <= Date.now()) throw new Error('加密会话已过期。');
  const plaintext = Buffer.from(JSON.stringify(value));
  if (plaintext.byteLength > 64 * 1024) throw new Error('加密消息过大。');
  const sequence = session.sendSequence + 1;
  const iv = randomBytes(12).toString('base64url');
  const unsigned: Omit<ChannelEnvelope, 'ciphertext' | 'tag'> = {
    protocol: 'rivloom-secure-channel',
    version: 1,
    type: 'message',
    sessionID: session.id,
    senderNodeID: session.localNodeID,
    recipientNodeID: session.peerNodeID,
    sequence,
    issuedAt: Date.now(),
    iv,
  };
  const cipher = createCipheriv('aes-256-gcm', session.sendKey, Buffer.from(iv, 'base64url'));
  cipher.setAAD(envelopeAAD(unsigned));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope: ChannelEnvelope = {
    ...unsigned,
    ciphertext: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  };
  session.sendSequence = sequence;
  return envelope;
}

export function decryptChannelPayload(session: SecureChannelSession, envelope: ChannelEnvelope) {
  if (
    session.expiresAt <= Date.now() ||
    envelope.sessionID !== session.id ||
    envelope.senderNodeID !== session.peerNodeID ||
    envelope.recipientNodeID !== session.localNodeID ||
    envelope.sequence !== session.receiveSequence + 1 ||
    Math.abs(Date.now() - envelope.issuedAt) > channelMessageWindowMilliseconds
  )
    throw new Error('加密消息会话、顺序或时间无效。');
  const unsigned: Omit<ChannelEnvelope, 'ciphertext' | 'tag'> = {
    protocol: envelope.protocol,
    version: envelope.version,
    type: envelope.type,
    sessionID: envelope.sessionID,
    senderNodeID: envelope.senderNodeID,
    recipientNodeID: envelope.recipientNodeID,
    sequence: envelope.sequence,
    issuedAt: envelope.issuedAt,
    iv: envelope.iv,
  };
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      session.receiveKey,
      Buffer.from(envelope.iv, 'base64url'),
    );
    decipher.setAAD(envelopeAAD(unsigned));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
      decipher.final(),
    ]);
    const value = JSON.parse(plaintext.toString('utf8')) as unknown;
    session.receiveSequence = envelope.sequence;
    return value;
  } catch {
    throw new Error('加密消息完整性校验失败。');
  }
}

function eventAckKey(key: Buffer, sessionID: string) {
  return Buffer.from(
    hkdfSync('sha256', key, Buffer.from(sessionID), Buffer.from('rivloom-event-ack-v1'), 32),
  );
}

function eventAckAAD(value: Omit<ChannelEventAck, 'ciphertext' | 'tag'>) {
  return Buffer.from(
    JSON.stringify({
      protocol: value.protocol,
      version: value.version,
      type: value.type,
      sessionID: value.sessionID,
      senderNodeID: value.senderNodeID,
      recipientNodeID: value.recipientNodeID,
      iv: value.iv,
    }),
  );
}

function eventRequestDigest(request: ChannelEnvelope) {
  return createHash('sha256')
    .update(envelopeAAD(request))
    .update('\0')
    .update(request.ciphertext)
    .update('\0')
    .update(request.tag)
    .digest('base64url');
}

export function encryptChannelEventAck(
  session: SecureChannelSession,
  request: ChannelEnvelope,
): ChannelEventAck {
  if (
    session.expiresAt <= Date.now() ||
    request.sessionID !== session.id ||
    request.senderNodeID !== session.peerNodeID ||
    request.recipientNodeID !== session.localNodeID ||
    request.sequence !== session.receiveSequence
  )
    throw new Error('只能确认当前已认证的加密请求。');
  const header: Omit<ChannelEventAck, 'ciphertext' | 'tag'> = {
    protocol: 'rivloom-secure-channel',
    version: 1,
    type: 'event-ack',
    sessionID: session.id,
    senderNodeID: session.localNodeID,
    recipientNodeID: session.peerNodeID,
    iv: randomBytes(12).toString('base64url'),
  };
  const cipher = createCipheriv(
    'aes-256-gcm',
    eventAckKey(session.sendKey, session.id),
    Buffer.from(header.iv, 'base64url'),
  );
  cipher.setAAD(eventAckAAD(header));
  const plaintext = Buffer.from(
    JSON.stringify({
      requestSequence: request.sequence,
      requestDigest: eventRequestDigest(request),
    }),
  );
  return {
    ...header,
    ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  };
}

export function verifyChannelEventAck(
  session: SecureChannelSession,
  request: ChannelEnvelope,
  value: unknown,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ack = value as ChannelEventAck;
  if (
    Object.keys(ack).length !== 9 ||
    ack.protocol !== 'rivloom-secure-channel' ||
    ack.version !== 1 ||
    ack.type !== 'event-ack' ||
    session.expiresAt <= Date.now() ||
    ack.sessionID !== session.id ||
    request.sessionID !== session.id ||
    ack.senderNodeID !== session.peerNodeID ||
    ack.recipientNodeID !== session.localNodeID ||
    request.senderNodeID !== session.localNodeID ||
    request.recipientNodeID !== session.peerNodeID ||
    typeof ack.iv !== 'string' ||
    !/^[A-Za-z0-9_-]{16}$/.test(ack.iv) ||
    typeof ack.ciphertext !== 'string' ||
    ack.ciphertext.length > 1024 ||
    !/^[A-Za-z0-9_-]+$/.test(ack.ciphertext) ||
    typeof ack.tag !== 'string' ||
    !/^[A-Za-z0-9_-]{22}$/.test(ack.tag)
  )
    return false;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      eventAckKey(session.receiveKey, session.id),
      Buffer.from(ack.iv, 'base64url'),
    );
    decipher.setAAD(eventAckAAD(ack));
    decipher.setAuthTag(Buffer.from(ack.tag, 'base64url'));
    const proof = JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(ack.ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8'),
    );
    return (
      proof &&
      Object.keys(proof).length === 2 &&
      proof.requestSequence === request.sequence &&
      proof.requestDigest === eventRequestDigest(request)
    );
  } catch {
    return false;
  }
}
