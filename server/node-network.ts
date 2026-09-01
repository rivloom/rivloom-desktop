import Bonjour from 'bonjour-service';
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { NodeNetwork as NodeNetworkSnapshot, RivloomNode } from '../shared/types.ts';
import {
  fingerprintForPublicKey,
  loadNodeIdentity,
  nodeIDForPublicKey,
  nodeProtocolVersion,
  type NodeIdentity,
} from './node-identity.ts';

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
  brain: { id: string; name: string };
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

const serviceType = 'rivloom';
const capabilities = ['brain', 'executor', 'human-ui'];
const maximumHelloBytes = 16 * 1024;
const maximumDiscoveryBytes = 2 * 1024;
const defaultDiscoveryPort = 43_531;
const discoveryProtocol = 'rivloom-node-discovery';

function unsignedHello(value: Omit<Hello, 'signature'>) {
  return JSON.stringify({
    protocolVersion: value.protocolVersion,
    nodeID: value.nodeID,
    name: value.name,
    brain: { id: value.brain.id, name: value.brain.name },
    capabilities: [...value.capabilities].sort(),
    port: value.port,
    nonce: value.nonce,
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

function publicNode(identity: NodeIdentity, port: number): RivloomNode {
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
    verified: true,
    lastSeen: new Date().toISOString(),
    capabilities,
    brains: [{ id: identity.brainID, name: `Brain ${identity.brainID.slice(0, 6)}` }],
  };
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
    typeof brain.id === 'string' &&
    /^[0-9a-f-]{36}$/i.test(brain.id) &&
    typeof brain.name === 'string' &&
    brain.name.length >= 1 &&
    brain.name.length <= 80 &&
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
  private readonly root: string;
  private readonly enabled: boolean;

  constructor(root: string, enabled = process.env.RIVLOOM_NODE_NETWORK !== 'disabled') {
    super();
    this.root = root;
    this.enabled = enabled;
    this.status = enabled ? 'starting' : 'disabled';
  }

  snapshot(): NodeNetworkSnapshot {
    return {
      status: this.status,
      serviceType: `_${serviceType}._tcp.local · LAN UDP ${this.discoveryPort || defaultDiscoveryPort}`,
      local: this.identity ? publicNode(this.identity, this.peerPort) : null,
      nearby: [...this.nodes.values()].sort((a, b) => a.name.localeCompare(b.name)),
      error: this.error,
    };
  }

  private update() {
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

  private rateLimited(remoteAddress: string) {
    const at = Date.now();
    for (const [key, value] of this.requests) if (value.until < at) this.requests.delete(key);
    const bucket = this.requests.get(remoteAddress) || { count: 0, until: at + 60_000 };
    bucket.count++;
    this.requests.set(remoteAddress, bucket);
    return bucket.count > 60;
  }

  private createPeerServer(identity: NodeIdentity) {
    const server = createServer((request, response) => {
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('X-Frame-Options', 'DENY');
      response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      const remote = request.socket.remoteAddress;
      if (!this.allowed(remote)) {
        response.writeHead(403).end();
        return;
      }
      if (this.rateLimited(remote!)) {
        response.writeHead(429).end();
        return;
      }
      const url = new URL(request.url || '/', 'http://rivloom.local');
      if (request.method !== 'GET' || url.pathname !== '/v1/hello') {
        response.writeHead(404).end();
        return;
      }
      const nonce = url.searchParams.get('nonce') || '';
      if (!/^[A-Za-z0-9_-]{32}$/.test(nonce)) {
        response.writeHead(400).end();
        return;
      }
      const value: Omit<Hello, 'signature'> = {
        protocolVersion: nodeProtocolVersion,
        nodeID: identity.nodeID,
        name: `Rivloom ${identity.nodeID.slice(0, 6)}`,
        brain: { id: identity.brainID, name: `Brain ${identity.brainID.slice(0, 6)}` },
        capabilities,
        port: this.peerPort,
        nonce,
        issuedAt: Date.now(),
        publicKey: identity.publicKey,
      };
      const body = JSON.stringify({ ...value, signature: identity.sign(unsignedHello(value)) });
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      });
      response.end(body);
    });
    server.headersTimeout = 5000;
    server.requestTimeout = 5000;
    server.keepAliveTimeout = 1000;
    server.maxRequestsPerSocket = 10;
    return server;
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
            value.brain.id !== advertised.brainID ||
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
          this.nodes.set(value.nodeID, {
            id: value.nodeID,
            name: value.name,
            fingerprint: computedFingerprint,
            protocolVersion: value.protocolVersion,
            addresses: [address],
            port: value.port,
            online: true,
            local: false,
            trusted: false,
            verified: true,
            lastSeen: new Date().toISOString(),
            capabilities: [...new Set(value.capabilities)].sort(),
            brains: [value.brain],
          });
          this.update();
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
      brainID: this.identity!.brainID,
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
      if (value.nodeID === this.identity.nodeID || this.rateLimited(remote.address)) return;
      const response = Buffer.from(JSON.stringify(this.discoveryResponse(value.nonce)));
      socket.send(response, remote.port, remote.address, () => undefined);
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

  async start() {
    if (!this.enabled || this.peerServer) return;
    try {
      this.identity = loadNodeIdentity(this.root);
      this.peerServer = this.createPeerServer(this.identity);
      const configuredPort = Number(process.env.RIVLOOM_PEER_PORT || 0);
      if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65_535)
        throw new Error('RIVLOOM_PEER_PORT 不是有效端口。');
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        this.peerServer!.once('error', onError);
        this.peerServer!.listen(configuredPort, '0.0.0.0', () => {
          this.peerServer!.off('error', onError);
          resolve();
        });
      });
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
            brain: this.identity.brainID,
            cap: capabilities.join(','),
          },
        });
        this.service.on('error', () => this.fail('无法发布 Rivloom 节点，请检查 Windows 防火墙。'));
        this.browser = this.bonjour.find({ type: serviceType, protocol: 'tcp' }, (found) => {
          void this.probe(found as MdnsService);
        });
        this.browser.on('down', (found) => {
          const id = serviceIdentity(found as MdnsService).nodeID;
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
        const cutoff = Date.now() - 120_000;
        let changed = false;
        for (const [id, node] of this.nodes)
          if (Date.parse(node.lastSeen) < cutoff) {
            this.nodes.delete(id);
            changed = true;
          }
        if (changed) this.update();
      }, 20_000);
      this.timer.unref();
      this.status = 'online';
      this.error = null;
      this.update();
    } catch (error) {
      await this.stop();
      this.fail(
        error instanceof Error && error.message.includes('节点身份')
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
    this.discoveryPort = 0;
    this.discoveryQueries.clear();
    if (this.peerServer)
      await new Promise<void>((resolve) => this.peerServer!.close(() => resolve()));
    this.peerServer = null;
    this.peerPort = 0;
    this.nodes.clear();
  }
}
