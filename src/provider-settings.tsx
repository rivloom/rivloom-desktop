import { useEffect, useState } from 'react';
import { Check, ExternalLink, KeyRound, LoaderCircle, Plus, Trash2 } from 'lucide-react';
import { t, systemText } from '../shared/i18n.ts';
import {
  promptVisible,
  type CustomProvider,
  type OAuthStatus,
  type ProviderAccess,
} from '../shared/model-providers.ts';
import { api } from './api.ts';
import './provider-settings.css';

const emptyCustom = (): CustomProvider => ({
  id: '',
  name: '',
  baseURL: '',
  protocol: 'chat',
  models: [],
  context: 32768,
  output: 4096,
  keyless: false,
});
const oauthActive = (v: OAuthStatus | null) =>
  !!v && ['starting', 'waiting', 'connecting', 'saving'].includes(v.status);

export function ProviderSettings({
  owner,
  locked,
  engineReady,
  revision,
  onChanged,
}: {
  owner: boolean;
  locked: boolean;
  engineReady: boolean;
  revision: number;
  onChanged: () => void;
}) {
  const [providers, setProviders] = useState<ProviderAccess[]>([]);
  const [selected, setSelected] = useState('deepseek');
  const [filter, setFilter] = useState('');
  const [key, setKey] = useState('');
  const [shared, setShared] = useState(false);
  const [custom, setCustom] = useState<CustomProvider | null>(null);
  const [modelLines, setModelLines] = useState('');
  const [editing, setEditing] = useState(false);
  const [method, setMethod] = useState(0);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [oauth, setOAuth] = useState<OAuthStatus | null>(null);
  const [code, setCode] = useState('');
  const [remove, setRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const provider = providers.find((p) => p.id === selected);
  const oauthMethod = provider?.oauth.find((m) => m.index === method) || provider?.oauth[0];
  const active = oauthActive(oauth);
  const disabled = !owner || locked || busy || active;
  const catalog = async () => {
    setProviders(await api<ProviderAccess[]>('/model-settings/providers'));
    setError('');
  };
  useEffect(() => {
    if (!engineReady) return;
    void catalog().catch((e) => setError(e.message));
    if (owner)
      void api<OAuthStatus | null>('/model-settings/oauth')
        .then(setOAuth)
        .catch((e) => setError(e.message));
  }, [owner, engineReady, revision]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      void api<OAuthStatus | null>('/model-settings/oauth')
        .then((next) => {
          setOAuth(next);
          if (!oauthActive(next)) {
            void catalog().catch((e) => setError(e.message));
            onChanged();
          }
        })
        .catch((e) => setError(e.message));
    }, 1200);
    return () => clearInterval(timer);
  }, [active]);

  function select(id: string) {
    setSelected(id);
    setKey('');
    setShared(false);
    setRemove(false);
    setInputs({});
    setMethod(0);
    setError('');
    setCustom(null);
    setEditing(false);
  }
  function edit(value?: CustomProvider) {
    setCustom(value ? structuredClone(value) : emptyCustom());
    setEditing(!!value);
    setModelLines(
      value?.models.map((m) => (m.name === m.id ? m.id : `${m.id} | ${m.name}`)).join('\n') || '',
    );
    setKey('');
    setShared(false);
    setError('');
    setRemove(false);
  }
  async function act(
    path: string,
    body: unknown,
    kind: 'settings' | 'oauth' | 'open' = 'settings',
  ) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<OAuthStatus>('/model-settings/' + path, body);
      if (kind === 'oauth') {
        setOAuth(result);
        setCode('');
        if (!oauthActive(result)) await catalog();
      }
      if (kind === 'settings') {
        await catalog();
        setCustom(null);
        if (path === 'provider/custom') {
          setSelected((body as { provider: CustomProvider }).provider.id);
          setFilter('');
        }
      }
      if (kind !== 'open') onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setKey('');
      if (kind === 'settings') setShared(false);
    }
  }
  const connected = providers.filter((p) => p.connected || p.custom);
  const choices = providers.filter(
    (p) =>
      !p.custom &&
      (p.apiKey || p.oauth.length || p.connected) &&
      (p.id + p.name).toLowerCase().includes(filter.toLowerCase()),
  );
  const authorizationInputs = {
    ...Object.fromEntries(
      (oauthMethod?.prompts || [])
        .filter((p) => p.type === 'select')
        .map((p) => [p.key, p.options?.[0]?.value || '']),
    ),
    ...inputs,
  };
  return (
    <section className="settings-card provider-settings">
      <header>
        <span className="settings-icon">
          <KeyRound size={21} />
        </span>
        <div>
          <span className="eyebrow">MODEL PROVIDERS</span>
          <h2>{t('模型接入')}</h2>
        </div>
        <button className="button" disabled={disabled} onClick={() => edit()}>
          <Plus size={15} />
          {t('自定义 Provider')}
        </button>
      </header>
      <p className="settings-copy">
        {t(
          '接入账号后，可在新会话中自由选择模型。OAuth 登录由厂商和官方引擎完成，Rivloom 不接收账号密码。',
        )}
      </p>
      {error && (
        <div className="error" role="alert">
          {systemText(error)}
        </div>
      )}
      {!!connected.length && (
        <div className="provider-connected" aria-label={t('已接入的 Provider')}>
          {connected.map((p) => (
            <button
              key={p.id}
              className={`provider-chip ${selected === p.id ? 'selected' : ''}`}
              onClick={() => {
                select(p.id);
                if (p.custom) edit(p.custom);
              }}
              disabled={active || busy}
            >
              {p.connected && <Check size={13} />}
              <span>{p.name}</span>
              <small>{p.modelCount}</small>
            </button>
          ))}
        </div>
      )}
      {active && oauth ? (
        <div className="provider-oauth" aria-live="polite">
          <h3>
            {t('正在连接 {{provider}}', {
              provider: providers.find((p) => p.id === oauth.providerID)?.name || oauth.providerID,
            })}
          </h3>
          {oauth.status === 'starting' ? (
            <p>
              <LoaderCircle size={16} className="spin" /> {t('正在准备厂商登录…')}
            </p>
          ) : (
            <>
              <p>{t('在系统浏览器中完成授权，然后回到这里确认连接。')}</p>
              {oauth.instructions && <pre className="oauth-instructions">{oauth.instructions}</pre>}
              {oauth.url && (
                <div className="oauth-link">
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => void act('oauth/open', { id: oauth.id }, 'open')}
                  >
                    <ExternalLink size={15} />
                    {t('打开厂商授权页')}
                  </button>
                  <label className="field">
                    <span>{t('授权链接（也可复制到浏览器）')}</span>
                    <input
                      aria-label={t('授权链接（也可复制到浏览器）')}
                      value={oauth.url}
                      readOnly
                      onFocus={(e) => e.target.select()}
                    />
                  </label>
                </div>
              )}
              {oauth.mode === 'code' && (
                <label className="field">
                  <span>{t('厂商返回的授权码')}</span>
                  <input
                    aria-label={t('厂商返回的授权码')}
                    type="password"
                    autoComplete="off"
                    value={code}
                    maxLength={8192}
                    onChange={(e) => setCode(e.target.value)}
                    disabled={oauth.status !== 'waiting'}
                  />
                </label>
              )}
              {oauth.status === 'saving' ? (
                <p>
                  <LoaderCircle size={16} className="spin" />
                  {t('正在保存已授权的账号…')}
                </p>
              ) : oauth.status === 'connecting' ? (
                <p>
                  <LoaderCircle size={16} className="spin" /> {t('正在等待厂商确认…')}
                </p>
              ) : (
                <button
                  className="button primary"
                  disabled={busy || (oauth.mode === 'code' && !code.trim())}
                  onClick={() =>
                    void act(
                      'oauth/complete',
                      { id: oauth.id, ...(code.trim() ? { code: code.trim() } : {}) },
                      'oauth',
                    )
                  }
                >
                  {t('已完成授权，连接')}
                </button>
              )}
            </>
          )}
          <button
            className="button"
            disabled={busy || oauth.status === 'saving'}
            onClick={() => void act('oauth/cancel', { id: oauth.id }, 'oauth')}
          >
            {t('取消登录')}
          </button>
          <small>{t('登录等待最多 10 分钟；取消后不会替换已有凭据。')}</small>
        </div>
      ) : (
        <>
          {oauth && (
            <div className={`notice ${oauth.status === 'failed' ? 'error' : ''}`} role="status">
              {oauth.status === 'connected'
                ? t('账号已接入，可选择模型。')
                : oauth.status === 'cancelled'
                  ? t('登录已取消。')
                  : t('登录未完成，请刷新状态后重试。')}
              {oauth.message && <small>{systemText(oauth.message)}</small>}
            </div>
          )}
          {custom ? (
            <form
              className="provider-form"
              onSubmit={(e) => {
                e.preventDefault();
                const models = modelLines
                  .split(/\r?\n/)
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .map((line) => {
                    const [id, ...label] = line.split('|');
                    return { id: id.trim(), name: label.join('|').trim() || id.trim() };
                  });
                void act('provider/custom', {
                  provider: { ...custom, models },
                  ...(key.trim() && !custom.keyless ? { key: key.trim() } : {}),
                  shared: true,
                });
              }}
            >
              <h3>{editing ? t('编辑自定义 Provider') : t('添加自定义 Provider')}</h3>
              <div className="provider-form-grid">
                <label className="field">
                  <span>{t('显示名称')}</span>
                  <input
                    aria-label={t('显示名称')}
                    required
                    maxLength={80}
                    value={custom.name}
                    disabled={disabled}
                    onChange={(e) => setCustom({ ...custom, name: e.target.value })}
                    placeholder="My Provider"
                  />
                </label>
                <label className="field">
                  <span>{t('Provider ID')}</span>
                  <input
                    aria-label="Provider ID"
                    required
                    pattern="[a-z][a-z0-9-]{0,59}"
                    maxLength={60}
                    value={custom.id}
                    disabled={disabled || editing}
                    onChange={(e) => setCustom({ ...custom, id: e.target.value })}
                    placeholder="my-provider"
                  />
                  <small>{t('小写字母、数字和短横线；保存后保持不变。')}</small>
                </label>
              </div>
              <label className="field">
                <span>{t('API 地址')}</span>
                <input
                  aria-label={t('API 地址')}
                  required
                  type="url"
                  maxLength={1000}
                  value={custom.baseURL}
                  disabled={disabled}
                  onChange={(e) => setCustom({ ...custom, baseURL: e.target.value })}
                  placeholder="https://api.example.com/v1"
                />
                <small>{t('填写包含 /v1 等前缀的完整基础地址，支持本机 HTTP 服务。')}</small>
              </label>
              <label className="field">
                <span>{t('接口协议')}</span>
                <select
                  aria-label={t('接口协议')}
                  disabled={disabled}
                  value={custom.protocol}
                  onChange={(e) =>
                    setCustom({ ...custom, protocol: e.target.value as CustomProvider['protocol'] })
                  }
                >
                  <option value="chat">OpenAI Chat Completions</option>
                  <option value="responses">OpenAI Responses</option>
                </select>
              </label>
              <label className="field">
                <span>{t('模型 ID（每行一个）')}</span>
                <textarea
                  aria-label={t('模型 ID（每行一个）')}
                  required
                  rows={3}
                  value={modelLines}
                  maxLength={13000}
                  disabled={disabled}
                  onChange={(e) => setModelLines(e.target.value)}
                  placeholder="model-id"
                />
                <small>{t('按服务商要求填写精确 ID；可用“ID | 显示名称”设置名称。')}</small>
              </label>
              <label className="checkbox settings-confirm">
                <input
                  type="checkbox"
                  checked={custom.keyless}
                  disabled={disabled}
                  onChange={(e) => {
                    setCustom({ ...custom, keyless: e.target.checked });
                    setKey('');
                  }}
                />
                <span>{t('此服务不需要 API Key')}</span>
              </label>
              {!custom.keyless && (
                <label className="field">
                  <span>API Key</span>
                  <input
                    aria-label="API Key"
                    type="password"
                    required={!editing || !!provider?.custom?.keyless}
                    autoComplete="new-password"
                    value={key}
                    maxLength={4096}
                    disabled={disabled}
                    onChange={(e) => setKey(e.target.value)}
                  />
                  <small>
                    {editing
                      ? t('留空保留已有 Key；保存后输入框清空。')
                      : t('Key 只交给本机官方引擎保存，不会在页面回显。')}
                  </small>
                </label>
              )}
              <details>
                <summary>{t('上下文容量（可选）')}</summary>
                <div className="provider-form-grid">
                  <label className="field">
                    <span>{t('上下文 Token 上限')}</span>
                    <input
                      aria-label={t('上下文 Token 上限')}
                      type="number"
                      required
                      min={2048}
                      max={2000000}
                      value={custom.context}
                      disabled={disabled}
                      onChange={(e) => setCustom({ ...custom, context: Number(e.target.value) })}
                    />
                  </label>
                  <label className="field">
                    <span>{t('输出 Token 上限')}</span>
                    <input
                      aria-label={t('输出 Token 上限')}
                      type="number"
                      required
                      min={256}
                      max={200000}
                      value={custom.output}
                      disabled={disabled}
                      onChange={(e) => setCustom({ ...custom, output: Number(e.target.value) })}
                    />
                  </label>
                </div>
                <small>{t('默认使用保守容量；较小的本地模型请按实际容量调整。')}</small>
              </details>
              <label className="checkbox settings-confirm">
                <input
                  type="checkbox"
                  checked={shared}
                  disabled={disabled}
                  onChange={(e) => setShared(e.target.checked)}
                />
                <span>{t('我确认工作区任务会向此服务发送内容并使用该账号额度。')}</span>
              </label>
              <div className="settings-actions">
                <button className="button primary" disabled={disabled || !shared}>
                  {t('保存 Provider')}
                </button>
                <button type="button" className="button" onClick={() => setCustom(null)}>
                  {t('取消')}
                </button>
              </div>
            </form>
          ) : (
            <div className="provider-form">
              <div className="provider-form-grid">
                <label className="field">
                  <span>{t('查找厂商')}</span>
                  <input
                    aria-label={t('查找厂商')}
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder={t('名称或 Provider ID')}
                  />
                </label>
                <label className="field">
                  <span>{t('厂商')}</span>
                  <select
                    aria-label={t('厂商')}
                    value={selected}
                    onChange={(e) => select(e.target.value)}
                    disabled={busy}
                  >
                    {!choices.some((p) => p.id === selected) && (
                      <option value={selected}>{provider?.name || t('请选择厂商')}</option>
                    )}
                    {choices.map((p) => (
                      <option value={p.id} key={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {provider && (
                <>
                  <div className="provider-meta">
                    <strong>{provider.name}</strong>
                    <span>{provider.connected ? t('已接入') : t('未配置')}</span>
                    <small>{t('模型数量：{{count}}', { count: provider.modelCount })}</small>
                  </div>
                  {provider.custom && (
                    <button
                      className="button"
                      disabled={disabled}
                      onClick={() => edit(provider.custom)}
                    >
                {t('编辑自定义 Provider')}
                    </button>
                  )}
                  {!!provider.oauth.length && (
                    <div className="provider-oauth-method">
                      <label className="field">
                        <span>{t('厂商 OAuth 登录')}</span>
                        <select
                          aria-label={t('厂商 OAuth 登录')}
                          value={oauthMethod?.index ?? 0}
                          disabled={disabled}
                          onChange={(e) => {
                            setMethod(Number(e.target.value));
                            setInputs({});
                          }}
                        >
                          {provider.oauth.map((m) => (
                            <option key={m.index} value={m.index}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      {oauthMethod?.prompts
                        .filter((p) => promptVisible(p, authorizationInputs))
                        .map((p) => (
                          <label className="field" key={p.key}>
                            <span>{p.message}</span>
                            {p.type === 'select' ? (
                              <select
                                aria-label={p.message}
                                disabled={disabled}
                                value={authorizationInputs[p.key] || ''}
                                onChange={(e) =>
                                  setInputs({ ...authorizationInputs, [p.key]: e.target.value })
                                }
                              >
                                {p.options?.map((o) => (
                                  <option key={o.value} value={o.value}>
                                    {o.label}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <input
                                aria-label={p.message}
                                disabled={disabled}
                                maxLength={1000}
                                placeholder={p.placeholder}
                                value={inputs[p.key] || ''}
                                onChange={(e) =>
                                  setInputs({ ...authorizationInputs, [p.key]: e.target.value })
                                }
                              />
                            )}
                          </label>
                        ))}
                      <button
                        className="button primary"
                        disabled={disabled || !shared}
                        onClick={() =>
                          void act(
                            'oauth/start',
                            {
                              providerID: selected,
                              method: oauthMethod!.index,
                              inputs: authorizationInputs,
                              shared: true,
                            },
                            'oauth',
                          )
                        }
                      >
                        <ExternalLink size={16} />
                        {t('开始厂商登录')}
                      </button>
                    </div>
                  )}
                  {provider.apiKey && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void act('provider/key', {
                          providerID: selected,
                          key: key.trim(),
                          shared: true,
                        });
                      }}
                    >
                      <label className="field">
                        <span>{provider.connected ? t('替换 API Key') : 'API Key'}</span>
                        <input
                          aria-label="API Key"
                          type="password"
                          autoComplete="new-password"
                          maxLength={4096}
                          required
                          value={key}
                          onChange={(e) => setKey(e.target.value)}
                          disabled={disabled}
                        />
                        <small>{t('Key 只交给本机官方引擎保存，不会在页面回显。')}</small>
                      </label>
                      <button className="button" disabled={disabled || !key.trim() || !shared}>
                        <KeyRound size={15} />
                        {t('保存凭据')}
                      </button>
                    </form>
                  )}
                  {(provider.apiKey || !!provider.oauth.length) && (
                    <label className="checkbox settings-confirm">
                      <input
                        type="checkbox"
                        checked={shared}
                        onChange={(e) => setShared(e.target.checked)}
                        disabled={disabled}
                      />
                      <span>
                        {t('我确认工作区任务会使用这个账号的额度，连接测试也可能产生费用。')}
                      </span>
                    </label>
                  )}
                </>
              )}
            </div>
          )}
          {provider && (!custom || editing) && (provider.connected || provider.custom) && (
            <div className="settings-actions provider-remove">
              {remove ? (
                <>
                  <span className="danger-copy">{t('确认移除此 Provider 的连接？')}</span>
                  <button
                    className="button danger"
                    disabled={disabled}
                    onClick={() => {
                      setRemove(false);
                      void act('provider/remove', { providerID: selected, confirmed: true });
                    }}
                  >
                    {t('确认移除')}
                  </button>
                  <button className="button" onClick={() => setRemove(false)}>
                    {t('取消')}
                  </button>
                </>
              ) : (
                <button
                  className="button danger"
                  disabled={disabled}
                  onClick={() => setRemove(true)}
                >
                  <Trash2 size={15} />
                  {t('移除连接')}
                </button>
              )}
            </div>
          )}
        </>
      )}
      <footer>{t('保存或登录不会自动测试模型；实际可用模型和额度由厂商账号决定。')}</footer>
    </section>
  );
}
