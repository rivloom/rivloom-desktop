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

type StoredPolicy = { version: 2; policy: NodeExecutionPolicy };
type LegacyPolicy = {
  enabled: boolean;
  mode: 'automatic' | 'limited' | 'confirm';
  projectID: string | null;
  model: string | null;
  allowedNodeIDs: string[];
  maxConcurrent: 1;
  updatedAt: string | null;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const emptyPolicy = (): NodeExecutionPolicy => ({
  enabled: false,
  approvalMode: 'ask',
  projectID: null,
  model: null,
  maxConcurrent: 1,
  updatedAt: null,
});

function validPolicy(value: unknown): value is NodeExecutionPolicy {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.enabled === 'boolean' &&
    ['ask', 'auto', 'full'].includes(String(item.approvalMode)) &&
    (item.projectID === null ||
      (typeof item.projectID === 'string' && uuidPattern.test(item.projectID))) &&
    (item.model === null ||
      (typeof item.model === 'string' && item.model.length >= 3 && item.model.length <= 200)) &&
    item.maxConcurrent === 1 &&
    (item.updatedAt === null ||
      (typeof item.updatedAt === 'string' && Number.isFinite(Date.parse(item.updatedAt)))) &&
    (!item.enabled || (item.projectID !== null && item.model !== null))
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
    if (!stored || typeof stored !== 'object')
      throw new Error('本机执行能力配置无效；自动调用保持关闭。');
    const record = stored as Record<string, unknown>;
    if (record.version === 1) {
      const legacy = record.policy as LegacyPolicy;
      if (
        !legacy ||
        typeof legacy.enabled !== 'boolean' ||
        !['automatic', 'limited', 'confirm'].includes(legacy.mode) ||
        (legacy.projectID !== null && !uuidPattern.test(legacy.projectID)) ||
        (legacy.model !== null &&
          (typeof legacy.model !== 'string' ||
            legacy.model.length < 3 ||
            legacy.model.length > 200))
      )
        throw new Error('本机执行能力配置无效；自动调用保持关闭。');
      const keepEnabled = legacy.enabled && legacy.mode === 'automatic';
      this.value = {
        enabled: keepEnabled,
        approvalMode: 'ask',
        projectID: keepEnabled ? legacy.projectID : null,
        model: keepEnabled ? legacy.model : null,
        maxConcurrent: 1,
        updatedAt: legacy.updatedAt,
      };
      if (!validPolicy(this.value)) throw new Error('本机执行能力配置无效；自动调用保持关闭。');
      this.persist();
      return this.snapshot();
    }
    if (record.version !== 2 || !validPolicy(record.policy))
      throw new Error('本机执行能力配置无效；自动调用保持关闭。');
    this.value = { ...(record as StoredPolicy).policy };
    return this.snapshot();
  }

  snapshot(): NodeExecutionPolicy {
    return { ...this.value };
  }

  save(input: Omit<NodeExecutionPolicy, 'maxConcurrent' | 'updatedAt'>) {
    const next: NodeExecutionPolicy = {
      enabled: input.enabled,
      approvalMode: input.approvalMode,
      projectID: input.enabled ? input.projectID : null,
      model: input.enabled ? input.model : null,
      maxConcurrent: 1,
      updatedAt: new Date().toISOString(),
    };
    if (!validPolicy(next)) throw new Error('本机执行能力配置无效。');
    this.value = next;
    this.persist();
    return this.snapshot();
  }

  allows() {
    return this.value.enabled;
  }

  private persist() {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    try {
      const stored: StoredPolicy = { version: 2, policy: this.value };
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
