import Bonjour from 'bonjour-service';
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { listenHttp } from './http-ports.ts';
import { NodeProfileStore } from './node-profile.ts';
import { validNodeProfile, validNodeRemark, type NodeProfile } from '../shared/node-profile.ts';
import type {
  Approval,
  Artifact,
  BrainSummary,
  NodeNetwork as NodeNetworkSnapshot,
  NodePairing,
  Question,
  RemoteTaskControlAction,
  RemoteTaskInvite,
  RivloomNode,
  TaskHardwareRequirements,
  TaskState,
  WorkerRegistration,
} from '../shared/types.ts';
import {
  fingerprintForPublicKey,
  loadNodeIdentity,
  nodeIDForPublicKey,
  nodeProtocolVersion,
  type NodeIdentity,
} from './node-identity.ts';
import {
  NodeTrustStore,
  pairingShortCode,
  unsignedPairingMessage,
  unsignedRevocationMessage,
  validPairingMessage,
  validRevocationMessage,
  verifySignedNodeMessage,
  type PairingMessage,
  type RevocationMessage,
} from './node-trust.ts';
import {
  acceptSecureChannel,
  beginSecureChannel,
  channelMessageWindowMilliseconds,
  channelSessionLifetimeMilliseconds,
  decryptChannelPayload,
  encryptChannelPayload,
  encryptChannelEventAck,
  verifyChannelEventAck,
  finishSecureChannel,
  unsignedChannelAck,
  unsignedChannelOpen,
  unsignedChannelRecovery,
  validChannelAck,
  validChannelEnvelope,
  validChannelOpen,
  validChannelRecovery,
  type ChannelAck,
  type ChannelEnvelope,
  type ChannelOpen,
  type ChannelRecovery,
  type SecureChannelSession,
} from './node-channel.ts';
import {
  RemoteTaskStore,
  validRemoteTaskCancel,
  validRemoteTaskControl,
  validRemoteTaskExecution,
  validRemoteTaskOffer,
  validRemoteTaskPreparation,
  validRemoteTaskResponse,
  type RemoteTaskMessage,
} from './remote-tasks.ts';
import { BrainTopologyStore } from './brain-topology.ts';
import {
  rankBrainPlacements,
  rankBrainWorkers,
  validWorkerRegistration,
} from './worker-resources.ts';
import {
  BrainTaskStore,
  validBrainTaskSubmission,
  validBrainTaskUpdate,
  type BrainTaskMessage,
} from './brain-tasks.ts';
import {
  queueReceiptCapability,
  validNodeQueuePublicStats,
  type NodeQueuePublicStats,
  type TaskQueueReceipt,
} from '../shared/task-queue-receipts.ts';
import {
  TaskQueueReceiptStore,
  validQueueReceiptMessage,
  receiptMatchesRemote,
  type QueueReceiptMessage,
} from './task-queue-receipts.ts';

type MdnsService = {
  fqdn: string;
  port: number;
  txt?: Record<string, unknown>;
  addresses?: string[];
  referer?: { address?: string };
  lastSeen?: number;
};

type Hello = {
  protocolVersion: number;
  nodeID: string;
  name: string;
  brain: BrainSummary;
  capabilities: string[];
  port: number;
  nonce: string;
  issuedAt: number;
  publicKey: string;
  signature: string;
};

type DiscoveryQuery = {
  protocol: 'rivloom-node-discovery';
  version: 1;
  type: 'query';
  nonce: string;
  nodeID: string;
};

type DiscoveryResponse = {
  protocol: 'rivloom-node-discovery';
  version: 1;
  type: 'response';
  nonce: string;
  protocolVersion: number;
  nodeID: string;
  fingerprint: string;
  brainID: string;
  port: number;
};

type DiscoveryDeparture = {
  protocol: 'rivloom-node-discovery';
  version: 1;
  type: 'departure';
  nodeID: string;
  issuedAt: number;
  publicKey: string;
  signature: string;
};

type PairingSession = NodePairing & {
  requesterNodeID: string;
  responderNodeID: string;
  nonce: string;
  peerPublicKey: string;
};

type BrainDirectoryRequest = {
  nodeQueue?: NodeQueuePublicStats | null;
  profile?: NodeProfile;
  type: 'brain-directory-request';
  requestID: string;
  capabilities: string[];
  brains: BrainSummary[];
  hostedBrains: BrainSummary[];
  worker: WorkerRegistration | null;
};

type BrainDirectoryResponse = {
  nodeQueue?: NodeQueuePublicStats | null;
  profile?: NodeProfile;
  type: 'brain-directory-response';
  requestID: string;
  capabilities: string[];
  brains: BrainSummary[];
  hostedBrains: BrainSummary[];
  worker: WorkerRegistration | null;
};

export class NodeNetworkError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const serviceType = 'rivloom';
const capabilities = [
  'brain',
  'executor',
  'human-ui',
  'remote-execution-v1',
  'remote-control-v1',
  'remote-results-v1',
  'brain-task-v1',
  queueReceiptCapability,
];
const maximumHelloBytes = 16 * 1024;
const maximumChannelRequestBytes = 96 * 1024;
const maximumDiscoveryBytes = 2 * 1024;
const defaultDiscoveryPort = 43_531;
const discoveryProtocol = 'rivloom-node-discovery';
const discoveryIntervalMilliseconds = 5_000;
const nodeOfflineAfterMilliseconds = 15_000;
const nodeExpireAfterMilliseconds = 30_000;
const pairingExpireAfterMilliseconds = 5 * 60_000;
const pairingReplayWindowMilliseconds = 10 * 60_000;
const signedMessageWindowMilliseconds = 30_000;
const maximumPendingPairings = 20;
const maximumSecureChannels = 32;

function unsignedHello(value: Omit<Hello, 'signature'>) {
  return JSON.stringify({
    protocolVersion: value.protocolVersion,
    nodeID: value.nodeID,
    name: value.name,
    brain: {
      id: value.brain.id,
      name: value.brain.name,
      masterNodeID: value.brain.masterNodeID,
      state: value.brain.state,
    },
    capabilities: [...value.capabilities].sort(),
    port: value.port,
    nonce: value.nonce,
    issuedAt: value.issuedAt,
    publicKey: value.publicKey,
  });
}

function unsignedDeparture(value: Omit<DiscoveryDeparture, 'signature'>) {
  return JSON.stringify({
    protocol: value.protocol,
    version: value.version,
    type: value.type,
    nodeID: value.nodeID,
    issuedAt: value.issuedAt,
    publicKey: value.publicKey,
  });
}

function normalizedAddress(value: string) {
  const zone = value.indexOf('%');
  const withoutZone = zone === -1 ? value : value.slice(0, zone);
  return withoutZone.startsWith('::ffff:') ? withoutZone.slice(7) : withoutZone;
}

export function discoveryProbeAddresses(service: {
  addresses?: string[];
  referer?: { address?: string };
}) {
  // Never follow an untrusted mDNS A record to another private host. The UDP packet source is
  // the only peer address eligible for the public hello probe.
  const address = normalizedAddress(service.referer?.address || '');
  return isIP(address) === 4 && privateNetworkAddress(address) ? [address] : [];
}

export function privateNetworkAddress(value: string) {
  const address = normalizedAddress(value);
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    return (
      lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || /^fe[89ab]/.test(lower)
    );
  }
  return false;
}

function lanInterfaces() {
  const values = new Map<string, string>();
  for (const records of Object.values(networkInterfaces()))
    for (const record of records || [])
      if (record.family === 'IPv4' && !record.internal && privateNetworkAddress(record.address))
        values.set(record.address, record.netmask);
  return [...values].map(([address, netmask]) => ({ address, netmask }));
}

function localAddresses() {
  return lanInterfaces()
    .map(({ address }) => address)
    .sort();
}

export function directedBroadcastAddress(address: string, netmask: string) {
  const addressParts = address.split('.').map(Number);
  const maskParts = netmask.split('.').map(Number);
  if (
    addressParts.length !== 4 ||
    maskParts.length !== 4 ||
    [...addressParts, ...maskParts].some(
      (part) => !Number.isInteger(part) || part < 0 || part > 255,
    )
  )
    return null;
  return addressParts.map((part, index) => part | (255 ^ maskParts[index])).join('.');
}

export function nodePresence(lastSeen: string, now = Date.now()) {
  const seenAt = Date.parse(lastSeen);
  if (!Number.isFinite(seenAt) || now - seenAt >= nodeExpireAfterMilliseconds) return 'expired';
  return now - seenAt >= nodeOfflineAfterMilliseconds ? 'offline' : 'online';
}

function text(value: unknown) {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (typeof value === 'number') return String(value);
  return '';
}

function serviceIdentity(service: MdnsService) {
  return {
    protocolVersion: Number(text(service.txt?.pv)),
    nodeID: text(service.txt?.id),
    fingerprint: text(service.txt?.fp),
    brainID: text(service.txt?.brain),
  };
}

function publicNode(
  identity: NodeIdentity,
  port: number,
  brains: BrainSummary[],
  worker: WorkerRegistration | null,
): RivloomNode {
  return {
    id: identity.nodeID,
    name: `Rivloom ${identity.nodeID.slice(0, 6)}`,
    fingerprint: identity.fingerprint,
    protocolVersion: nodeProtocolVersion,
    addresses: localAddresses(),
    port,
    online: true,
    local: true,
    trusted: true,
    channelReady: true,
    verified: true,
    lastSeen: new Date().toISOString(),
    capabilities,
    brains: brains.map((brain) => ({ ...brain })),
    worker,
  };
}

function validBrainSummary(value: unknown): value is BrainSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    /^[0-9a-f-]{36}$/i.test(item.id) &&
    typeof item.name === 'string' &&
    item.name.length >= 1 &&
    item.name.length <= 80 &&
    typeof item.masterNodeID === 'string' &&
    /^[A-Za-z0-9_-]{32}$/.test(item.masterNodeID) &&
    (item.state === 'provisional' || item.state === 'established') &&
    (item.queueDepth === undefined ||
      (Number.isSafeInteger(item.queueDepth) && Number(item.queueDepth) >= 0))
  );
}

function validHello(value: unknown): value is Hello {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const brain = item.brain as Record<string, unknown> | undefined;
  return (
    item.protocolVersion === nodeProtocolVersion &&
    typeof item.nodeID === 'string' &&
    /^[A-Za-z0-9_-]{32}$/.test(item.nodeID) &&
    typeof item.name === 'string' &&
    item.name.length >= 1 &&
    item.name.length <= 80 &&
    !!brain &&
    validBrainSummary(brain) &&
    Array.isArray(item.capabilities) &&
    item.capabilities.length <= 12 &&
    item.capabilities.every((entry) => typeof entry === 'string' && entry.length <= 30) &&
    Number.isInteger(item.port) &&
    Number(item.port) >= 1 &&
    Number(item.port) <= 65_535 &&
    typeof item.nonce === 'string' &&
    /^[A-Za-z0-9_-]{32}$/.test(item.nonce) &&
    Number.isInteger(item.issuedAt) &&
    typeof item.publicKey === 'string' &&
    item.publicKey.length <= 512 &&
    typeof item.signature === 'string' &&
    item.signature.length <= 256
  );
}

function validBrainDirectoryRequest(value: unknown): value is BrainDirectoryRequest {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    item.type === 'brain-directory-request' &&
    (item.nodeQueue === undefined ||
      item.nodeQueue === null ||
      validNodeQueuePublicStats(item.nodeQueue)) &&
    (item.profile === undefined || validNodeProfile(item.profile)) &&
    typeof item.requestID === 'string' &&
    /^[0-9a-f-]{36}$/i.test(item.requestID) &&
    Array.isArray(item.capabilities) &&
    item.capabilities.length <= 12 &&
    item.capabilities.every((entry) => typeof entry === 'string' && entry.length <= 30) &&
    Array.isArray(item.brains) &&
    item.brains.length <= 32 &&
    item.brains.every(validBrainSummary) &&
    Array.isArray(item.hostedBrains) &&
    item.hostedBrains.length <= 8 &&
    item.hostedBrains.every(validBrainSummary) &&
    (item.worker === null || validWorkerRegistration(item.worker))
  );
}

function validBrainDirectoryResponse(value: unknown): value is BrainDirectoryResponse {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const brains = item.brains;
  return (
    item.type === 'brain-directory-response' &&
    (item.nodeQueue === undefined ||
      item.nodeQueue === null ||
      validNodeQueuePublicStats(item.nodeQueue)) &&
    (item.profile === undefined || validNodeProfile(item.profile)) &&
    typeof item.requestID === 'string' &&
    /^[0-9a-f-]{36}$/i.test(item.requestID) &&
    Array.isArray(item.capabilities) &&
    item.capabilities.length <= 12 &&
    item.capabilities.every((entry) => typeof entry === 'string' && entry.length <= 30) &&
    Array.isArray(brains) &&
    brains.length <= 32 &&
    brains.every(validBrainSummary) &&
    Array.isArray(item.hostedBrains) &&
    item.hostedBrains.length <= 8 &&
    item.hostedBrains.every(validBrainSummary) &&
    (item.worker === null || validWorkerRegistration(item.worker))
  );
}

function validDiscoveryQuery(value: unknown): value is DiscoveryQuery {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    item.protocol === discoveryProtocol &&
    item.version === 1 &&
    item.type === 'query' &&
    typeof item.nonce === 'string' &&
    /^[A-Za-z0-9_-]{32}$/.test(item.nonce) &&
    typeof item.nodeID === 'string' &&
    /^[A-Za-z0-9_-]{32}$/.test(item.nodeID)
  );
}

function validDiscoveryResponse(value: unknown): value is DiscoveryResponse {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    item.protocol === discoveryProtocol &&
    item.version === 1 &&
    item.type === 'response' &&
    typeof item.nonce === 'string' &&
    /^[A-Za-z0-9_-]{32}$/.test(item.nonce) &&
    item.protocolVersion === nodeProtocolVersion &&
    typeof item.nodeID === 'string' &&
    /^[A-Za-z0-9_-]{32}$/.test(item.nodeID) &&
    typeof item.fingerprint === 'string' &&
    /^[0-9A-F:]{79}$/i.test(item.fingerprint) &&
    typeof item.brainID === 'string' &&
    /^[0-9a-f-]{36}$/i.test(item.brainID) &&
    Number.isInteger(item.port) &&
    Number(item.port) >= 1 &&
    Number(item.port) <= 65_535
  );
}

function validDiscoveryDeparture(value: unknown): value is DiscoveryDeparture {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    item.protocol === discoveryProtocol &&
    item.version === 1 &&
    item.type === 'departure' &&
    typeof item.nodeID === 'string' &&
    /^[A-Za-z0-9_-]{32}$/.test(item.nodeID) &&
    Number.isInteger(item.issuedAt) &&
    typeof item.publicKey === 'string' &&
    item.publicKey.length <= 512 &&
    typeof item.signature === 'string' &&
    item.signature.length <= 256
  );
}

async function limitedJson(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('节点响应没有正文。');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumHelloBytes) {
      await reader.cancel();
      throw new Error('节点响应过大。');
    }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  return JSON.parse(body) as unknown;
}

async function requestJson(request: IncomingMessage, maximumBytes = maximumHelloBytes) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json'))
    throw new NodeNetworkError(415, '节点请求必须使用 JSON。');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maximumBytes) throw new NodeNetworkError(413, '节点请求过大。');
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new NodeNetworkError(400, '节点请求不是有效 JSON。');
  }
}

function jsonResponse(response: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

export class NodeNetwork extends EventEmitter {
  private status: NodeNetworkSnapshot['status'];
  private error: string | null = null;
  private identity: NodeIdentity | null = null;
  private peerPort = 0;
  private peerServer: Server | null = null;
  private bonjour: Bonjour | null = null;
  private browser: ReturnType<Bonjour['find']> | null = null;
  private service: ReturnType<Bonjour['publish']> | null = null;
  private discoverySocket: Socket | null = null;
  private readonly discoveryQuerySockets = new Set<Socket>();
  private discoveryPort = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly nodes = new Map<string, RivloomNode>();
  private readonly probing = new Set<string>();
  private readonly discoveryQueries = new Map<string, number>();
  private readonly requests = new Map<string, { count: number; until: number }>();
  private readonly pairings = new Map<string, PairingSession>();
  private readonly seenPairings = new Map<string, number>();
  private readonly sendingRevocations = new Set<string>();
  private readonly revocationAttempts = new Map<string, number>();
  private readonly channels = new Map<string, SecureChannelSession>();
  private readonly openingChannels = new Set<string>();
  private readonly requestingChannelRecovery = new Set<string>();
  private readonly seenChannelOpens = new Map<string, number>();
  private readonly seenChannelRecoveries = new Map<string, number>();
  private readonly channelSendQueues = new Map<string, Promise<unknown>>();
  private readonly syncingDirectories = new Set<string>();
  private readonly deliveringRemoteTasks = new Set<string>();
  private readonly deliveringBrainTasks = new Set<string>();
  private readonly deliveringQueueReceipts = new Set<string>();
  private readonly replayedQueueChannels = new Map<string, string>();
  private readonly schedulingBrainTasks = new Set<string>();
  private readonly trustStore: NodeTrustStore;
  private readonly profiles: NodeProfileStore;
  private readonly remoteTasks: RemoteTaskStore;
  private readonly brainTasks: BrainTaskStore;
  private readonly queueReceipts: TaskQueueReceiptStore;
  private nodeQueueProvider: (() => NodeQueuePublicStats | null) | null = null;
  private remoteQueueStartGuard: ((taskID: string) => boolean) | null = null;
  private remoteTaskQueueIntake: ((task: RemoteTaskInvite) => void) | null = null;
  private readonly topology: BrainTopologyStore;
  private workerRegistrationProvider: ((nodeID: string) => WorkerRegistration | null) | null = null;
  private provisionalStartedAt = 0;
  private readonly root: string;
  private readonly enabled: boolean;

  constructor(root: string, enabled = process.env.RIVLOOM_NODE_NETWORK !== 'disabled') {
    super();
    this.root = root;
    this.trustStore = new NodeTrustStore(root);
    this.profiles = new NodeProfileStore(root);
    this.remoteTasks = new RemoteTaskStore(root);
    this.brainTasks = new BrainTaskStore(root);
    this.queueReceipts = new TaskQueueReceiptStore(root);
    this.topology = new BrainTopologyStore(root);
    this.enabled = enabled;
    this.status = enabled ? 'starting' : 'disabled';
  }

  snapshot(): NodeNetworkSnapshot {
    const localWorker = this.currentWorker();
    const advertisedBrains = this.directoryBrains();
    const brains = this.topology.all().map((brain) => {
      const masterNode = this.nodes.get(brain.masterNodeID);
      const master =
        brain.masterNodeID === this.identity?.nodeID
          ? this.status === 'online'
          : !!masterNode?.online && masterNode.trusted && masterNode.channelReady;
      const workers = [
        ...(localWorker ? [localWorker] : []),
        ...[...this.nodes.values()]
          .filter(
            (node) =>
              node.online &&
              node.trusted &&
              node.channelReady &&
              node.worker &&
              node.brains.some((candidate) => candidate.id === brain.id),
          )
          .map((node) => node.worker!),
      ].sort((left, right) => left.nodeID.localeCompare(right.nodeID));
      return {
        ...brain,
        hosted: brain.masterNodeID === this.identity?.nodeID,
        online: master,
        queueDepth:
          brain.masterNodeID === this.identity?.nodeID
            ? this.queueDepth(brain.id)
            : (masterNode?.brains.find((candidate) => candidate.id === brain.id)?.queueDepth ?? 0),
        workers,
      };
    });
    return {
      status: this.status,
      serviceType: `_${serviceType}._tcp.local · LAN UDP ${this.discoveryPort || defaultDiscoveryPort}`,
      local: this.identity
        ? {
            ...publicNode(this.identity, this.peerPort, advertisedBrains, localWorker),
            ...this.profiles.local(this.identity.nodeID),
            nodeQueue: this.currentNodeQueue(),
          }
        : null,
      nearby: [...this.nodes.values()]
        .map((node) => {
          const metadata = this.profiles.peer(node.id, node.fingerprint);
          return {
            ...node,
            ...(metadata?.remark ? { remark: metadata.remark } : {}),
            ...(metadata?.lastUsedAt ? { lastUsedAt: metadata.lastUsedAt } : {}),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name)),
      paired: this.trustStore.records().map((record) => {
        const live = this.nodes.get(record.nodeID);
        const metadata = this.profiles.peer(record.nodeID, record.fingerprint);
        if (live?.fingerprint === record.fingerprint)
          return {
            ...live,
            ...(metadata?.remark ? { remark: metadata.remark } : {}),
            ...(metadata?.lastUsedAt ? { lastUsedAt: metadata.lastUsedAt } : {}),
          };
        return {
          id: record.nodeID,
          name: `Rivloom ${record.nodeID.slice(0, 6)}`,
          icon: 'monitor',
          ...this.profiles.peer(record.nodeID, record.fingerprint),
          fingerprint: record.fingerprint,
          protocolVersion: nodeProtocolVersion,
          addresses: [],
          port: 0,
          online: false,
          local: false,
          trusted: true,
          channelReady: false,
          verified: false,
          lastSeen: record.pairedAt,
          capabilities: [],
          brains: [],
          worker: null,
        };
      }),
      brains,
      pairings: [...this.pairings.values()]
        .map(
          ({
            peerPublicKey: _peerPublicKey,
            requesterNodeID: _requester,
            responderNodeID: _responder,
            nonce: _nonce,
            ...pairing
          }) => pairing,
        )
        .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt)),
      remoteTasks: this.remoteTasks.list().map((task) => ({
        ...task,
        queueReceipt: this.queueReceipts.get(`remote:${task.id}`),
      })),
      brainTasks: this.brainTasks.list().map((task) => {
        const receipt = this.queueReceipts.get(`brain:${task.id}`);
        return {
          ...task,
          queueReceipt: receipt?.remoteTaskID === task.executionID ? receipt : null,
        };
      }),
      error: this.error,
    };
  }

  setWorkerRegistrationProvider(provider: ((nodeID: string) => WorkerRegistration | null) | null) {
    this.workerRegistrationProvider = provider;
    this.update();
  }

  setNodeQueueProvider(provider: (() => NodeQueuePublicStats | null) | null) {
    this.nodeQueueProvider = provider;
  }
  private currentNodeQueue() {
    const value = this.nodeQueueProvider?.() ?? null;
    return validNodeQueuePublicStats(value) ? value : null;
  }
  setRemoteQueueStartGuard(guard: ((taskID: string) => boolean) | null) {
    this.remoteQueueStartGuard = guard;
  }
  setRemoteTaskQueueIntake(intake: ((task: RemoteTaskInvite) => void) | null) {
    this.remoteTaskQueueIntake = intake;
  }
  remoteTaskRecords() {
    return this.remoteTasks.list();
  }

  async publishTaskQueueReceipt(
    taskID: string,
    input: Pick<TaskQueueReceipt, 'state' | 'position' | 'reason'>,
  ) {
    const remote = this.remoteTasks.record(taskID);
    if (!remote || remote.direction !== 'incoming')
      throw new NodeNetworkError(404, '接收任务不存在。');
    const receipt = this.queueReceipts.publish(
      this.remoteTasks.list().find((task) => task.id === taskID)!,
      input,
    );
    this.update();
    await this.flushQueueReceipts(remote.ownerNodeID);
    return receipt;
  }

  saveProfile(profile: NodeProfile) {
    if (!this.identity) throw new NodeNetworkError(409, '节点身份尚未就绪。');
    if (!validNodeProfile(profile)) throw new NodeNetworkError(400, '节点名称或图标无效。');
    this.profiles.saveLocal(profile);
    this.update();
    for (const node of this.nodes.values())
      if (node.online && node.trusted && node.channelReady)
        void this.syncBrainDirectory(node).catch(() => undefined);
    return this.profiles.local(this.identity.nodeID);
  }

  savePeerRemark(nodeID: string, remark: string | null) {
    if (remark !== null && !validNodeRemark(remark)) {
      throw new NodeNetworkError(400, '节点备注名无效。');
    }

    const trust = this.trustStore.record(nodeID);
    if (!trust) throw new NodeNetworkError(404, '该节点尚未与本机配对。');
    const live = this.nodes.get(nodeID);
    const cached = this.profiles.peer(nodeID, trust.fingerprint);
    this.profiles.saveRemark(
      nodeID,
      trust.fingerprint,
      {
        name: live?.name || cached?.name || `Rivloom ${nodeID.slice(0, 6)}`,
        icon: live?.icon || cached?.icon || 'monitor',
      },
      remark,
    );
    this.update();
    return this.snapshot();
  }

  private currentWorker() {
    if (!this.identity || !this.workerRegistrationProvider) return null;
    try {
      const worker = this.workerRegistrationProvider(this.identity.nodeID);
      return validWorkerRegistration(worker) && worker.nodeID === this.identity.nodeID
        ? worker
        : null;
    } catch {
      return null;
    }
  }

  private advertisedBrain() {
    const brain = this.topology.hosted()[0] || this.topology.all()[0];
    if (brain) return brain;
    return {
      id: this.identity!.brainID,
      name: `Brain ${this.identity!.brainID.slice(0, 6)}`,
      masterNodeID: this.identity!.nodeID,
      state: 'provisional' as const,
    };
  }

  private queueDepth(brainID: string) {
    return this.brainTasks
      .list()
      .filter(
        (task) =>
          task.brainID === brainID &&
          task.direction === 'owned' &&
          task.status !== 'completed' &&
          task.status !== 'failed',
      ).length;
  }

  private directoryBrains() {
    return this.topology
      .all()
      .map((brain) =>
        brain.masterNodeID === this.identity?.nodeID
          ? { ...brain, queueDepth: this.queueDepth(brain.id) }
          : brain,
      );
  }

  private knowsBrain(brainID: string) {
    return this.topology.all().some((brain) => brain.id === brainID);
  }

  private hostsBrain(brainID: string) {
    return this.topology
      .hosted()
      .some((brain) => brain.id === brainID && brain.masterNodeID === this.identity?.nodeID);
  }

  private update() {
    for (const brainTask of this.brainTasks.list()) {
      if (brainTask.direction !== 'owned' || !brainTask.executionID) continue;
      let execution = this.remoteTasks
        .list()
        .find((candidate) => candidate.id === brainTask.executionID);
      const worker = execution ? this.nodes.get(execution.targetNodeID) : null;
      if (
        execution?.direction === 'outgoing' &&
        execution.status === 'pending' &&
        (!worker || !worker.online)
      ) {
        try {
          this.remoteTasks.cancel(execution.id);
          execution = this.remoteTasks.list().find((candidate) => candidate.id === execution!.id);
        } catch {
          /* A concurrently accepted or started Execution is deliberately not reassigned. */
        }
      }
      if (!execution) continue;
      let changed = this.brainTasks.syncExecution(brainTask.id, execution, !worker?.online);
      if (
        execution.executionSequence === 0 &&
        (execution.status === 'declined' ||
          execution.status === 'expired' ||
          execution.status === 'cancelled')
      ) {
        const reason =
          execution.status === 'declined'
            ? 'Worker 在本机最终准入时拒绝了这次 Execution；Task 保持原 Brain，等待其他 Worker。'
            : execution.status === 'expired'
              ? 'Worker 未在邀请期限内接受这次 Execution；Task 保持原 Brain，等待重新调度。'
              : 'Worker 离线前尚未接受这次 Execution；旧邀请已取消，Task 等待重新调度。';
        if (this.brainTasks.requeueExecution(brainTask.id, execution, reason)) {
          changed = true;
          queueMicrotask(() => void this.scheduleBrainTask(brainTask.id));
        }
      }
      if (changed) queueMicrotask(() => void this.flushBrainTask(brainTask.id));
    }
    this.emit('update', this.snapshot());
  }

  private fail(message: string) {
    this.status = 'degraded';
    this.error = message;
    this.update();
  }

  private allowed(remoteAddress: string | undefined) {
    return !!remoteAddress && privateNetworkAddress(remoteAddress);
  }

  private rateLimited(
    remoteAddress: string,
    scope: 'discovery' | 'hello' | 'control' | 'channel' = 'control',
  ) {
    const at = Date.now();
    for (const [key, value] of this.requests) if (value.until < at) this.requests.delete(key);
    // Discovery bursts must not consume the budget used by authenticated heartbeats/tasks.
    // Every class is still bounded before authentication and uses the actual socket address.
    const key = `${scope}:${normalizedAddress(remoteAddress)}`;
    const limit = scope === 'channel' ? 600 : scope === 'hello' ? 120 : 60;
    if (!this.requests.has(key) && this.requests.size >= 1024) return true;
    const bucket = this.requests.get(key) || { count: 0, until: at + 60_000 };
    bucket.count++;
    this.requests.set(key, bucket);
    return bucket.count > limit;
  }

  private nodeForRemote(nodeID: string, remoteAddress: string | undefined) {
    const node = this.nodes.get(nodeID);
    const remote = normalizedAddress(remoteAddress || '');
    return node?.verified && node.addresses.map(normalizedAddress).includes(remote) ? node : null;
  }

  private signedPairing(
    type: PairingMessage['type'],
    pairing: Pick<PairingSession, 'id' | 'requesterNodeID' | 'responderNodeID' | 'nonce'>,
  ): PairingMessage {
    if (!this.identity) throw new NodeNetworkError(503, '本机节点身份尚未就绪。');
    const unsigned: Omit<PairingMessage, 'signature'> = {
      protocol: 'rivloom-node-pairing',
      version: 1,
      type,
      pairingID: pairing.id,
      requesterNodeID: pairing.requesterNodeID,
      responderNodeID: pairing.responderNodeID,
      nonce: pairing.nonce,
      actorNodeID: this.identity.nodeID,
      issuedAt: Date.now(),
      publicKey: this.identity.publicKey,
    };
    return { ...unsigned, signature: this.identity.sign(unsignedPairingMessage(unsigned)) };
  }

  private signedRevocation(nodeID: string): RevocationMessage {
    if (!this.identity) throw new NodeNetworkError(503, '本机节点身份尚未就绪。');
    const unsigned: Omit<RevocationMessage, 'signature'> = {
      protocol: 'rivloom-node-trust',
      version: 1,
      type: 'revoke',
      nodeID: this.identity.nodeID,
      peerNodeID: nodeID,
      issuedAt: Date.now(),
      publicKey: this.identity.publicKey,
    };
    return { ...unsigned, signature: this.identity.sign(unsignedRevocationMessage(unsigned)) };
  }

  private signedChannelRecovery(nodeID: string): ChannelRecovery {
    if (!this.identity) throw new NodeNetworkError(503, '本机节点身份尚未就绪。');
    const unsigned: Omit<ChannelRecovery, 'signature'> = {
      protocol: 'rivloom-secure-channel',
      version: 1,
      type: 'recover',
      recoveryID: randomUUID(),
      requesterNodeID: this.identity.nodeID,
      responderNodeID: nodeID,
      issuedAt: Date.now(),
      publicKey: this.identity.publicKey,
    };
    return { ...unsigned, signature: this.identity.sign(unsignedChannelRecovery(unsigned)) };
  }

  private validPairingFrom(
    message: PairingMessage,
    node: RivloomNode,
    expectedType: PairingMessage['type'],
  ) {
    return (
      message.type === expectedType &&
      message.actorNodeID === node.id &&
      Math.abs(Date.now() - message.issuedAt) <= signedMessageWindowMilliseconds &&
      verifySignedNodeMessage(
        message.publicKey,
        message.actorNodeID,
        node.fingerprint,
        unsignedPairingMessage({
          protocol: message.protocol,
          version: message.version,
          type: message.type,
          pairingID: message.pairingID,
          requesterNodeID: message.requesterNodeID,
          responderNodeID: message.responderNodeID,
          nonce: message.nonce,
          actorNodeID: message.actorNodeID,
          issuedAt: message.issuedAt,
          publicKey: message.publicKey,
        }),
        message.signature,
      )
    );
  }

  private channelReady(nodeID: string) {
    const channel = this.channels.get(nodeID);
    if (!channel || channel.expiresAt <= Date.now()) {
      if (channel) this.forgetChannel(nodeID);
      return false;
    }
    return true;
  }

  private forgetChannel(nodeID: string) {
    const channel = this.channels.get(nodeID);
    if (!channel) return false;
    channel.sendKey.fill(0);
    channel.receiveKey.fill(0);
    return this.channels.delete(nodeID);
  }

  private closeChannel(nodeID: string, notify = true) {
    const removed = this.forgetChannel(nodeID);
    const node = this.nodes.get(nodeID);
    if (node?.channelReady) this.nodes.set(nodeID, { ...node, channelReady: false });
    if (notify && (removed || node?.channelReady)) this.update();
  }

  private validChannelOpenFrom(message: ChannelOpen, node: RivloomNode) {
    if (!this.identity || message.responderNodeID !== this.identity.nodeID) return false;
    const record = this.trustStore.record(node.id);
    return (
      !!record &&
      message.initiatorNodeID === node.id &&
      message.initiatorNodeID.localeCompare(message.responderNodeID) < 0 &&
      message.publicKey === record.publicKey &&
      Math.abs(Date.now() - message.issuedAt) <= channelMessageWindowMilliseconds &&
      message.issuedAt >= Date.parse(record.pairedAt) &&
      verifySignedNodeMessage(
        message.publicKey,
        message.initiatorNodeID,
        record.fingerprint,
        unsignedChannelOpen({
          protocol: message.protocol,
          version: message.version,
          type: message.type,
          sessionID: message.sessionID,
          initiatorNodeID: message.initiatorNodeID,
          responderNodeID: message.responderNodeID,
          nonce: message.nonce,
          issuedAt: message.issuedAt,
          ephemeralPublicKey: message.ephemeralPublicKey,
          publicKey: message.publicKey,
        }),
        message.signature,
      )
    );
  }

  private validChannelAckFrom(message: ChannelAck, open: ChannelOpen, node: RivloomNode) {
    const record = this.trustStore.record(node.id);
    return (
      !!record &&
      message.sessionID === open.sessionID &&
      message.initiatorNodeID === open.initiatorNodeID &&
      message.responderNodeID === open.responderNodeID &&
      message.requestNonce === open.nonce &&
      message.publicKey === record.publicKey &&
      Math.abs(Date.now() - message.issuedAt) <= channelMessageWindowMilliseconds &&
      message.issuedAt >= Date.parse(record.pairedAt) &&
      verifySignedNodeMessage(
        message.publicKey,
        message.responderNodeID,
        record.fingerprint,
        unsignedChannelAck({
          protocol: message.protocol,
          version: message.version,
          type: message.type,
          sessionID: message.sessionID,
          initiatorNodeID: message.initiatorNodeID,
          responderNodeID: message.responderNodeID,
          requestNonce: message.requestNonce,
          responseNonce: message.responseNonce,
          issuedAt: message.issuedAt,
          ephemeralPublicKey: message.ephemeralPublicKey,
          publicKey: message.publicKey,
        }),
        message.signature,
      )
    );
  }

  private validChannelRecoveryFrom(message: ChannelRecovery, node: RivloomNode) {
    if (!this.identity || message.responderNodeID !== this.identity.nodeID) return false;
    const record = this.trustStore.record(node.id);
    return (
      !!record &&
      message.requesterNodeID === node.id &&
      message.requesterNodeID.localeCompare(message.responderNodeID) > 0 &&
      message.publicKey === record.publicKey &&
      Math.abs(Date.now() - message.issuedAt) <= channelMessageWindowMilliseconds &&
      message.issuedAt >= Date.parse(record.pairedAt) &&
      verifySignedNodeMessage(
        message.publicKey,
        message.requesterNodeID,
        record.fingerprint,
        unsignedChannelRecovery({
          protocol: message.protocol,
          version: message.version,
          type: message.type,
          recoveryID: message.recoveryID,
          requesterNodeID: message.requesterNodeID,
          responderNodeID: message.responderNodeID,
          issuedAt: message.issuedAt,
          publicKey: message.publicKey,
        }),
        message.signature,
      )
    );
  }

  private handleChannelOpen(message: ChannelOpen, remote: string | undefined) {
    if (!this.identity) throw new NodeNetworkError(503, '本机节点身份尚未就绪。');
    const node = this.nodeForRemote(message.initiatorNodeID, remote);
    if (!node || !this.validChannelOpenFrom(message, node))
      throw new NodeNetworkError(403, '加密通道握手身份校验失败。');
    if (this.seenChannelOpens.has(message.sessionID))
      throw new NodeNetworkError(409, '加密通道握手已处理。');
    if (!this.channels.has(node.id) && this.channels.size >= maximumSecureChannels)
      throw new NodeNetworkError(429, '当前加密通道数量已达上限。');
    try {
      const accepted = acceptSecureChannel(message, this.identity);
      this.seenChannelOpens.set(message.sessionID, Date.now() + channelSessionLifetimeMilliseconds);
      this.forgetChannel(node.id);
      this.channels.set(node.id, accepted.session);
      this.nodes.set(node.id, { ...node, channelReady: true });
      this.update();
      return accepted.ack;
    } catch {
      throw new NodeNetworkError(400, '加密通道临时公钥无效。');
    }
  }

  private handleChannelRecovery(message: ChannelRecovery, remote: string | undefined) {
    const node = this.nodeForRemote(message.requesterNodeID, remote);
    if (!node || !this.validChannelRecoveryFrom(message, node))
      throw new NodeNetworkError(403, '加密通道恢复请求身份校验失败。');
    if (this.seenChannelRecoveries.has(message.recoveryID))
      throw new NodeNetworkError(409, '加密通道恢复请求已处理。');
    this.seenChannelRecoveries.set(
      message.recoveryID,
      Date.now() + channelMessageWindowMilliseconds,
    );
    this.closeChannel(node.id);
    queueMicrotask(() => {
      const current = this.nodes.get(node.id);
      if (current?.online && current.trusted) void this.openSecureChannel(current);
    });
  }

  private handleChannelMessage(value: ChannelEnvelope, remote: string | undefined) {
    const node = this.nodeForRemote(value.senderNodeID, remote);
    const record = node ? this.trustStore.record(node.id) : null;
    const channel = node ? this.channels.get(node.id) : null;
    if (!node || !record || !node.trusted || record.fingerprint !== node.fingerprint) {
      if (node) this.closeChannel(node.id);
      throw new NodeNetworkError(403, '加密通道未建立或已经失效。');
    }
    if (!channel) throw new NodeNetworkError(403, '加密通道未建立或已经失效。');
    if (channel.expiresAt <= Date.now()) {
      this.closeChannel(node.id);
      throw new NodeNetworkError(403, '加密通道未建立或已经失效。');
    }
    // An unauthenticated stale/session-id packet must not be able to tear down the current channel.
    if (channel.id !== value.sessionID)
      throw new NodeNetworkError(403, '加密通道未建立或已经失效。');
    let message: unknown;
    try {
      message = decryptChannelPayload(channel, value);
    } catch {
      throw new NodeNetworkError(403, '加密消息完整性、顺序或时间校验失败。');
    }
    const eventAck = () =>
      node.capabilities.includes(queueReceiptCapability)
        ? encryptChannelEventAck(channel, value)
        : null;
    if (validBrainDirectoryRequest(message)) {
      if (
        (message.worker && message.worker.nodeID !== node.id) ||
        message.hostedBrains.some(
          (brain) =>
            brain.masterNodeID !== node.id ||
            !message.brains.some((candidate) => candidate.id === brain.id),
        )
      )
        throw new NodeNetworkError(409, 'Brain 目录中的 Node 归属无效。');
      const topologyChanged = this.topology.reconcile(node.id, message.hostedBrains);
      const response: BrainDirectoryResponse = {
        ...(message.capabilities.includes(queueReceiptCapability)
          ? { nodeQueue: this.currentNodeQueue() }
          : {}),
        profile: this.profiles.local(this.identity!.nodeID),
        type: 'brain-directory-response',
        requestID: message.requestID,
        capabilities,
        brains: this.directoryBrains(),
        hostedBrains: this.topology.hosted(),
        worker: this.currentWorker(),
      };
      const envelope = encryptChannelPayload(channel, response);
      const current = this.nodes.get(node.id);
      if (message.profile) this.profiles.remember(node.id, node.fingerprint, message.profile);
      if (current)
        this.nodes.set(node.id, {
          ...current,
          ...(message.profile ? { name: message.profile.name, icon: message.profile.icon } : {}),
          channelReady: true,
          online: true,
          lastSeen: new Date().toISOString(),
          capabilities: [...new Set(message.capabilities)].sort(),
          brains: message.brains.map((brain) => ({ ...brain })),
          worker: message.worker,
          nodeQueue: message.capabilities.includes(queueReceiptCapability)
            ? (message.nodeQueue ?? null)
            : null,
        });
      if (topologyChanged || current) this.update();
      const flushAfterResponse = setTimeout(() => {
        void this.flushRemoteTasks(node.id);
        void this.flushBrainTasks(node.id);
        this.replayQueueForChannel(node.id);
      }, 100);
      flushAfterResponse.unref();
      return envelope;
    }
    if (validQueueReceiptMessage(message)) {
      if (!node.capabilities.includes(queueReceiptCapability))
        throw new NodeNetworkError(409, '尚未协商队列回执能力。');
      try {
        this.receiveQueueReceipt(node.id, message);
      } catch {
        throw new NodeNetworkError(409, '队列回执路由、序号或任务状态冲突。');
      }
      this.update();
      return eventAck();
    }
    if (validBrainTaskSubmission(message)) {
      if (
        message.submitterNodeID !== node.id ||
        message.masterNodeID !== this.identity!.nodeID ||
        !this.hostsBrain(message.brainID)
      )
        throw new NodeNetworkError(409, 'Brain Task 提交路由与 Master 不匹配。');
      let changed = false;
      try {
        changed = this.brainTasks.receiveSubmission(message);
      } catch {
        throw new NodeNetworkError(409, 'Brain Task 提交冲突或已经失效。');
      }
      if (changed) this.update();
      queueMicrotask(() => void this.scheduleBrainTask(message.taskID));
      return eventAck();
    }
    if (validBrainTaskUpdate(message)) {
      if (
        message.masterNodeID !== node.id ||
        message.submitterNodeID !== this.identity!.nodeID ||
        !node.brains.some((brain) => brain.id === message.brainID && brain.masterNodeID === node.id)
      )
        throw new NodeNetworkError(409, 'Brain Task 更新路由与提交节点不匹配。');
      try {
        this.brainTasks.receiveUpdate(message);
      } catch {
        throw new NodeNetworkError(409, 'Brain Task 更新冲突或已经失效。');
      }
      this.update();
      return eventAck();
    }
    let changed = false;
    let receivedOfferID: string | null = null;
    let receivedControl: { taskID: string; controlID: string } | null = null;
    try {
      if (validRemoteTaskOffer(message)) {
        if (
          message.ownerNodeID !== node.id ||
          message.targetNodeID !== this.identity!.nodeID ||
          message.ownerBrainID !== message.targetBrainID ||
          !node.brains.some((brain) => brain.id === message.ownerBrainID) ||
          !this.knowsBrain(message.targetBrainID)
        )
          throw new Error('远端任务邀请路由与当前节点不匹配。');
        changed = this.remoteTasks.receiveOffer(message);
        try {
          this.remoteTaskQueueIntake?.(
            this.remoteTasks.list().find((task) => task.id === message.taskID)!,
          );
        } catch (error) {
          if (
            error instanceof NodeNetworkError &&
            error.status === 409 &&
            this.remoteTasks.record(message.taskID)?.status === 'pending'
          ) {
            this.remoteTasks.decide(message.taskID, 'declined');
            queueMicrotask(() => void this.flushRemoteTask(message.taskID));
          }
          if (error instanceof NodeNetworkError) throw error;
          throw new NodeNetworkError(503, '目标 Node 尚未确认队列持久化，稍后使用原请求重试。');
        }
        if (changed) receivedOfferID = message.taskID;
      } else if (validRemoteTaskResponse(message)) {
        if (
          message.ownerNodeID !== this.identity!.nodeID ||
          message.targetNodeID !== node.id ||
          !this.knowsBrain(message.ownerBrainID) ||
          message.ownerBrainID !== message.targetBrainID ||
          !node.brains.some((brain) => brain.id === message.targetBrainID)
        )
          throw new Error('远端任务回复路由与当前节点不匹配。');
        changed = this.remoteTasks.receiveResponse(message);
      } else if (validRemoteTaskPreparation(message)) {
        if (
          message.ownerNodeID !== this.identity!.nodeID ||
          message.targetNodeID !== node.id ||
          !this.knowsBrain(message.ownerBrainID) ||
          message.ownerBrainID !== message.targetBrainID ||
          !node.brains.some((brain) => brain.id === message.targetBrainID)
        )
          throw new Error('远端执行准备路由与当前节点不匹配。');
        changed = this.remoteTasks.receivePreparation(message);
      } else if (validRemoteTaskExecution(message)) {
        if (
          message.ownerNodeID !== this.identity!.nodeID ||
          message.targetNodeID !== node.id ||
          !this.knowsBrain(message.ownerBrainID) ||
          message.ownerBrainID !== message.targetBrainID ||
          !node.brains.some((brain) => brain.id === message.targetBrainID)
        )
          throw new Error('远端执行状态路由与当前节点不匹配。');
        changed = this.remoteTasks.receiveExecution(message);
      } else if (validRemoteTaskControl(message)) {
        if (
          message.action.kind === 'supplement' &&
          this.remoteQueueStartGuard?.(message.taskID) === false
        )
          throw new NodeNetworkError(409, '任务已被执行节点终止，不能重新启动。');
        if (
          message.ownerNodeID !== node.id ||
          message.targetNodeID !== this.identity!.nodeID ||
          !node.brains.some((brain) => brain.id === message.ownerBrainID) ||
          message.ownerBrainID !== message.targetBrainID ||
          !this.knowsBrain(message.targetBrainID)
        )
          throw new Error('远程控制路由与当前节点不匹配。');
        changed = this.remoteTasks.receiveControl(message);
        if (changed) receivedControl = { taskID: message.taskID, controlID: message.controlID };
      } else if (validRemoteTaskCancel(message)) {
        if (
          message.ownerNodeID !== node.id ||
          message.targetNodeID !== this.identity!.nodeID ||
          !node.brains.some((brain) => brain.id === message.ownerBrainID) ||
          message.ownerBrainID !== message.targetBrainID ||
          !this.knowsBrain(message.targetBrainID)
        )
          throw new Error('远端任务取消路由与当前节点不匹配。');
        changed = this.remoteTasks.receiveCancel(message);
      } else {
        throw new NodeNetworkError(404, '加密消息类型尚未开放。');
      }
    } catch (error) {
      if (error instanceof NodeNetworkError) throw error;
      throw new NodeNetworkError(409, '远端任务消息冲突或已经失效。');
    }
    if (changed) this.update();
    if (receivedOfferID) {
      const taskID = receivedOfferID;
      queueMicrotask(() => this.emit('remote-task-offer', { taskID }));
    }
    if (receivedControl) {
      const control = receivedControl;
      queueMicrotask(() => this.emit('remote-task-control', control));
    }
    return eventAck();
  }

  private async syncBrainDirectory(node: RivloomNode, initialChannel?: SecureChannelSession) {
    if (this.syncingDirectories.has(node.id)) return;
    this.syncingDirectories.add(node.id);
    const previous = this.channelSendQueues.get(node.id) || Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        const current = this.nodes.get(node.id);
        const channel = this.channels.get(node.id) || initialChannel;
        if (!current?.online || !current.trusted || !channel)
          throw new NodeNetworkError(503, '受信节点的加密通道尚未就绪。');
        const request: BrainDirectoryRequest = {
          ...(current.capabilities.includes(queueReceiptCapability)
            ? { nodeQueue: this.currentNodeQueue() }
            : {}),
          profile: this.profiles.local(this.identity!.nodeID),
          type: 'brain-directory-request',
          requestID: randomUUID(),
          capabilities,
          brains: this.directoryBrains(),
          hostedBrains: this.topology.hosted(),
          worker: this.currentWorker(),
        };
        const value = await this.postToNode(
          current,
          '/v1/channel/message',
          encryptChannelPayload(channel, request),
        );
        if (!validChannelEnvelope(value))
          throw new NodeNetworkError(502, '对方返回的加密消息格式无效。');
        let message: unknown;
        try {
          message = decryptChannelPayload(channel, value);
        } catch {
          throw new NodeNetworkError(502, '对方返回的加密消息校验失败。');
        }
        if (!validBrainDirectoryResponse(message) || message.requestID !== request.requestID)
          throw new NodeNetworkError(502, '对方返回的 Brain 目录无效。');
        if (
          (message.worker && message.worker.nodeID !== current.id) ||
          message.hostedBrains.some(
            (brain) =>
              brain.masterNodeID !== current.id ||
              !message.brains.some((candidate) => candidate.id === brain.id),
          )
        )
          throw new NodeNetworkError(502, '对方返回的 Brain 目录归属无效。');
        const topologyChanged = this.topology.reconcile(current.id, message.hostedBrains);
        const latest = this.nodes.get(current.id);
        if (!latest) return;
        if (message.profile)
          this.profiles.remember(current.id, current.fingerprint, message.profile);
        this.nodes.set(current.id, {
          ...latest,
          ...(message.profile ? { name: message.profile.name, icon: message.profile.icon } : {}),
          channelReady: true,
          online: true,
          lastSeen: new Date().toISOString(),
          capabilities: [...new Set(message.capabilities)].sort(),
          brains: message.brains.map((brain) => ({ ...brain })),
          worker: message.worker,
          nodeQueue: message.capabilities.includes(queueReceiptCapability)
            ? (message.nodeQueue ?? null)
            : null,
        });
        if (topologyChanged || latest) this.update();
        void this.flushRemoteTasks(current.id);
        void this.flushBrainTasks(current.id);
        this.replayQueueForChannel(current.id);
      });
    this.channelSendQueues.set(node.id, operation);
    try {
      await operation;
    } finally {
      this.syncingDirectories.delete(node.id);
      if (this.channelSendQueues.get(node.id) === operation) this.channelSendQueues.delete(node.id);
    }
  }

  private async openSecureChannel(node: RivloomNode) {
    if (
      !this.identity ||
      !node.online ||
      !node.trusted ||
      this.identity.nodeID.localeCompare(node.id) >= 0 ||
      this.openingChannels.has(node.id) ||
      this.channelReady(node.id)
    )
      return;
    this.openingChannels.add(node.id);
    try {
      const pending = beginSecureChannel(this.identity, node.id);
      const value = await this.postToNode(node, '/v1/channel/open', pending.message);
      if (!validChannelAck(value) || !this.validChannelAckFrom(value, pending.message, node))
        throw new NodeNetworkError(502, '对方返回的加密通道确认无效。');
      const channel = finishSecureChannel(pending, value);
      this.forgetChannel(node.id);
      this.channels.set(node.id, channel);
      await this.syncBrainDirectory(node, channel);
    } catch {
      this.closeChannel(node.id);
    } finally {
      this.openingChannels.delete(node.id);
    }
  }

  private async requestSecureChannelRecovery(node: RivloomNode) {
    if (
      !this.identity ||
      !node.online ||
      !node.trusted ||
      this.identity.nodeID.localeCompare(node.id) <= 0 ||
      this.requestingChannelRecovery.has(node.id) ||
      this.channelReady(node.id)
    )
      return;
    this.requestingChannelRecovery.add(node.id);
    try {
      const value = await this.postToNode(
        node,
        '/v1/channel/recover',
        this.signedChannelRecovery(node.id),
      );
      if (value !== null) throw new NodeNetworkError(502, '对方返回的通道恢复响应无效。');
    } catch {
      this.closeChannel(node.id);
    } finally {
      this.requestingChannelRecovery.delete(node.id);
    }
  }

  private async sendChannelEvent(
    node: RivloomNode,
    message: RemoteTaskMessage | BrainTaskMessage | QueueReceiptMessage,
  ) {
    const previous = this.channelSendQueues.get(node.id) || Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        const current = this.nodes.get(node.id);
        const channel = this.channels.get(node.id);
        if (
          !current?.online ||
          !current.trusted ||
          !current.channelReady ||
          !channel ||
          channel.expiresAt <= Date.now()
        )
          throw new NodeNetworkError(503, '受信节点的加密通道尚未就绪。');
        const envelope = encryptChannelPayload(channel, message);
        const result = await this.postToNode(current, '/v1/channel/message', envelope);
        if (current.capabilities.includes(queueReceiptCapability)) {
          if (!verifyChannelEventAck(channel, envelope, result))
            throw new NodeNetworkError(502, '对方尚未提供与当前请求绑定的认证回执。');
          return true;
        }
        if (result !== null) throw new NodeNetworkError(502, '远端任务消息响应格式无效。');
        return false;
      });
    this.channelSendQueues.set(node.id, operation);
    try {
      return await operation;
    } finally {
      if (this.channelSendQueues.get(node.id) === operation) this.channelSendQueues.delete(node.id);
    }
  }

  private async flushRemoteTask(taskID: string) {
    if (this.deliveringRemoteTasks.has(taskID)) return;
    const task = this.remoteTasks.record(taskID);
    const message = this.remoteTasks.message(taskID);
    if (!task || !message) return;
    const peerNodeID = task.direction === 'outgoing' ? task.targetNodeID : task.ownerNodeID;
    const node = this.nodes.get(peerNodeID);
    if (!node?.online || !node.trusted || !node.channelReady) return;
    this.deliveringRemoteTasks.add(taskID);
    try {
      if (
        message.type === 'remote-task-offer' &&
        this.remoteTasks.markOfferTransmission(taskID, 'sending')
      )
        this.update();
      const authenticated = await this.sendChannelEvent(node, message);
      if (this.remoteTasks.markDelivered(taskID, message, authenticated)) this.update();
    } catch (error) {
      if (
        message.type === 'remote-task-offer' &&
        this.remoteTasks.markOfferTransmission(taskID, 'transmission_unknown')
      )
        this.update();
      if (
        error instanceof NodeNetworkError &&
        (error.status === 400 || error.status === 404 || error.status === 409)
      ) {
        if (this.remoteTasks.markDeliveryFailed(taskID, '对方拒绝了冲突或无效的任务消息。'))
          this.update();
        return;
      }
      if (
        error instanceof NodeNetworkError &&
        (error.status === 403 || error.status === 502 || error.status === 503)
      )
        this.closeChannel(node.id);
    } finally {
      this.deliveringRemoteTasks.delete(taskID);
      const next = this.remoteTasks.message(taskID);
      if (next && JSON.stringify(next) !== JSON.stringify(message))
        queueMicrotask(() => void this.flushRemoteTask(taskID));
    }
  }

  private receiveQueueReceipt(peerNodeID: string, message: QueueReceiptMessage) {
    const receipt = message.receipt;
    if (message.type === 'remote-task-queue') {
      const remote = this.remoteTasks.record(receipt.remoteTaskID);
      if (
        !remote ||
        remote.direction !== 'outgoing' ||
        remote.targetNodeID !== peerNodeID ||
        remote.ownerNodeID !== this.identity?.nodeID ||
        remote.idempotencyKey !== message.idempotencyKey ||
        !receiptMatchesRemote(receipt, remote)
      )
        throw new Error('route');
      if (
        ['cancelled', 'declined', 'expired'].includes(remote.status) &&
        receipt.state !== 'rejected'
      )
        return;
      if (remote.executionSequence > 0 && ['queued', 'held', 'rejected'].includes(receipt.state))
        return;
      this.queueReceipts.receive(`remote:${remote.id}`, receipt);
      if (remote.brainTaskID) {
        const brain = this.brainTasks.record(remote.brainTaskID);
        if (
          brain?.direction !== 'owned' ||
          brain.executionID !== remote.id ||
          brain.selectedWorkerID !== peerNodeID ||
          brain.masterNodeID !== this.identity?.nodeID
        )
          return;
        this.queueReceipts.receive(
          `brain:${brain.id}`,
          receipt,
          brain.submitterNodeID === this.identity?.nodeID ? null : brain.submitterNodeID,
        );
        queueMicrotask(() => void this.flushQueueReceipts(brain.submitterNodeID));
      }
      return;
    }
    const brain = this.brainTasks.record(message.taskID);
    if (
      !brain ||
      brain.direction !== 'submitted' ||
      brain.idempotencyKey !== message.idempotencyKey ||
      brain.masterNodeID !== peerNodeID ||
      brain.brainID !== message.brainID ||
      message.masterNodeID !== peerNodeID ||
      message.submitterNodeID !== this.identity?.nodeID ||
      brain.submitterNodeID !== message.submitterNodeID ||
      brain.executionID !== receipt.remoteTaskID ||
      brain.selectedWorkerID !== receipt.targetNodeID
    )
      throw new Error('route');
    if (['completed', 'failed'].includes(brain.status) && receipt.state !== 'rejected') return;
    this.queueReceipts.receive(`brain:${brain.id}`, receipt);
  }

  private replayQueueForChannel(peerNodeID: string) {
    const node = this.nodes.get(peerNodeID);
    const channelID = this.channels.get(peerNodeID)?.id;
    if (!channelID || !node?.capabilities.includes(queueReceiptCapability)) return;
    if (this.replayedQueueChannels.get(peerNodeID) !== channelID) {
      this.queueReceipts.replay(peerNodeID);
      this.replayedQueueChannels.set(peerNodeID, channelID);
    }
    void this.flushQueueReceipts(peerNodeID);
  }

  private async flushQueueReceipts(peerNodeID: string) {
    const node = this.nodes.get(peerNodeID);
    if (
      !node?.online ||
      !node.trusted ||
      !node.channelReady ||
      !node.capabilities.includes(queueReceiptCapability) ||
      this.deliveringQueueReceipts.has(peerNodeID)
    )
      return;
    this.deliveringQueueReceipts.add(peerNodeID);
    try {
      for (const entry of this.queueReceipts.pending(peerNodeID)) {
        let message: QueueReceiptMessage;
        if (entry.key.startsWith('remote:')) {
          const remote = this.remoteTasks.record(entry.receipt.remoteTaskID);
          if (!remote || remote.direction !== 'incoming' || remote.ownerNodeID !== peerNodeID)
            continue;
          message = {
            type: 'remote-task-queue',
            version: 1,
            idempotencyKey: remote.idempotencyKey,
            receipt: entry.receipt,
          };
        } else {
          const brain = this.brainTasks.record(entry.receipt.brainTaskID!);
          if (
            !brain ||
            brain.direction !== 'owned' ||
            brain.submitterNodeID !== peerNodeID ||
            brain.executionID !== entry.receipt.remoteTaskID
          )
            continue;
          message = {
            type: 'brain-task-queue',
            version: 1,
            idempotencyKey: brain.idempotencyKey,
            taskID: brain.id,
            brainID: brain.brainID,
            masterNodeID: brain.masterNodeID,
            submitterNodeID: brain.submitterNodeID,
            receipt: entry.receipt,
          };
        }
        try {
          if (await this.sendChannelEvent(node, message))
            this.queueReceipts.delivered(entry.key, entry.receipt);
        } catch (error) {
          // A lost or unauthenticated response may leave the stream counters apart.
          // Keep the durable snapshot and recover the authenticated channel before replay.
          if (error instanceof NodeNetworkError && [403, 502, 503].includes(error.status))
            this.closeChannel(peerNodeID);
        }
      }
    } finally {
      this.deliveringQueueReceipts.delete(peerNodeID);
    }
  }

  private async flushRemoteTasks(nodeID: string) {
    for (const task of this.remoteTasks.pendingForPeer(nodeID)) await this.flushRemoteTask(task.id);
  }

  private async flushBrainTask(taskID: string) {
    if (this.deliveringBrainTasks.has(taskID)) return;
    const task = this.brainTasks.record(taskID);
    const message = this.brainTasks.message(taskID);
    if (!task || !message) return;
    const peerNodeID = task.direction === 'submitted' ? task.masterNodeID : task.submitterNodeID;
    if (peerNodeID === this.identity?.nodeID) return;
    const node = this.nodes.get(peerNodeID);
    if (!node?.online || !node.trusted || !node.channelReady) return;
    this.deliveringBrainTasks.add(taskID);
    try {
      await this.sendChannelEvent(node, message);
      if (this.brainTasks.markDelivered(taskID, message)) this.update();
    } catch (error) {
      if (
        error instanceof NodeNetworkError &&
        (error.status === 400 || error.status === 404 || error.status === 409)
      ) {
        if (this.brainTasks.markDeliveryFailed(taskID, '对方拒绝了冲突或无效的 Brain Task。'))
          this.update();
        return;
      }
      if (
        error instanceof NodeNetworkError &&
        (error.status === 403 || error.status === 502 || error.status === 503)
      )
        this.closeChannel(node.id);
    } finally {
      this.deliveringBrainTasks.delete(taskID);
      const next = this.brainTasks.message(taskID);
      if (next && JSON.stringify(next) !== JSON.stringify(message))
        queueMicrotask(() => void this.flushBrainTask(taskID));
    }
  }

  private async flushBrainTasks(nodeID: string) {
    for (const task of this.brainTasks.pendingForPeer(nodeID)) await this.flushBrainTask(task.id);
  }

  private async postToNode(node: RivloomNode, path: string, value: unknown) {
    let unavailable = true;
    for (const address of node.addresses.map(normalizedAddress)) {
      if (!privateNetworkAddress(address)) continue;
      try {
        const response = await fetch(`http://${address}:${node.port}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(value),
          signal: AbortSignal.timeout(3500),
          redirect: 'error',
        });
        unavailable = false;
        if (response.status === 204) return null;
        const body = response.headers.get('content-type')?.startsWith('application/json')
          ? await limitedJson(response)
          : null;
        if (response.ok) return body;
        throw new NodeNetworkError(
          response.status >= 400 && response.status < 500 ? response.status : 502,
          response.status === 409
            ? '对方当前会话状态冲突，请在两台设备检查后重试。'
            : response.status === 403
              ? '对方拒绝了节点身份校验。'
              : '对方没有接受本次节点操作。',
        );
      } catch (error) {
        if (error instanceof NodeNetworkError) throw error;
      }
    }
    throw new NodeNetworkError(
      503,
      unavailable ? '附近节点暂时无法连接，请确认两台设备仍在线。' : '节点操作未完成。',
    );
  }

  private pairingForNode(nodeID: string) {
    return [...this.pairings.values()].find((pairing) => pairing.nodeID === nodeID) || null;
  }

  private completePairing(pairing: PairingSession) {
    const node = this.nodes.get(pairing.nodeID);
    if (!node || !node.verified) throw new NodeNetworkError(409, '节点已离线，不能完成配对。');
    this.trustStore.trust({
      nodeID: node.id,
      fingerprint: node.fingerprint,
      publicKey: pairing.peerPublicKey,
      pairedAt: new Date().toISOString(),
    });
    this.nodes.set(node.id, { ...node, trusted: true, channelReady: false });
    this.pairings.delete(pairing.id);
    this.update();
    // Let the confirm response return so the peer can persist its side of the trust record first.
    const openAfterConfirmation = setTimeout(() => {
      const current = this.nodes.get(node.id);
      if (current) void this.openSecureChannel(current);
    }, 100);
    openAfterConfirmation.unref();
  }

  private async handlePairingRequest(message: PairingMessage, remote: string | undefined) {
    if (!this.identity || message.responderNodeID !== this.identity.nodeID)
      throw new NodeNetworkError(403, '配对目标不匹配。');
    const node = this.nodeForRemote(message.requesterNodeID, remote);
    if (
      !node ||
      message.actorNodeID !== message.requesterNodeID ||
      !this.validPairingFrom(message, node, 'request')
    )
      throw new NodeNetworkError(403, '配对请求身份校验失败。');
    if (
      this.seenPairings.has(message.pairingID) ||
      this.pairingForNode(node.id) ||
      this.trustStore.trusted(node.id, node.fingerprint)
    )
      throw new NodeNetworkError(409, '节点已有配对或信任状态。');
    if (this.pairings.size >= maximumPendingPairings)
      throw new NodeNetworkError(429, '待处理配对过多，请先处理现有请求。');
    const pairing: PairingSession = {
      id: message.pairingID,
      nodeID: node.id,
      requesterNodeID: message.requesterNodeID,
      responderNodeID: message.responderNodeID,
      nonce: message.nonce,
      peerPublicKey: message.publicKey,
      direction: 'incoming',
      code: pairingShortCode(
        message.pairingID,
        message.nonce,
        node.id,
        node.fingerprint,
        this.identity.nodeID,
        this.identity.fingerprint,
      ),
      expiresAt: new Date(Date.now() + pairingExpireAfterMilliseconds).toISOString(),
      localConfirmed: false,
      remoteConfirmed: false,
    };
    this.pairings.set(pairing.id, pairing);
    this.seenPairings.set(pairing.id, Date.now() + pairingReplayWindowMilliseconds);
    this.update();
    return this.signedPairing('ack', pairing);
  }

  private handlePairingConfirm(message: PairingMessage, remote: string | undefined) {
    if (!this.identity) throw new NodeNetworkError(503, '本机节点身份尚未就绪。');
    const pairing = this.pairings.get(message.pairingID);
    const node = pairing ? this.nodeForRemote(pairing.nodeID, remote) : null;
    if (
      !pairing ||
      !node ||
      message.requesterNodeID !== pairing.requesterNodeID ||
      message.responderNodeID !== pairing.responderNodeID ||
      message.nonce !== pairing.nonce ||
      message.publicKey !== pairing.peerPublicKey ||
      !this.validPairingFrom(message, node, 'confirm')
    )
      throw new NodeNetworkError(403, '配对确认身份或会话不匹配。');
    pairing.remoteConfirmed = true;
    if (pairing.localConfirmed) this.completePairing(pairing);
    else this.update();
  }

  private handlePairingCancel(message: PairingMessage, remote: string | undefined) {
    const pairing = this.pairings.get(message.pairingID);
    const node = pairing ? this.nodeForRemote(pairing.nodeID, remote) : null;
    if (
      !pairing ||
      !node ||
      message.requesterNodeID !== pairing.requesterNodeID ||
      message.responderNodeID !== pairing.responderNodeID ||
      message.nonce !== pairing.nonce ||
      message.publicKey !== pairing.peerPublicKey ||
      !this.validPairingFrom(message, node, 'cancel')
    )
      throw new NodeNetworkError(403, '取消配对的身份或会话不匹配。');
    this.pairings.delete(pairing.id);
    this.update();
  }

  private handleRevocation(message: RevocationMessage, remote: string | undefined) {
    if (!this.identity || message.peerNodeID !== this.identity.nodeID)
      throw new NodeNetworkError(403, '撤销目标不匹配。');
    const record = this.trustStore.record(message.nodeID);
    const node = this.nodeForRemote(message.nodeID, remote);
    if (
      !record ||
      !node ||
      message.publicKey !== record.publicKey ||
      Math.abs(Date.now() - message.issuedAt) > signedMessageWindowMilliseconds ||
      message.issuedAt < Date.parse(record.pairedAt) ||
      !verifySignedNodeMessage(
        message.publicKey,
        message.nodeID,
        record.fingerprint,
        unsignedRevocationMessage({
          protocol: message.protocol,
          version: message.version,
          type: message.type,
          nodeID: message.nodeID,
          peerNodeID: message.peerNodeID,
          issuedAt: message.issuedAt,
          publicKey: message.publicKey,
        }),
        message.signature,
      )
    )
      throw new NodeNetworkError(403, '撤销请求身份校验失败。');
    this.trustStore.revoke(node.id, node.fingerprint);
    this.forgetChannel(node.id);
    this.remoteTasks.revokePeer(node.id);
    this.nodes.set(node.id, { ...node, trusted: false, channelReady: false });
    const pairing = this.pairingForNode(node.id);
    if (pairing) this.pairings.delete(pairing.id);
    this.update();
    queueMicrotask(() => this.emit('trust-revoked', { nodeID: node.id }));
  }

  private async handlePeerRequest(request: IncomingMessage, response: ServerResponse) {
    const remote = request.socket.remoteAddress;
    if (!this.allowed(remote)) throw new NodeNetworkError(403, '只接受局域网节点请求。');
    const url = new URL(request.url || '/', 'http://rivloom.local');
    const scope =
      request.method === 'GET' && url.pathname === '/v1/hello'
        ? 'hello'
        : request.method === 'POST' && url.pathname === '/v1/channel/message'
          ? 'channel'
          : 'control';
    if (this.rateLimited(remote!, scope)) throw new NodeNetworkError(429, '节点请求过于频繁。');
    if (request.method === 'GET' && url.pathname === '/v1/hello') {
      const nonce = url.searchParams.get('nonce') || '';
      if (!/^[A-Za-z0-9_-]{32}$/.test(nonce)) throw new NodeNetworkError(400, '随机挑战无效。');
      const identity = this.identity!;
      const brain = this.advertisedBrain();
      const value: Omit<Hello, 'signature'> = {
        protocolVersion: nodeProtocolVersion,
        nodeID: identity.nodeID,
        name: this.profiles.local(identity.nodeID).name,
        brain,
        capabilities,
        port: this.peerPort,
        nonce,
        issuedAt: Date.now(),
        publicKey: identity.publicKey,
      };
      jsonResponse(response, 200, { ...value, signature: identity.sign(unsignedHello(value)) });
      return;
    }
    if (request.method !== 'POST') throw new NodeNetworkError(404, '节点接口不存在。');
    const value = await requestJson(
      request,
      url.pathname === '/v1/channel/message' ? maximumChannelRequestBytes : maximumHelloBytes,
    );
    if (url.pathname === '/v1/pairing/request' && validPairingMessage(value)) {
      jsonResponse(response, 200, await this.handlePairingRequest(value, remote));
      return;
    }
    if (url.pathname === '/v1/pairing/confirm' && validPairingMessage(value)) {
      this.handlePairingConfirm(value, remote);
      response.writeHead(204).end();
      return;
    }
    if (url.pathname === '/v1/pairing/cancel' && validPairingMessage(value)) {
      this.handlePairingCancel(value, remote);
      response.writeHead(204).end();
      return;
    }
    if (url.pathname === '/v1/trust/revoke' && validRevocationMessage(value)) {
      this.handleRevocation(value, remote);
      response.writeHead(204).end();
      return;
    }
    if (url.pathname === '/v1/channel/open' && validChannelOpen(value)) {
      jsonResponse(response, 200, this.handleChannelOpen(value, remote));
      return;
    }
    if (url.pathname === '/v1/channel/recover' && validChannelRecovery(value)) {
      this.handleChannelRecovery(value, remote);
      response.writeHead(204).end();
      return;
    }
    if (url.pathname === '/v1/channel/message' && validChannelEnvelope(value)) {
      const result = this.handleChannelMessage(value, remote);
      if (result) jsonResponse(response, 200, result);
      else response.writeHead(204).end();
      return;
    }
    throw new NodeNetworkError(404, '节点接口不存在。');
  }

  private createPeerServer(_identity: NodeIdentity) {
    const server = createServer((request, response) => {
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('X-Frame-Options', 'DENY');
      response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      void this.handlePeerRequest(request, response).catch((error: unknown) => {
        if (response.headersSent) return void response.destroy();
        const status = error instanceof NodeNetworkError ? error.status : 400;
        jsonResponse(response, status, {
          error: error instanceof NodeNetworkError ? error.message : '节点请求未完成。',
        });
      });
    });
    server.headersTimeout = 5000;
    server.requestTimeout = 5000;
    server.keepAliveTimeout = 1000;
    server.maxRequestsPerSocket = 10;
    return server;
  }

  async requestPairing(nodeID: string) {
    if (!this.identity || this.status !== 'online')
      throw new NodeNetworkError(503, '节点网络尚未就绪。');
    const node = this.nodes.get(nodeID);
    if (!node?.online || !node.verified)
      throw new NodeNetworkError(404, '附近没有可配对的在线节点。');
    if (this.trustStore.trusted(node.id, node.fingerprint))
      throw new NodeNetworkError(409, '节点已经受信。');
    if (this.pairingForNode(node.id)) throw new NodeNetworkError(409, '节点已有待处理配对。');
    if (this.pairings.size >= maximumPendingPairings)
      throw new NodeNetworkError(429, '待处理配对过多，请先处理现有请求。');
    const pairing: PairingSession = {
      id: randomUUID(),
      nodeID: node.id,
      requesterNodeID: this.identity.nodeID,
      responderNodeID: node.id,
      nonce: randomBytes(24).toString('base64url'),
      peerPublicKey: '',
      direction: 'outgoing',
      code: '',
      expiresAt: new Date(Date.now() + pairingExpireAfterMilliseconds).toISOString(),
      localConfirmed: false,
      remoteConfirmed: false,
    };
    const request = this.signedPairing('request', pairing);
    const value = await this.postToNode(node, '/v1/pairing/request', request);
    if (
      !validPairingMessage(value) ||
      value.pairingID !== pairing.id ||
      value.requesterNodeID !== pairing.requesterNodeID ||
      value.responderNodeID !== pairing.responderNodeID ||
      value.nonce !== pairing.nonce ||
      !this.validPairingFrom(value, node, 'ack')
    )
      throw new NodeNetworkError(502, '对方返回的配对确认无效。');
    pairing.peerPublicKey = value.publicKey;
    pairing.code = pairingShortCode(
      pairing.id,
      pairing.nonce,
      this.identity.nodeID,
      this.identity.fingerprint,
      node.id,
      node.fingerprint,
    );
    this.pairings.set(pairing.id, pairing);
    this.seenPairings.set(pairing.id, Date.now() + pairingReplayWindowMilliseconds);
    this.update();
    return this.snapshot();
  }

  async confirmPairing(pairingID: string) {
    const pairing = this.pairings.get(pairingID);
    const node = pairing ? this.nodes.get(pairing.nodeID) : null;
    if (!pairing || !node?.online)
      throw new NodeNetworkError(404, '配对会话不存在或节点已经离线。');
    if (Date.parse(pairing.expiresAt) <= Date.now())
      throw new NodeNetworkError(409, '配对已过期，请重新发起。');
    if (pairing.localConfirmed) throw new NodeNetworkError(409, '本机已经确认该配对。');
    await this.postToNode(node, '/v1/pairing/confirm', this.signedPairing('confirm', pairing));
    pairing.localConfirmed = true;
    if (pairing.remoteConfirmed) this.completePairing(pairing);
    else this.update();
    return this.snapshot();
  }

  async cancelPairing(pairingID: string) {
    const pairing = this.pairings.get(pairingID);
    if (!pairing) throw new NodeNetworkError(404, '配对会话不存在。');
    this.pairings.delete(pairing.id);
    this.update();
    const node = this.nodes.get(pairing.nodeID);
    if (node?.online)
      try {
        await this.postToNode(node, '/v1/pairing/cancel', this.signedPairing('cancel', pairing));
      } catch {
        /* The remote pending request expires automatically. */
      }
    return this.snapshot();
  }

  private async sendRevocation(node: RivloomNode) {
    const lastAttempt = this.revocationAttempts.get(node.id) || 0;
    if (this.sendingRevocations.has(node.id) || Date.now() - lastAttempt < 30_000) return;
    this.revocationAttempts.set(node.id, Date.now());
    this.sendingRevocations.add(node.id);
    try {
      await this.postToNode(node, '/v1/trust/revoke', this.signedRevocation(node.id));
    } finally {
      this.sendingRevocations.delete(node.id);
    }
  }

  async revokeTrust(nodeID: string) {
    const record = this.trustStore.record(nodeID);
    if (!record) throw new NodeNetworkError(404, '该节点没有本机信任记录。');
    this.trustStore.revoke(record.nodeID, record.fingerprint);
    const node = this.nodes.get(nodeID);
    this.forgetChannel(nodeID);
    this.remoteTasks.revokePeer(nodeID);
    if (node) this.nodes.set(node.id, { ...node, trusted: false, channelReady: false });
    const pairing = this.pairingForNode(nodeID);
    if (pairing) this.pairings.delete(pairing.id);
    this.update();
    queueMicrotask(() => this.emit('trust-revoked', { nodeID }));
    if (node?.online)
      try {
        await this.sendRevocation(node);
      } catch {
        /* Persisted revocation is retried when the node is discovered again. */
      }
    return this.snapshot();
  }

  async createRemoteTask(
    nodeID: string,
    targetBrainID: string,
    input: {
      title: string;
      description: string;
      criteria: string;
      requestedProjectID?: string | null;
      requirements?: TaskHardwareRequirements;
    },
    taskID?: string,
  ) {
    if (!this.identity || this.status !== 'online')
      throw new NodeNetworkError(503, '节点网络尚未就绪。');
    const node = this.nodes.get(nodeID);
    if (!node?.online || !node.trusted || !node.channelReady)
      throw new NodeNetworkError(409, '请先完成设备互信并等待加密通道就绪。');
    if (!node.brains.some((brain) => brain.id === targetBrainID))
      throw new NodeNetworkError(404, '目标 Brain 当前不可用。');
    if (!this.knowsBrain(targetBrainID))
      throw new NodeNetworkError(404, '本机尚未注册目标 Brain。');
    if (!node.capabilities.includes('remote-execution-v1'))
      throw new NodeNetworkError(409, '目标节点版本尚不支持策略化任务执行。');
    const title = input.title.trim();
    const description = input.description.trim();
    const criteria = input.criteria.trim();
    if (
      title.length < 1 ||
      title.length > 120 ||
      description.length < 1 ||
      description.length > 4000 ||
      criteria.length < 1 ||
      criteria.length > 2000
    )
      throw new NodeNetworkError(400, '远端任务邀请内容长度无效。');
    let created;
    try {
      created = this.remoteTasks.create(
        this.identity.nodeID,
        targetBrainID,
        node.id,
        targetBrainID,
        {
          title,
          description,
          criteria,
          requestedProjectID: input.requestedProjectID ?? null,
          requirements: input.requirements ?? {},
        },
        taskID,
      );
    } catch {
      throw new NodeNetworkError(409, '无法保存远端任务邀请。');
    }
    this.update();
    await this.flushRemoteTask(created.id);
    return { ...this.snapshot(), createdTaskID: created.id };
  }

  async createTaskForNode(
    nodeID: string,
    input: {
      title: string;
      description: string;
      criteria: string;
      requirements?: TaskHardwareRequirements;
    },
    taskID?: string,
  ) {
    const existing = taskID ? this.remoteTasks.record(taskID) : null;
    if (existing) {
      if (
        existing.direction !== 'outgoing' ||
        existing.targetNodeID !== nodeID ||
        !this.remoteTasks.matchesCreation(existing.id, input) ||
        existing.brainTaskID !== null ||
        JSON.stringify(existing.requirements) !== JSON.stringify(input.requirements ?? {})
      )
        throw new NodeNetworkError(409, '创建请求的目标或内容与原任务冲突。');
      return { ...this.snapshot(), createdTaskID: existing.id };
    }
    const node = this.nodes.get(nodeID);
    if (!node?.online || !node.trusted || !node.channelReady)
      throw new NodeNetworkError(409, '目标 Node 当前不在线或加密通道尚未就绪。');
    const brain = this.snapshot()
      .brains.filter(
        (candidate) =>
          candidate.state === 'established' &&
          candidate.online &&
          node.brains.some((item) => item.id === candidate.id),
      )
      .sort(
        (left, right) =>
          Number(right.hosted) - Number(left.hosted) || left.id.localeCompare(right.id),
      )[0];
    if (!brain) throw new NodeNetworkError(409, '目标 Node 当前没有可用的共同 Brain。');
    const result = await this.createRemoteTask(
      nodeID,
      brain.id,
      {
        ...input,
        requestedProjectID: null,
      },
      taskID,
    );
    this.profiles.markUsed(node.id, node.fingerprint, {
      name: node.name,
      icon: node.icon || 'monitor',
    });
    this.update();
    return { ...this.snapshot(), createdTaskID: result.createdTaskID };
  }

  async createScheduledTask(
    input: {
      title: string;
      description: string;
      criteria: string;
      requestedProjectID: string | null;
      requirements: TaskHardwareRequirements;
    },
    taskID?: string,
  ) {
    const existing = taskID ? this.brainTasks.record(taskID) : null;
    if (existing) {
      if (
        existing.submitterNodeID !== this.identity?.nodeID ||
        existing.title !== input.title.trim() ||
        existing.description !== input.description.trim() ||
        existing.criteria !== input.criteria.trim() ||
        existing.requestedProjectID !== input.requestedProjectID ||
        JSON.stringify(existing.requirements) !== JSON.stringify(input.requirements)
      )
        throw new NodeNetworkError(409, '创建请求的内容与原 Brain Task 冲突。');
      return { ...this.snapshot(), createdTaskID: existing.id };
    }
    if (!this.identity || this.status !== 'online')
      throw new NodeNetworkError(503, '节点网络尚未就绪。');
    const topology = this.snapshot()
      .brains.filter(
        (brain) =>
          brain.hosted ||
          this.nodes.get(brain.masterNodeID)?.capabilities.includes('brain-task-v1'),
      )
      .map((brain) => ({
        ...brain,
        workers: brain.workers.filter((worker) => {
          if (worker.nodeID === this.identity!.nodeID) return true;
          const peer = this.nodes.get(worker.nodeID);
          // The owning Master rechecks its actual channel before dispatch. A remote
          // directory candidate need not have a direct channel to the submitter.
          return (
            (!peer && !brain.hosted) ||
            (!!peer?.online &&
              peer.trusted &&
              peer.channelReady &&
              peer.capabilities.includes('remote-execution-v1'))
          );
        }),
      }));
    const placement = rankBrainPlacements(topology, {
      projectID: input.requestedProjectID,
      requirements: input.requirements,
    })[0];
    if (!placement)
      throw new NodeNetworkError(
        409,
        input.requestedProjectID
          ? '当前没有在线 Brain 同时具备该项目、所需硬件和可用执行槽位。'
          : '当前没有在线 Brain 同时具备匹配 Worker 和可用执行槽位。',
      );
    const direction = placement.brain.hosted ? 'owned' : 'submitted';
    const master =
      placement.brain.masterNodeID === this.identity.nodeID
        ? null
        : this.nodes.get(placement.brain.masterNodeID);
    if (
      placement.brain.masterNodeID !== this.identity.nodeID &&
      (!master ||
        !master.online ||
        !master.trusted ||
        !master.channelReady ||
        !master.capabilities.includes('brain-task-v1'))
    )
      throw new NodeNetworkError(409, '选中 Brain 的 Master 通道已经失效或版本不兼容。');
    let created;
    try {
      created = this.brainTasks.create(
        direction,
        this.identity.nodeID,
        placement.brain.id,
        placement.brain.masterNodeID,
        input,
        taskID,
      );
    } catch {
      throw new NodeNetworkError(409, '无法保存 Brain Task。');
    }
    this.update();
    if (direction === 'owned') await this.scheduleBrainTask(created.id);
    else await this.flushBrainTask(created.id);
    return { ...this.snapshot(), createdTaskID: created.id };
  }

  private async scheduleBrainTask(taskID: string) {
    if (!this.identity || this.schedulingBrainTasks.has(taskID)) return;
    const task = this.brainTasks.record(taskID);
    if (
      !task ||
      task.direction !== 'owned' ||
      task.status !== 'queued' ||
      task.masterNodeID !== this.identity.nodeID ||
      !this.hostsBrain(task.brainID)
    )
      return;
    this.schedulingBrainTasks.add(taskID);
    try {
      const brain = this.snapshot().brains.find(
        (candidate) => candidate.id === task.brainID && candidate.hosted,
      );
      if (!brain?.online) return;
      const candidates = rankBrainWorkers(
        {
          ...brain,
          workers: brain.workers.filter((worker) => {
            const peer = this.nodes.get(worker.nodeID);
            return (
              !!peer?.online &&
              peer.trusted &&
              peer.channelReady &&
              peer.capabilities.includes('remote-execution-v1')
            );
          }),
        },
        { projectID: task.requestedProjectID, requirements: task.requirements },
      );
      const lastExecution = task.executions.at(-1);
      const lastWorkerCoolingDown =
        lastExecution && task.retryNotBefore && Date.parse(task.retryNotBefore) > Date.now()
          ? lastExecution.workerNodeID
          : null;
      const worker = candidates.find((candidate) => candidate.nodeID !== lastWorkerCoolingDown);
      if (!worker) {
        if (
          this.brainTasks.markWaitingForWorker(
            taskID,
            candidates.length
              ? '合格 Worker 正在重试冷却期；Task 保持原 Brain，稍后继续调度。'
              : '当前没有满足项目、硬件、空闲槽位和通信条件的可调度 Worker；Task 保持原 Brain 等待，Master 不向自身分配。',
          )
        )
          this.update();
        await this.flushBrainTask(taskID);
        return;
      }
      const node = this.nodes.get(worker.nodeID);
      if (
        !node?.online ||
        !node.trusted ||
        !node.channelReady ||
        !node.capabilities.includes('remote-execution-v1')
      )
        return;
      const execution = this.remoteTasks.create(
        this.identity.nodeID,
        task.brainID,
        node.id,
        task.brainID,
        {
          title: task.title,
          brainTaskID: task.id,
          description: task.description,
          criteria: task.criteria,
          requestedProjectID: task.requestedProjectID,
          requirements: task.requirements,
        },
      );
      try {
        this.brainTasks.assign(task.id, node.id, execution.id);
      } catch (error) {
        this.remoteTasks.discardUnsent(execution.id);
        throw error;
      }
      this.update();
      await Promise.all([this.flushRemoteTask(execution.id), this.flushBrainTask(task.id)]);
    } catch (error) {
      console.error(
        `Brain Task ${taskID} 调度失败：${error instanceof Error ? error.message : '未知错误'}`,
      );
    } finally {
      this.schedulingBrainTasks.delete(taskID);
    }
  }

  async respondRemoteTask(taskID: string, decision: 'accepted' | 'declined') {
    if (!this.identity) throw new NodeNetworkError(503, '本机节点身份尚未就绪。');
    const current = this.remoteTasks.record(taskID);
    if (
      !current ||
      current.direction !== 'incoming' ||
      current.targetNodeID !== this.identity.nodeID ||
      !this.knowsBrain(current.targetBrainID)
    )
      throw new NodeNetworkError(404, '待处理的远端任务邀请不存在。');
    try {
      this.remoteTasks.decide(taskID, decision);
    } catch (error) {
      throw new NodeNetworkError(
        409,
        error instanceof Error ? error.message : '远端任务邀请当前不能处理。',
      );
    }
    this.update();
    await this.flushRemoteTask(taskID);
    return this.snapshot();
  }

  async cancelRemoteTask(taskID: string) {
    if (!this.identity) throw new NodeNetworkError(503, '本机节点身份尚未就绪。');
    const current = this.remoteTasks.record(taskID);
    if (
      !current ||
      current.direction !== 'outgoing' ||
      current.ownerNodeID !== this.identity.nodeID ||
      !this.knowsBrain(current.ownerBrainID)
    )
      throw new NodeNetworkError(404, '可取消的远端任务邀请不存在。');
    try {
      this.remoteTasks.cancel(taskID);
    } catch (error) {
      throw new NodeNetworkError(
        409,
        error instanceof Error ? error.message : '远端任务邀请当前不能取消。',
      );
    }
    this.update();
    await this.flushRemoteTask(taskID);
    return this.snapshot();
  }

  async prepareRemoteTask(taskID: string, projectID: string, model: string) {
    if (!this.identity) throw new NodeNetworkError(503, '本机节点身份尚未就绪。');
    const current = this.remoteTasks.record(taskID);
    if (
      !current ||
      current.direction !== 'incoming' ||
      current.targetNodeID !== this.identity.nodeID ||
      !this.knowsBrain(current.targetBrainID)
    )
      throw new NodeNetworkError(404, '可准备执行的远端任务不存在。');
    try {
      this.remoteTasks.prepare(taskID, projectID, model);
    } catch (error) {
      throw new NodeNetworkError(
        409,
        error instanceof Error ? error.message : '远端任务当前不能准备执行。',
      );
    }
    this.update();
    await this.flushRemoteTask(taskID);
    return this.snapshot();
  }

  async revokeRemoteTaskPreparation(taskID: string) {
    if (!this.identity) throw new NodeNetworkError(503, '本机节点身份尚未就绪。');
    const current = this.remoteTasks.record(taskID);
    if (
      !current ||
      current.direction !== 'incoming' ||
      current.targetNodeID !== this.identity.nodeID ||
      !this.knowsBrain(current.targetBrainID)
    )
      throw new NodeNetworkError(404, '可撤销的执行准备不存在。');
    try {
      this.remoteTasks.revokePreparation(taskID);
    } catch (error) {
      throw new NodeNetworkError(
        409,
        error instanceof Error ? error.message : '执行准备当前不能撤销。',
      );
    }
    this.update();
    await this.flushRemoteTask(taskID);
    return this.snapshot();
  }

  projectLeased(projectID: string) {
    return this.remoteTasks.projectLeased(projectID);
  }

  remoteTask(taskID: string) {
    return this.remoteTasks.list().find((task) => task.id === taskID) || null;
  }

  remoteTaskPeerReady(taskID: string) {
    const task = this.remoteTasks.record(taskID);
    if (!task || task.direction !== 'incoming') return false;
    const node = this.nodes.get(task.ownerNodeID);
    return !!node?.online && node.trusted && node.channelReady;
  }

  isTrustedNode(nodeID: string) {
    return !!this.trustStore.record(nodeID);
  }

  async bindRemoteTaskExecution(taskID: string, localTaskID: string) {
    if (this.remoteQueueStartGuard?.(taskID) === false)
      throw new NodeNetworkError(409, '任务已在本机队列终止，不能绑定执行。');
    try {
      this.remoteTasks.bindLocalTask(taskID, localTaskID);
    } catch (error) {
      throw new NodeNetworkError(
        409,
        error instanceof Error ? error.message : '远端任务无法绑定本机执行。',
      );
    }
    this.update();
    await this.flushRemoteTask(taskID);
    return this.remoteTask(taskID);
  }

  async publishRemoteTaskExecution(
    localTaskID: string,
    state: TaskState,
    summary: string,
    approvals: Approval[] = [],
    questions: Question[] = [],
    artifacts: Artifact[] = [],
    diffSource = '',
  ) {
    const updated = this.remoteTasks.updateLocalExecution(
      localTaskID,
      state,
      summary,
      approvals,
      questions,
      artifacts,
      diffSource,
    );
    if (!updated) return null;
    this.update();
    await this.flushRemoteTask(updated.id);
    return updated;
  }

  async requestRemoteTaskControl(
    taskID: string,
    expectedExecutionSequence: number,
    action: RemoteTaskControlAction,
  ) {
    const current = this.remoteTasks.record(taskID);
    const peer = current ? this.nodes.get(current.targetNodeID) : null;
    if (!peer?.capabilities.includes('remote-control-v1'))
      throw new NodeNetworkError(409, '对方版本尚不支持远程人工介入。');
    if (
      (action.kind === 'supplement' || action.kind === 'accept') &&
      !peer.capabilities.includes('remote-results-v1')
    )
      throw new NodeNetworkError(409, '对方版本尚不支持远程补充或验收。');
    try {
      this.remoteTasks.requestControl(taskID, expectedExecutionSequence, action);
    } catch (error) {
      throw new NodeNetworkError(
        409,
        error instanceof Error ? error.message : '远程人工操作当前不可用。',
      );
    }
    this.update();
    await this.flushRemoteTask(taskID);
    return this.remoteTask(taskID);
  }

  pendingRemoteTaskControls() {
    return this.remoteTasks.pendingIncomingControls();
  }

  finishRemoteTaskControl(taskID: string, controlID: string) {
    const changed = this.remoteTasks.finishIncomingControl(taskID, controlID);
    if (changed) this.update();
    return changed;
  }

  private async probe(service: MdnsService) {
    const advertised = serviceIdentity(service);
    if (
      advertised.protocolVersion !== nodeProtocolVersion ||
      !/^[A-Za-z0-9_-]{32}$/.test(advertised.nodeID) ||
      advertised.nodeID === this.identity?.nodeID ||
      !/^[0-9A-F:]{79}$/i.test(advertised.fingerprint) ||
      !/^[0-9a-f-]{36}$/i.test(advertised.brainID) ||
      !Number.isInteger(service.port) ||
      service.port < 1 ||
      service.port > 65_535
    )
      return;
    const probeKey = `${advertised.nodeID}:${service.port}`;
    if (this.probing.has(probeKey)) return;
    this.probing.add(probeKey);
    try {
      const addresses = discoveryProbeAddresses(service);
      for (const address of addresses) {
        const nonce = randomBytes(24).toString('base64url');
        try {
          const response = await fetch(
            `http://${address}:${service.port}/v1/hello?nonce=${encodeURIComponent(nonce)}`,
            { signal: AbortSignal.timeout(2500), redirect: 'error' },
          );
          if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json'))
            continue;
          const value = await limitedJson(response);
          if (!validHello(value)) continue;
          const publicBytes = Buffer.from(value.publicKey, 'base64');
          const computedID = nodeIDForPublicKey(publicBytes);
          const computedFingerprint = fingerprintForPublicKey(publicBytes);
          const unsigned: Omit<Hello, 'signature'> = {
            protocolVersion: value.protocolVersion,
            nodeID: value.nodeID,
            name: value.name,
            brain: value.brain,
            capabilities: value.capabilities,
            port: value.port,
            nonce: value.nonce,
            issuedAt: value.issuedAt,
            publicKey: value.publicKey,
          };
          if (
            value.nonce !== nonce ||
            Math.abs(Date.now() - value.issuedAt) > 120_000 ||
            value.port !== service.port ||
            value.nodeID !== advertised.nodeID ||
            computedID !== value.nodeID ||
            computedFingerprint !== advertised.fingerprint ||
            !verify(
              null,
              Buffer.from(unsignedHello(unsigned)),
              createPublicKey({ key: publicBytes, format: 'der', type: 'spki' }),
              Buffer.from(value.signature, 'base64url'),
            )
          )
            continue;
          const trusted = this.trustStore.trusted(value.nodeID, computedFingerprint);
          const previous = this.nodes.get(value.nodeID);
          const preserveDirectory =
            previous?.fingerprint === computedFingerprint && previous.trusted && trusted;
          const node: RivloomNode = {
            id: value.nodeID,
            name: value.name,
            icon: preserveDirectory ? previous.icon : 'monitor',
            fingerprint: computedFingerprint,
            protocolVersion: value.protocolVersion,
            addresses: [...new Set([address, ...(previous?.addresses || [])])],
            port: value.port,
            online: true,
            local: false,
            trusted,
            channelReady: trusted && this.channelReady(value.nodeID),
            verified: true,
            lastSeen: new Date().toISOString(),
            capabilities: [...new Set(value.capabilities)].sort(),
            brains: preserveDirectory ? previous.brains : [value.brain],
            worker: preserveDirectory ? previous.worker : null,
            nodeQueue:
              preserveDirectory && value.capabilities.includes(queueReceiptCapability)
                ? (previous.nodeQueue ?? null)
                : null,
          };
          if (trusted)
            this.profiles.remember(node.id, node.fingerprint, {
              name: node.name,
              icon: node.icon || 'monitor',
            });
          this.nodes.set(value.nodeID, node);
          this.update();
          if (this.trustStore.revocation(node.id, node.fingerprint))
            void this.sendRevocation(node).catch(() => undefined);
          else if (node.trusted) void this.openSecureChannel(node);
          return;
        } catch {
          /* Try the next private address advertised for the same signed node. */
        }
      }
    } finally {
      this.probing.delete(probeKey);
    }
  }

  private discoveryResponse(nonce: string): DiscoveryResponse {
    return {
      protocol: discoveryProtocol,
      version: 1,
      type: 'response',
      nonce,
      protocolVersion: nodeProtocolVersion,
      nodeID: this.identity!.nodeID,
      fingerprint: this.identity!.fingerprint,
      brainID: this.advertisedBrain().id,
      port: this.peerPort,
    };
  }

  private handleDiscoveryMessage(message: Buffer, remote: RemoteInfo, socket: Socket) {
    if (
      !this.identity ||
      message.byteLength > maximumDiscoveryBytes ||
      !privateNetworkAddress(remote.address)
    )
      return;
    let value: unknown;
    try {
      value = JSON.parse(message.toString('utf8')) as unknown;
    } catch {
      return;
    }
    if (validDiscoveryQuery(value)) {
      if (value.nodeID === this.identity.nodeID || this.rateLimited(remote.address, 'discovery'))
        return;
      const response = Buffer.from(JSON.stringify(this.discoveryResponse(value.nonce)));
      socket.send(response, remote.port, remote.address, () => undefined);
      return;
    }
    if (validDiscoveryDeparture(value)) {
      const node = this.nodes.get(value.nodeID);
      if (
        !node ||
        !node.addresses.map(normalizedAddress).includes(normalizedAddress(remote.address))
      )
        return;
      try {
        const publicBytes = Buffer.from(value.publicKey, 'base64');
        if (
          Math.abs(Date.now() - value.issuedAt) > 30_000 ||
          nodeIDForPublicKey(publicBytes) !== value.nodeID ||
          fingerprintForPublicKey(publicBytes) !== node.fingerprint ||
          !verify(
            null,
            Buffer.from(
              unsignedDeparture({
                protocol: value.protocol,
                version: value.version,
                type: value.type,
                nodeID: value.nodeID,
                issuedAt: value.issuedAt,
                publicKey: value.publicKey,
              }),
            ),
            createPublicKey({ key: publicBytes, format: 'der', type: 'spki' }),
            Buffer.from(value.signature, 'base64url'),
          )
        )
          return;
      } catch {
        return;
      }
      this.nodes.set(value.nodeID, {
        ...node,
        online: false,
        channelReady: false,
        lastSeen: new Date(Date.now() - nodeOfflineAfterMilliseconds).toISOString(),
      });
      this.forgetChannel(value.nodeID);
      this.update();
      return;
    }
    if (
      !validDiscoveryResponse(value) ||
      value.nodeID === this.identity.nodeID ||
      (this.discoveryQueries.get(value.nonce) || 0) < Date.now()
    )
      return;
    void this.probe({
      fqdn: `Rivloom-${value.nodeID.slice(0, 8)}._${serviceType}._tcp.local`,
      port: value.port,
      txt: {
        pv: String(value.protocolVersion),
        id: value.nodeID,
        fp: value.fingerprint,
        brain: value.brainID,
      },
      referer: { address: remote.address },
    });
  }

  private async startDiscoveryFallback() {
    const configuredPort = Number(process.env.RIVLOOM_DISCOVERY_PORT || defaultDiscoveryPort);
    if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65_535)
      throw new Error('RIVLOOM_DISCOVERY_PORT 不是有效端口。');
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    this.discoverySocket = socket;
    socket.on('message', (message, remote) => this.handleDiscoveryMessage(message, remote, socket));
    socket.on('error', () => {
      if (this.discoverySocket === socket) this.discoverySocket = null;
      try {
        socket.close();
      } catch {
        /* The socket may already be closed after a network adapter change. */
      }
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      socket.once('error', onError);
      socket.bind(configuredPort, '0.0.0.0', () => {
        socket.off('error', onError);
        socket.setBroadcast(true);
        resolve();
      });
    });
    this.discoveryPort = configuredPort;
    this.sendDiscoveryQuery();
  }

  private sendDiscoveryQuery() {
    if (!this.discoverySocket || !this.identity || !this.discoveryPort) return;
    const now = Date.now();
    for (const [nonce, expiresAt] of this.discoveryQueries)
      if (expiresAt < now) this.discoveryQueries.delete(nonce);
    const nonce = randomBytes(24).toString('base64url');
    this.discoveryQueries.set(nonce, now + 30_000);
    const query: DiscoveryQuery = {
      protocol: discoveryProtocol,
      version: 1,
      type: 'query',
      nonce,
      nodeID: this.identity.nodeID,
    };
    const message = Buffer.from(JSON.stringify(query));
    const broadcasts = new Set(
      lanInterfaces()
        .map(({ address, netmask }) => directedBroadcastAddress(address, netmask))
        .filter((address): address is string => !!address),
    );
    if (!broadcasts.size) return;
    const socket = createSocket('udp4');
    this.discoveryQuerySockets.add(socket);
    const close = () => {
      if (!this.discoveryQuerySockets.delete(socket)) return;
      try {
        socket.close();
      } catch {
        /* A send error may already have closed the temporary query socket. */
      }
    };
    socket.on('message', (response, remote) =>
      this.handleDiscoveryMessage(response, remote, socket),
    );
    socket.once('error', close);
    socket.bind(0, '0.0.0.0', () => {
      socket.setBroadcast(true);
      for (const address of broadcasts)
        socket.send(message, this.discoveryPort, address, () => undefined);
    });
    const timeout = setTimeout(close, 5000);
    timeout.unref();
    socket.unref();
  }

  private async sendDiscoveryDeparture() {
    if (!this.identity || !this.discoveryPort) return;
    const unsigned: Omit<DiscoveryDeparture, 'signature'> = {
      protocol: discoveryProtocol,
      version: 1,
      type: 'departure',
      nodeID: this.identity.nodeID,
      issuedAt: Date.now(),
      publicKey: this.identity.publicKey,
    };
    const message = Buffer.from(
      JSON.stringify({ ...unsigned, signature: this.identity.sign(unsignedDeparture(unsigned)) }),
    );
    const broadcasts = new Set(
      lanInterfaces()
        .map(({ address, netmask }) => directedBroadcastAddress(address, netmask))
        .filter((address): address is string => !!address),
    );
    if (!broadcasts.size) return;
    const socket = createSocket('udp4');
    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        try {
          socket.close();
        } catch {
          /* A network change may close the departure socket first. */
        }
        resolve();
      };
      socket.once('error', finish);
      socket.bind(0, '0.0.0.0', () => {
        socket.setBroadcast(true);
        let pending = broadcasts.size;
        for (const address of broadcasts)
          socket.send(message, this.discoveryPort, address, () => {
            pending--;
            if (!pending) finish();
          });
      });
      setTimeout(finish, 750).unref();
      socket.unref();
    });
  }

  async start() {
    if (!this.enabled || this.peerServer) return;
    try {
      const legacyIdentityExisted = existsSync(join(this.root, 'node-identity.json'));
      this.identity = loadNodeIdentity(this.root);
      this.topology.load({
        nodeID: this.identity.nodeID,
        legacyBrainID: this.identity.brainID,
        legacyIdentityExisted,
      });
      this.provisionalStartedAt = Date.now();
      this.trustStore.load();
      this.remoteTasks.load();
      this.brainTasks.load();
      this.queueReceipts.load();
      this.peerServer = this.createPeerServer(this.identity);
      const configuredPort = Number(process.env.RIVLOOM_PEER_PORT || 0);
      if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65_535)
        throw new Error('RIVLOOM_PEER_PORT 不是有效端口。');
      await listenHttp(this.peerServer, '0.0.0.0', configuredPort);
      const address = this.peerServer.address();
      if (!address || typeof address === 'string') throw new Error('无法获取节点协议端口。');
      this.peerPort = address.port;

      let fallbackStarted = false;
      if (process.env.RIVLOOM_DISCOVERY_FALLBACK !== 'disabled') {
        try {
          await this.startDiscoveryFallback();
          fallbackStarted = true;
        } catch {
          /* Standard mDNS remains available if the Rivloom-specific fallback cannot bind. */
        }
      }

      const mdnsEnabled = process.env.RIVLOOM_MDNS_NETWORK !== 'disabled';
      if (!mdnsEnabled && !fallbackStarted) throw new Error('无法启动局域网自动发现。');
      if (mdnsEnabled) {
        const advertisedBrain = this.advertisedBrain();
        this.bonjour = new Bonjour(undefined, () =>
          this.fail('局域网发现发生错误，请检查网络配置。'),
        );
        this.service = this.bonjour.publish({
          name: `Rivloom-${this.identity.nodeID.slice(0, 8)}`,
          type: serviceType,
          protocol: 'tcp',
          port: this.peerPort,
          disableIPv6: true,
          txt: {
            pv: String(nodeProtocolVersion),
            id: this.identity.nodeID,
            fp: this.identity.fingerprint,
            brain: advertisedBrain.id,
            cap: capabilities.join(','),
          },
        });
        this.service.on('error', () => this.fail('无法发布 Rivloom 节点，请检查 Windows 防火墙。'));
        this.browser = this.bonjour.find({ type: serviceType, protocol: 'tcp' }, (found) => {
          void this.probe(found as MdnsService);
        });
        this.browser.on('down', (found) => {
          const id = serviceIdentity(found as MdnsService).nodeID;
          const peer = this.nodes.get(id);
          // Multicast discovery can expire while authenticated unicast remains healthy.
          if (peer?.trusted && peer.channelReady && nodePresence(peer.lastSeen) === 'online')
            return;
          this.forgetChannel(id);
          if (this.nodes.delete(id)) this.update();
        });
        this.browser.on('txt-update', (found) => void this.probe(found as MdnsService));
        this.browser.on('srv-update', (found) => void this.probe(found as MdnsService));
      }
      this.timer = setInterval(() => {
        this.browser?.update();
        this.browser?.expire();
        for (const found of this.browser?.services || []) void this.probe(found as MdnsService);
        this.sendDiscoveryQuery();
        let changed = false;
        if (
          Date.now() - this.provisionalStartedAt >= nodeOfflineAfterMilliseconds &&
          this.topology.settleProvisional(
            [...this.nodes.values()].some((node) =>
              node.brains.some((brain) => brain.state === 'established'),
            ),
          )
        )
          changed = true;
        for (const [id, node] of this.nodes) {
          const presence = nodePresence(node.lastSeen);
          if (presence === 'expired') {
            this.nodes.delete(id);
            this.forgetChannel(id);
            changed = true;
          } else if (presence === 'offline' && node.online) {
            this.nodes.set(id, { ...node, online: false, channelReady: false });
            this.forgetChannel(id);
            changed = true;
          } else if (node.trusted && node.online) {
            const channelReady = this.channelReady(id);
            if (channelReady !== node.channelReady) {
              this.nodes.set(id, { ...node, channelReady });
              changed = true;
            }
            if (!channelReady) {
              if (this.identity!.nodeID.localeCompare(id) < 0) void this.openSecureChannel(node);
              else void this.requestSecureChannelRecovery(node);
            } else if (this.identity!.nodeID.localeCompare(id) < 0) {
              void this.syncBrainDirectory(node).catch(() => this.closeChannel(id));
            }
          }
        }
        for (const [id, pairing] of this.pairings)
          if (Date.parse(pairing.expiresAt) <= Date.now()) {
            this.pairings.delete(id);
            changed = true;
          }
        for (const [id, expiresAt] of this.seenPairings)
          if (expiresAt <= Date.now()) this.seenPairings.delete(id);
        for (const [id, expiresAt] of this.seenChannelOpens)
          if (expiresAt <= Date.now()) this.seenChannelOpens.delete(id);
        for (const [id, expiresAt] of this.seenChannelRecoveries)
          if (expiresAt <= Date.now()) this.seenChannelRecoveries.delete(id);
        if (this.remoteTasks.expire()) changed = true;
        for (const node of this.nodes.values())
          if (node.online && node.trusted && node.channelReady) {
            void this.flushRemoteTasks(node.id);
            void this.flushQueueReceipts(node.id);
            void this.flushBrainTasks(node.id);
          }
        for (const brainTask of this.brainTasks.list())
          if (brainTask.direction === 'owned' && brainTask.status === 'queued')
            void this.scheduleBrainTask(brainTask.id);
        if (changed) this.update();
      }, discoveryIntervalMilliseconds);
      this.timer.unref();
      this.status = 'online';
      this.error = null;
      this.update();
    } catch (error) {
      await this.stop();
      this.fail(
        error instanceof Error &&
          (error.message.includes('节点身份') ||
            error.message.includes('Brain 拓扑') ||
            error.message.includes('信任记录') ||
            error.message.includes('远端任务邀请记录') ||
            error.message.includes('Brain Task 记录'))
          ? error.message
          : '无法启动局域网节点发现；本机任务功能仍可继续使用。',
      );
    }
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.browser?.stop();
    this.browser = null;
    if (this.bonjour) {
      await new Promise<void>((resolve) => this.bonjour!.unpublishAll(() => resolve()));
      this.bonjour.destroy();
    }
    this.bonjour = null;
    this.service = null;
    if (this.discoverySocket) {
      const socket = this.discoverySocket;
      this.discoverySocket = null;
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    }
    for (const socket of this.discoveryQuerySockets) socket.close();
    this.discoveryQuerySockets.clear();
    this.discoveryQueries.clear();
    this.pairings.clear();
    this.seenPairings.clear();
    this.sendingRevocations.clear();
    this.revocationAttempts.clear();
    for (const nodeID of this.channels.keys()) this.forgetChannel(nodeID);
    this.openingChannels.clear();
    this.requestingChannelRecovery.clear();
    this.seenChannelOpens.clear();
    this.seenChannelRecoveries.clear();
    this.channelSendQueues.clear();
    this.deliveringRemoteTasks.clear();
    this.deliveringBrainTasks.clear();
    this.schedulingBrainTasks.clear();
    if (this.peerServer)
      await new Promise<void>((resolve) => this.peerServer!.close(() => resolve()));
    this.peerServer = null;
    await this.sendDiscoveryDeparture();
    this.discoveryPort = 0;
    this.peerPort = 0;
    this.nodes.clear();
  }
}
