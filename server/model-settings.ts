import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { db, tasks, requireThat, exclusive, now, HttpError } from './store.ts';
import { dataRoot } from './engine.ts';
import { engineClient, engineStatus, refreshEngineConfiguration, changed } from './task-service.ts';
import {
  activeStates,
  type ModelCheck,
  type ModelOperation,
  type ModelSettings,
  type User,
} from '../shared/types.ts';

type Preferences = {
  defaultModel: string | null;
  credentialUpdatedAt: string | null;
  checks: Record<string, ModelCheck>;
};

const checkSchema = z.object({
  status: z.enum(['testing', 'passed', 'failed', 'interrupted']),
  at: z.string().datetime(),
  message: z.string().max(600),
});
const preferencesSchema = z.object({
  defaultModel: z.string().max(200).nullable(),
  credentialUpdatedAt: z.string().datetime().nullable(),
  checks: z.record(z.string().max(200), checkSchema),
});
const emptyPreferences = (): Preferences => ({
  defaultModel: null,
  credentialUpdatedAt: null,
  checks: {},
});

export function parsePreferences(value: unknown): Preferences {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    const checked = preferencesSchema.safeParse(parsed);
    return checked.success ? checked.data : emptyPreferences();
  } catch {
    return emptyPreferences();
  }
}

const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get('models');
const preferences = row ? parsePreferences(row.value) : emptyPreferences();
function save() {
  db.prepare(
    'INSERT INTO app_settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  ).run('models', JSON.stringify(preferences));
}
for (const check of Object.values(preferences.checks)) {
  if (check.status === 'testing') {
    check.status = 'interrupted';
    check.message = '应用重启，测试中断。不会自动重试或继续计费。';
  }
}
save();

let activeCheck: {
  model: string;
  sessionID: string;
  actorID: string;
  abort: AbortController;
} | null = null;
const checkDirectory = join(dataRoot, 'model-check');
mkdirSync(checkDirectory, { recursive: true });

function operation(
  actorID: string | null,
  kind: ModelOperation['kind'],
  provider: string,
  model: string | null,
  result: string,
) {
  db.prepare(
    'INSERT INTO model_operations (actor_id,kind,provider,model,result,at) VALUES (?,?,?,?,?,?)',
  ).run(actorID, kind, provider, model, result, now());
}

function recentOperations(): ModelOperation[] {
  return db
    .prepare(
      "SELECT mo.id,mo.actor_id AS actorID,COALESCE(u.name,'系统') AS actorName," +
        ' mo.kind,mo.provider,mo.model,mo.result,mo.at' +
        ' FROM model_operations mo LEFT JOIN users u ON u.id=mo.actor_id' +
        ' ORDER BY mo.id DESC LIMIT 30',
    )
    .all() as unknown as ModelOperation[];
}

function busyReason() {
  if (activeCheck) return '模型连接测试正在运行';
  if (tasks().some((task) => activeStates.includes(task.state)))
    return '有任务正在执行或等待人工介入';
  if (tasks().some((task) => task.state === 'interrupted')) return '有执行中断的任务尚未处理';
  return null;
}

export function defaultModel() {
  const desired = preferences.defaultModel || process.env.RIVLOOM_MODEL;
  return (
    engineStatus.models.find((model) => model.id === desired)?.id ||
    engineStatus.models.find((model) => model.id.startsWith('deepseek/'))?.id ||
    engineStatus.models.find((model) => model.id === 'opencode/mimo-v2.5-free')?.id ||
    engineStatus.models[0]?.id ||
    ''
  );
}

export function modelSettings(): ModelSettings {
  const deepseekConfigured = engineStatus.connectedProviders.includes('deepseek');
  const verified = Object.entries(preferences.checks).some(
    ([model, check]) =>
      model.startsWith('deepseek/') &&
      check.status === 'passed' &&
      (!preferences.credentialUpdatedAt || check.at >= preferences.credentialUpdatedAt),
  );
  const reason = busyReason();
  return {
    defaultModel: defaultModel(),
    models: engineStatus.models,
    deepseekConfigured,
    credentialUpdatedAt: preferences.credentialUpdatedAt,
    credentialState: deepseekConfigured
      ? verified
        ? 'verified'
        : 'configured_unverified'
      : preferences.credentialUpdatedAt
        ? 'needs_review'
        : 'unconfigured',
    checks: preferences.checks,
    busy: !!reason,
    busyReason: reason,
    operations: recentOperations(),
  };
}

export function assertCanStartTask() {
  requireThat(!activeCheck, 409, '模型连接测试中，请等待结果或先停止测试');
}

function requireOwner(actor: User) {
  requireThat(actor.owner, 403, '只有工作区创建者可以管理模型及凭据');
}

function requireIdle() {
  requireThat(engineStatus.ready, 503, '请等待引擎就绪');
  requireThat(!activeCheck, 409, '连接测试尚未结束，请先停止或等待');
  requireThat(
    !tasks().some((task) => activeStates.includes(task.state) || task.state === 'interrupted'),
    409,
    '请先停止执行中的任务，并确认处理执行中断的任务，再修改模型设置或测试',
  );
}

export async function saveDeepSeek(actor: User, key: string | null) {
  requireOwner(actor);
  return exclusive('engine-settings', async () => {
    requireIdle();
    if (key === null) await engineClient().auth.remove({ providerID: 'deepseek' });
    else await engineClient().auth.set({ providerID: 'deepseek', auth: { type: 'api', key } });
    // Store only status metadata in our database. OpenCode owns the credential file.
    preferences.credentialUpdatedAt = key === null ? null : now();
    for (const model of Object.keys(preferences.checks)) {
      if (model.startsWith('deepseek/')) delete preferences.checks[model];
    }
    if (preferences.defaultModel?.startsWith('deepseek/')) preferences.defaultModel = null;
    save();
    let refreshResult = 'ok';
    try {
      await refreshEngineConfiguration();
    } catch {
      refreshResult = 'refresh_uncertain';
      engineStatus.models = [];
      engineStatus.connectedProviders = [];
      changed();
      operation(
        actor.id,
        key === null ? 'credential_removed' : 'credential_saved',
        'deepseek',
        null,
        refreshResult,
      );
      throw new HttpError(503, '凭据操作已提交，但模型列表刷新失败。请重启应用后确认状态。');
    }
    operation(
      actor.id,
      key === null ? 'credential_removed' : 'credential_saved',
      'deepseek',
      null,
      refreshResult,
    );
    return modelSettings();
  });
}

export async function chooseDefaultModel(actor: User, model: string) {
  requireOwner(actor);
  return exclusive('engine-settings', async () => {
    requireThat(
      engineStatus.models.some((candidate) => candidate.id === model),
      400,
      '请选择当前已配置的模型',
    );
    preferences.defaultModel = model;
    save();
    operation(actor.id, 'default_changed', model.split('/')[0] || 'unknown', model, 'ok');
    changed();
    return modelSettings();
  });
}

export function connectionFailure(error: unknown): string {
  // Never pass through provider bodies, request objects, headers or arbitrary messages.
  const value = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const data =
    value.data && typeof value.data === 'object' ? (value.data as Record<string, unknown>) : value;
  const status = Number(data.statusCode || data.status);
  if (status === 401) return '提供方拒绝认证，请检查 API Key 是否正确、有效。';
  if (status === 402) return '提供方提示余额或额度不足，请到官方控制台检查。';
  if (status === 403) return '提供方拒绝访问，请检查账号权限、模型权限或服务地区。';
  if (status === 429) return '提供方限流或额度受限，请检查控制台并稍后手动重试。';
  if (status === 400 || status === 404) return '提供方不接受此模型或请求，请核对模型可用性。';
  return '调用未成功。请检查网络、API Key、模型权限和余额；不会自动重试。';
}

function requireTestBudget() {
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM model_operations WHERE kind='test_started' AND at>=?")
    .get(since) as { count: number };
  requireThat(row.count < 3, 429, '10 分钟内最多执行 3 次真实连接测试，请稍后再试');
}

export async function startConnectionCheck(actor: User, model: string) {
  requireOwner(actor);
  return exclusive('engine-settings', async () => {
    requireIdle();
    requireTestBudget();
    requireThat(
      engineStatus.models.some((candidate) => candidate.id === model),
      400,
      '请选择当前已配置的模型',
    );
    const created = (
      await engineClient().session.create({
        directory: checkDirectory,
        title: 'Rivloom 模型连接测试',
        permission: [{ permission: '*', pattern: '*', action: 'deny' }],
      })
    ).data!;
    const check = {
      model,
      sessionID: created.id,
      actorID: actor.id,
      abort: new AbortController(),
    };
    activeCheck = check;
    preferences.checks[model] = {
      status: 'testing',
      at: now(),
      message: '正在通过 OpenCode 实际调用模型…',
    };
    save();
    operation(actor.id, 'test_started', model.split('/')[0] || 'unknown', model, 'started');
    changed();
    void executeCheck(check);
    return modelSettings();
  });
}

async function executeCheck(check: NonNullable<typeof activeCheck>) {
  const params = { directory: checkDirectory, sessionID: check.sessionID };
  const signal = AbortSignal.any([check.abort.signal, AbortSignal.timeout(60_000)]);
  const [providerID, ...parts] = check.model.split('/');
  let result: ModelCheck = { status: 'failed', at: now(), message: '未收到有效结果。' };
  try {
    await engineClient().session.promptAsync(
      {
        ...params,
        model: { providerID, modelID: parts.join('/') },
        parts: [
          {
            type: 'text',
            text: 'This is a connection test. Reply with exactly RIVLOOM_OK. Do not use tools or access files.',
          },
        ],
      },
      { signal },
    );
    while (!signal.aborted) {
      // Reconcile one official engine invocation; no custom agent loop or model retry.
      const messages = (await engineClient().session.messages(params, { signal })).data || [];
      const assistant = messages.findLast((message) => message.info.role === 'assistant');
      if (assistant?.info.role === 'assistant') {
        if (assistant.info.error) throw assistant.info.error;
        if (assistant.info.time.completed) {
          const response = assistant.parts
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n')
            .trim();
          requireThat(response.includes('RIVLOOM_OK'), 502, '未收到约定测试回应');
          result = {
            status: 'passed',
            at: now(),
            message:
              '已通过 OpenCode 收到模型的真实回复。仅证明本次连接可用，不代表编程能力或后续额度保证。',
          };
          break;
        }
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, 700);
        signal.addEventListener('abort', done, { once: true });
      });
    }
    if (signal.aborted) throw signal.reason;
  } catch (error) {
    result = {
      status: check.abort.signal.aborted ? 'interrupted' : 'failed',
      at: now(),
      message: check.abort.signal.aborted
        ? '测试已停止，不会自动重试；已发送的请求可能仍计费。'
        : signal.aborted
          ? '60 秒内未完成测试，已请求停止；请检查网络及额度后手动重试。'
          : connectionFailure(error),
    };
  } finally {
    // Bound cleanup and do not preserve model responses in the business database.
    try {
      await engineClient().session.abort(params, { signal: AbortSignal.timeout(5000) });
      await engineClient().session.delete(params, { signal: AbortSignal.timeout(5000) });
    } catch {
      result = {
        status: 'interrupted',
        at: now(),
        message: '测试清理未确认完成。请重启应用以结束后台引擎，再手动重试；已有请求可能计费。',
      };
      preferences.checks[check.model] = result;
      operation(check.actorID, 'test_finished', providerID, check.model, result.status);
      save();
      changed();
      return;
    }
    preferences.checks[check.model] = result;
    activeCheck = null;
    operation(check.actorID, 'test_finished', providerID, check.model, result.status);
    save();
    changed();
  }
}

export function cancelConnectionCheck(actor: User) {
  requireOwner(actor);
  requireThat(activeCheck, 409, '没有正在执行的连接测试');
  activeCheck.abort.abort();
  return { ok: true };
}
