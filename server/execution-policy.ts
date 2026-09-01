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
import type { NodeExecutionPolicy } from '../shared/types.ts';

type StoredPolicy = { version: 1; policy: NodeExecutionPolicy };

const nodePattern = /^[A-Za-z0-9_-]{32}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const emptyPolicy = (): NodeExecutionPolicy => ({
  enabled: false,
  mode: 'automatic',
  projectID: null,
  model: null,
  allowedNodeIDs: [],
  maxConcurrent: 1,
  updatedAt: null,
});

function validPolicy(value: unknown): value is NodeExecutionPolicy {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.enabled === 'boolean' &&
    ['automatic', 'limited', 'confirm'].includes(String(item.mode)) &&
    (item.projectID === null ||
      (typeof item.projectID === 'string' && uuidPattern.test(item.projectID))) &&
    (item.model === null ||
      (typeof item.model === 'string' && item.model.length >= 3 && item.model.length <= 200)) &&
    Array.isArray(item.allowedNodeIDs) &&
    item.allowedNodeIDs.length <= 100 &&
    item.allowedNodeIDs.every((nodeID) => typeof nodeID === 'string' && nodePattern.test(nodeID)) &&
    new Set(item.allowedNodeIDs).size === item.allowedNodeIDs.length &&
    item.maxConcurrent === 1 &&
    (item.updatedAt === null ||
      (typeof item.updatedAt === 'string' && Number.isFinite(Date.parse(item.updatedAt)))) &&
    (!item.enabled || (item.projectID !== null && item.model !== null)) &&
    (item.mode !== 'limited' || !item.enabled || item.allowedNodeIDs.length > 0)
  );
}

export class ExecutionPolicyStore {
  private readonly path: string;
  private value = emptyPolicy();

  constructor(root: string) {
    this.path = join(root, 'execution-policy.json');
  }

  load() {
    if (!existsSync(this.path)) return this.snapshot();
    let stored: unknown;
    try {
      stored = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
    } catch {
      throw new Error('本机执行能力配置损坏；自动调用保持关闭。');
    }
    if (
      !stored ||
      typeof stored !== 'object' ||
      (stored as Record<string, unknown>).version !== 1 ||
      !validPolicy((stored as Record<string, unknown>).policy)
    )
      throw new Error('本机执行能力配置无效；自动调用保持关闭。');
    this.value = {
      ...(stored as StoredPolicy).policy,
      allowedNodeIDs: [...(stored as StoredPolicy).policy.allowedNodeIDs],
    };
    return this.snapshot();
  }

  snapshot(): NodeExecutionPolicy {
    return { ...this.value, allowedNodeIDs: [...this.value.allowedNodeIDs] };
  }

  save(input: Omit<NodeExecutionPolicy, 'maxConcurrent' | 'updatedAt'>) {
    const next: NodeExecutionPolicy = {
      enabled: input.enabled,
      mode: input.mode,
      projectID: input.enabled ? input.projectID : null,
      model: input.enabled ? input.model : null,
      allowedNodeIDs:
        input.mode === 'limited' && input.enabled ? [...new Set(input.allowedNodeIDs)].sort() : [],
      maxConcurrent: 1,
      updatedAt: new Date().toISOString(),
    };
    if (!validPolicy(next)) throw new Error('本机执行能力配置无效。');
    this.value = next;
    this.persist();
    return this.snapshot();
  }

  allows(nodeID: string) {
    if (!this.value.enabled) return false;
    if (this.value.mode === 'automatic') return true;
    if (this.value.mode === 'limited') return this.value.allowedNodeIDs.includes(nodeID);
    return false;
  }

  private persist() {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    try {
      const stored: StoredPolicy = { version: 1, policy: this.value };
      writeFileSync(temporary, JSON.stringify(stored, null, 2), { mode: 0o600, flag: 'wx' });
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
