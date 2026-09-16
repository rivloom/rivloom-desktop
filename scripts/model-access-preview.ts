// In-memory UI acceptance fixture. It never runs an engine, opens OAuth, or retains keys.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { startSearchPreview } from './conversation-search-preview.ts';
import {
  customProviderSchema,
  type ProviderAccess,
  type OAuthStatus,
} from '../shared/model-providers.ts';
import type { ModelSettings } from '../shared/types.ts';

export async function startModelAccessPreview(dist = resolve('dist')) {
  const providers: ProviderAccess[] = [
    { id: 'deepseek', name: 'DeepSeek', connected: false, apiKey: true, modelCount: 2, oauth: [] },
    {
      id: 'opencode-go',
      name: 'OpenCode Go',
      connected: false,
      apiKey: true,
      modelCount: 3,
      oauth: [],
    },
    {
      id: 'openai',
      name: 'OpenAI',
      connected: false,
      apiKey: true,
      modelCount: 2,
      oauth: [
        { index: 0, label: 'ChatGPT Pro/Plus (browser)', prompts: [] },
        { index: 1, label: 'ChatGPT Pro/Plus (headless)', prompts: [] },
      ],
    },
    {
      id: 'github-copilot',
      name: 'GitHub Copilot',
      connected: false,
      apiKey: false,
      modelCount: 1,
      oauth: [
        {
          index: 0,
          label: 'Login with GitHub Copilot',
          prompts: [
            {
              type: 'select',
              key: 'deploymentType',
              message: 'Select GitHub deployment type',
              options: [
                { label: 'GitHub.com', value: 'github.com' },
                { label: 'GitHub Enterprise', value: 'enterprise' },
              ],
            },
            {
              type: 'text',
              key: 'enterpriseUrl',
              message: 'Enter your GitHub Enterprise URL or domain',
              when: { key: 'deploymentType', op: 'eq', value: 'enterprise' },
            },
          ],
        },
      ],
    },
  ];
  let oauth: OAuthStatus | null = null;
  let settings: ModelSettings = {
    defaultModel: 'preview/no-model',
    models: [{ id: 'preview/no-model', name: '演示 · 不调用模型' }],
    deepseekConfigured: false,
    credentialState: 'unconfigured',
    credentialUpdatedAt: null,
    checks: {},
    busy: false,
    busyReason: null,
    operations: [],
  };
  const requests: { path: string; method: string }[] = [];
  const updateModels = () => {
    settings.models = [
      { id: 'preview/no-model', name: '演示 · 不调用模型' },
      ...providers
        .filter((p) => p.connected)
        .flatMap((p) =>
          (p.custom?.models || [{ id: 'demo-model', name: 'Demo model' }]).map((m) => ({
            id: `${p.id}/${m.id}`,
            name: `${m.name} · ${p.name}${p.account ? ' / ' + p.account.name : ''}`,
            modelName: m.name,
            providerID: p.id,
            providerName: p.name,
            ...(p.account
              ? { accountName: p.account.name, sourceProviderID: p.account.providerID }
              : p.accountName
                ? { accountName: p.accountName }
                : {}),
          })),
        ),
    ];
  };
  const preview = await startSearchPreview(dist, async (req, res, data) => {
    data.user.name = '模型接入演示 · 不使用真实凭据';
    const path = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    if (!path.startsWith('/api/model-settings')) return false;
    requests.push({ path, method: req.method || 'GET' });
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
      return true;
    };
    if (req.method === 'GET')
      return json(
        path.endsWith('/providers') ? providers : path.endsWith('/oauth') ? oauth : settings,
      );
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 30000) return json({ error: 'Preview input too large' }, 413);
    }
    const body = JSON.parse(raw || '{}');
    const accountTarget = () => {
      const source = providers.find((p) => p.id === body.providerID)!;
      if (!body.account) return source;
      if (body.account.id) {
        const entry = providers.find((p) => p.id === body.account.id)!;
        if (entry.account) entry.account.name = body.account.name;
        else entry.accountName = body.account.name;
        return entry;
      }
      const entry: ProviderAccess = {
        ...source,
        id: `rivloom-account-${randomUUID()}`,
        connected: false,
        account: { providerID: source.id, name: body.account.name },
      };
      providers.push(entry);
      return entry;
    };
    if (path.endsWith('/provider/custom')) {
      const checked = customProviderSchema.safeParse(body.provider);
      if (!checked.success)
        return json({ error: 'Check the provider ID, API URL, model IDs and limits.' }, 400);
      const p = checked.data;
      const index = providers.findIndex((v) => v.id === p.id);
      if (index !== -1 && !providers[index].custom)
        return json({ error: 'Provider ID already exists.' }, 409);
      const entry = {
        id: p.id,
        name: p.name,
        custom: p,
        connected: true,
        apiKey: false,
        modelCount: p.models.length,
        oauth: [],
      };
      if (index === -1) providers.push(entry);
      else providers[index] = entry;
      updateModels();
    } else if (path.endsWith('/provider/key')) {
      const p = accountTarget();
      if (p) p.connected = true;
      updateModels();
    } else if (path.endsWith('/provider/rename')) {
      const entry = providers.find((p) => p.id === body.id)!;
      if (entry.account) entry.account.name = body.name;
      else entry.accountName = body.name;
      updateModels();
    } else if (path.endsWith('/provider/remove')) {
      const index = providers.findIndex((p) => p.id === body.providerID);
      if (index !== -1) {
        if (providers[index].custom || providers[index].account) providers.splice(index, 1);
        else providers[index].connected = false;
      }
      updateModels();
      if (!settings.models.some((m) => m.id === settings.defaultModel))
        settings.defaultModel = settings.models[0].id;
    } else if (path.endsWith('/default')) settings.defaultModel = body.model;
    else if (path.endsWith('/oauth/start')) {
      const target = accountTarget();
      oauth = {
        id: randomUUID(),
        providerID: body.providerID,
        ...(target.account ? { accountID: target.id } : {}),
        status: 'waiting',
        url: 'https://example.invalid/oauth-preview',
        instructions: '演示授权码：RIVLOOM-DEMO。请勿输入真实账号或凭据。',
        mode: body.method === 1 ? 'code' : 'auto',
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      };
      settings.busy = true;
      settings.busyReason = 'Provider sign-in is in progress.';
      return json(oauth, 202);
    } else if (path.endsWith('/oauth/complete')) {
      if (oauth) {
        oauth.status = 'connected';
        delete oauth.url;
        delete oauth.instructions;
        const p = providers.find((p) => p.id === (oauth!.accountID || oauth!.providerID));
        if (p) p.connected = true;
      }
      updateModels();
      settings.busy = false;
      settings.busyReason = null;
      data.engine.models = settings.models;
      preview.flush();
      return json(oauth, 202);
    } else if (path.endsWith('/oauth/cancel')) {
      if (oauth) {
        oauth.status = 'cancelled';
        delete oauth.url;
        delete oauth.instructions;
      }
      settings.busy = false;
      settings.busyReason = null;
      return json(oauth);
    } else return json({ error: '合成预览不打开厂商登录，也不执行模型测试。' }, 409);
    data.engine.models = settings.models;
    data.defaultModel = settings.defaultModel;
    preview.flush();
    return json(settings);
  });
  return { ...preview, providers, modelRequests: requests };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const index = process.argv.indexOf('--dist');
  const preview = await startModelAccessPreview(
    index === -1 ? undefined : resolve(process.argv[index + 1]),
  );
  console.log(
    `Rivloom model access preview: ${preview.origin}\nSynthetic data only; do not enter real credentials. Ctrl+C to stop.`,
  );
  if (process.argv.includes('--open'))
    execFile('rundll32.exe', ['url.dll,FileProtocolHandler', preview.origin], {
      windowsHide: true,
    });
  process.once('SIGINT', () => void preview.close());
  process.once('SIGTERM', () => void preview.close());
}
