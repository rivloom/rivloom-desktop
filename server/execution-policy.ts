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
import { defaultRemoteConcurrency, validRemoteConcurrency } from '../shared/execution-concurrency.ts';

type StoredPolicy = { version: 3; policy: NodeExecutionPolicy };
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
  maxConcurrent: defaultRemoteConcurrency,
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
    validRemoteConcurrency(item.maxConcurrent) &&
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
      const migrated = {
        enabled: keepEnabled,
        approvalMode: 'ask' as const,
        projectID: keepEnabled ? legacy.projectID : null,
        model: keepEnabled ? legacy.model : null,
        maxConcurrent: defaultRemoteConcurrency,
        updatedAt: legacy.updatedAt,
      };
      if (!validPolicy(migrated)) throw new Error('本机执行能力配置无效；自动调用保持关闭。');
      this.persist(migrated);
      this.value = migrated;
      return this.snapshot();
    }
    if (record.version === 2) {
      const legacy = record.policy as NodeExecutionPolicy;
      if (!validPolicy(legacy) || legacy.maxConcurrent !== 1)
        throw new Error('本机执行能力配置无效；自动调用保持关闭。');
      const migrated = { ...legacy, maxConcurrent: defaultRemoteConcurrency };
      this.persist(migrated);
      this.value = migrated;
      return this.snapshot();
    }
    if (record.version !== 3 || !validPolicy(record.policy))
      throw new Error('本机执行能力配置无效；自动调用保持关闭。');
    this.value = { ...(record as StoredPolicy).policy };
    return this.snapshot();
  }

  snapshot(): NodeExecutionPolicy {
    return { ...this.value };
  }

  save(input: Omit<NodeExecutionPolicy, 'maxConcurrent' | 'updatedAt'> & { maxConcurrent?: number }) {
    const next: NodeExecutionPolicy = {
      enabled: input.enabled,
      approvalMode: input.approvalMode,
      projectID: input.enabled ? input.projectID : null,
      model: input.enabled ? input.model : null,
      maxConcurrent: input.maxConcurrent === undefined ? this.value.maxConcurrent : input.maxConcurrent,
      updatedAt: new Date().toISOString(),
    };
    if (!validPolicy(next)) throw new Error('本机执行能力配置无效。');
    this.persist(next);
    this.value = next;
    return this.snapshot();
  }

  allows() {
    return this.value.enabled;
  }

  saveConcurrency(maxConcurrent: number) {
    if (!validRemoteConcurrency(maxConcurrent)) throw new Error('远端任务并发数必须是 1–10 的整数。');
    const next = { ...this.value, maxConcurrent, updatedAt: new Date().toISOString() };
    this.persist(next);
    this.value = next;
    return this.snapshot();
  }

  private persist(policy = this.value) {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    try {
      const stored: StoredPolicy = { version: 3, policy };
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
