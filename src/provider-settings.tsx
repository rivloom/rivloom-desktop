import { useEffect, useId, useMemo, useState } from 'react';
import {
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  LogIn,
  Plus,
  Search,
  Server,
  Trash2,
} from 'lucide-react';
import { t, systemText, language } from '../shared/i18n.ts';
import {
  promptVisible,
  type CustomProvider,
  type OAuthStatus,
  type ProviderAccess,
} from '../shared/model-providers.ts';
import { api } from './api.ts';
import {
  PROVIDER_PLATFORMS,
  nativePlatformProvider,
  platformCustomDraft,
  providerApiRank,
  providerSearchText,
} from './provider-platforms.ts';
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
type ConnectionMode = 'oauth' | 'api' | 'custom';
const connectionModes: ConnectionMode[] = ['oauth', 'api', 'custom'];

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
  const [selected, setSelected] = useState('');
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('oauth');
  const [loading, setLoading] = useState(true);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const modeID = useId();
  const [filter, setFilter] = useState('');
  const [key, setKey] = useState('');
  const [accountID, setAccountID] = useState('');
  const [accountName, setAccountName] = useState('');
  const [custom, setCustom] = useState<CustomProvider | null>(null);
  const [customPlatformID, setCustomPlatformID] = useState<string | null>(null);
  const [copyingDocsURL, setCopyingDocsURL] = useState('');
  const [copiedDocsURL, setCopiedDocsURL] = useState('');
  const [failedDocsURL, setFailedDocsURL] = useState('');
  const [modelLines, setModelLines] = useState('');
  const [editing, setEditing] = useState(false);
  const [method, setMethod] = useState(0);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [oauth, setOAuth] = useState<OAuthStatus | null>(null);
  const [code, setCode] = useState('');
  const [remove, setRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const locale = language();
  const choices = useMemo(
    () =>
      providers
        .filter(
          (p) =>
            !p.custom &&
            !p.account &&
            (connectionMode === 'oauth'
              ? p.oauth.length > 0
              : connectionMode === 'api' && p.apiKey) &&
            `${providerSearchText(p)} ${connectionMode === 'oauth' ? p.oauth.map((method) => method.label).join(' ') : ''}`
              .toLowerCase()
              .includes(filter.trim().toLowerCase()),
        )
        .sort((a, b) => {
          const preferred = ['openai', 'github-copilot'];
          const rank = (id: string) =>
            connectionMode === 'api'
              ? providerApiRank(id)
              : preferred.includes(id)
                ? preferred.indexOf(id)
                : preferred.length;
          return (
            rank(a.id) - rank(b.id) ||
            a.name.localeCompare(b.name, locale) ||
            a.id.localeCompare(b.id)
          );
        }),
    [providers, connectionMode, filter, locale],
  );
  const provider =
    connectionMode === 'custom'
      ? providers.find((p) => p.id === selected)
      : choices.find((p) => p.id === selected);
  const oauthMethod = provider?.oauth.find((m) => m.index === method) || provider?.oauth[0];
  const active = oauthActive(oauth);
  const accounts = providers.filter(
    (p) => p.account?.providerID === selected || (p.id === selected && p.connected && !p.custom),
  );
  const account = accounts.find((p) => p.id === accountID);
  const accountTarget = { ...(accountID ? { id: accountID } : {}), name: accountName.trim() };
  const connection = custom ? provider : account;
  const disabled = !owner || !engineReady || locked || busy || active;
  const platformDisabled = disabled || loading || !catalogLoaded;
  const selectedPlatform = PROVIDER_PLATFORMS.find((platform) =>
    custom
      ? platform.id === customPlatformID
      : connectionMode === 'api' && nativePlatformProvider(providers, platform.id)?.id === selected,
  );
  const catalog = async () => {
    setLoading(true);
    try {
      const next = await api<ProviderAccess[]>('/model-settings/providers');
      setProviders(next);
      setCatalogLoaded(true);
      setError('');
      return next;
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (connectionMode !== 'custom' && !active && !choices.some((p) => p.id === selected))
      select(choices[0]?.id || '');
  }, [choices, connectionMode, active, selected]);
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
          if (next?.status === 'connected') setAccountID(next.accountID || next.providerID);
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
    const entry = providers.find((p) => p.id === id);
    const source = entry?.account?.providerID || id;
    setSelected(source);
    setAccountID(entry?.account || entry?.connected ? id : '');
    setAccountName(
      entry?.account?.name ||
        entry?.accountName ||
        (entry?.connected
          ? t('默认账号')
          : t('账号 {{number}}', {
              number: providers.filter((p) => p.account?.providerID === source).length + 1,
            })),
    );
    setKey('');
    setRemove(false);
    setInputs({});
    setMethod(0);
    setError('');
    setCustom(null);
    setCustomPlatformID(null);
    setEditing(false);
  }
  function chooseAccount(entry?: ProviderAccess) {
    setAccountID(entry?.id || '');
    setAccountName(
      entry?.account?.name ||
        entry?.accountName ||
        (entry ? t('默认账号') : t('账号 {{number}}', { number: accounts.length + 1 })),
    );
    setKey('');
    setError('');
    setRemove(false);
    setInputs({});
  }
  function edit(value?: CustomProvider) {
    setConnectionMode('custom');
    setCustomPlatformID(null);
    setCustom(value ? structuredClone(value) : emptyCustom());
    setEditing(!!value);
    setModelLines(
      value?.models.map((m) => (m.name === m.id ? m.id : `${m.id} | ${m.name}`)).join('\n') || '',
    );
    setKey('');
    setError('');
    setRemove(false);
  }
  function choosePlatform(platformID: string) {
    if (platformDisabled || selectedPlatform?.id === platformID) return;
    setFilter('');
    setOAuth(null);
    setCode('');
    const native = nativePlatformProvider(providers, platformID);
    if (native) {
      select(native.id);
      setConnectionMode('api');
      return;
    }
    select('');
    edit();
    if (platformID !== 'custom') {
      const draft = platformCustomDraft(platformID, providers);
      if (platformID === 'siliconflow-cn') draft.name = t('硅基流动（中国区）');
      setCustom(draft);
      setCustomPlatformID(platformID);
    }
  }
  async function copyPlatformDocs(url: string) {
    if (copyingDocsURL) return;
    setCopyingDocsURL(url);
    setCopiedDocsURL('');
    setFailedDocsURL('');
    try {
      await navigator.clipboard.writeText(url);
      setCopiedDocsURL(url);
    } catch {
      setFailedDocsURL(url);
    } finally {
      setCopyingDocsURL('');
    }
  }
  function chooseMode(mode: ConnectionMode) {
    if (mode === connectionMode) return;
    setFilter('');
    select('');
    if (mode === 'custom') edit();
    else setConnectionMode(mode);
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
        if (result.accountID || result.status === 'connected')
          setAccountID(result.accountID || result.providerID);
        setCode('');
        if (!oauthActive(result)) await catalog();
      }
      if (kind === 'settings') {
        const refreshed = await catalog();
        if (path === 'provider/key') {
          const input = body as { providerID: string; account?: { id?: string; name: string } };
          if (input.account)
            setAccountID(
              input.account.id ||
                refreshed.find(
                  (p) =>
                    p.account?.providerID === input.providerID &&
                    p.account.name === input.account!.name,
                )?.id ||
                '',
            );
        }
        if (path === 'provider/custom') {
          setSelected((body as { provider: CustomProvider }).provider.id);
          setFilter('');
          setEditing(true);
        } else if (path === 'provider/remove') {
          setCustom(null);
          setSelected('');
          setConnectionMode('oauth');
        }
      }
      if (kind !== 'open') onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setKey('');
    }
  }
  const connected = providers.filter((p) => p.connected || p.custom || p.account);
  const authorizationInputs = {
    ...Object.fromEntries(
      (oauthMethod?.prompts || [])
        .filter((p) => p.type === 'select')
        .map((p) => [p.key, p.options?.[0]?.value || '']),
    ),
    ...inputs,
  };
  const platformHelp = selectedPlatform && (
    <aside className="provider-platform-help" data-platform-help={selectedPlatform.id}>
      {custom && (
        <p>{t('当前引擎目录未提供此平台，已打开兼容配置。请填写平台提供的模型 ID 后保存。')}</p>
      )}
      <p>{t('使用平台 API Key 连接后，可选择该账号可用的模型；实际可用性和额度由平台决定。')}</p>
      <strong>
        {t('{{platform}} 官方文档', {
          platform:
            selectedPlatform.id === 'siliconflow-cn'
              ? t('硅基流动（中国区）')
              : selectedPlatform.name,
        })}
      </strong>
      <div className="provider-platform-docs">
        <input
          aria-label={t('接入文档链接')}
          value={selectedPlatform.docsURL}
          readOnly
          onFocus={(event) => event.target.select()}
        />
        <button
          className="button"
          type="button"
          data-platform-docs-copy={selectedPlatform.id}
          disabled={!!copyingDocsURL}
          onClick={() => void copyPlatformDocs(selectedPlatform.docsURL)}
        >
          <Copy size={13} aria-hidden="true" />
          {t('复制接入文档链接')}
        </button>
      </div>
      {copiedDocsURL === selectedPlatform.docsURL && (
        <small role="status">{t('已复制到剪贴板')}</small>
      )}
      {failedDocsURL === selectedPlatform.docsURL && (
        <small role="status">{t('复制失败，请选中文字后按 Ctrl+C。')}</small>
      )}
    </aside>
  );
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
      </header>
      <p className="settings-copy">{t('选择接入方式，连接后即可在会话中选择模型。')}</p>
      <div className="provider-platforms" role="group" aria-label={t('常用平台')}>
        <span className="provider-platforms-label">{t('常用平台')}</span>
        <div className="provider-platform-buttons">
          {PROVIDER_PLATFORMS.map((platform) => (
            <button
              key={platform.id}
              type="button"
              data-platform-id={platform.id}
              aria-pressed={selectedPlatform?.id === platform.id}
              disabled={platformDisabled}
              onClick={() => choosePlatform(platform.id)}
            >
              {platform.id === 'siliconflow-cn' ? t('硅基流动（中国区）') : platform.name}
            </button>
          ))}
          <button
            type="button"
            data-platform-id="custom"
            disabled={platformDisabled}
            onClick={() => choosePlatform('custom')}
          >
            <Plus size={13} aria-hidden="true" />
            {t('OpenAI 兼容服务')}
          </button>
        </div>
      </div>
      {error && (
        <div className="error" role="alert">
          {systemText(error)}
          <button
            type="button"
            className="button"
            disabled={!engineReady || busy}
            onClick={() => void catalog().catch((e) => setError(e.message))}
          >
            {t('重新加载厂商')}
          </button>
        </div>
      )}
      {!!connected.length && (
        <div className="provider-connected" aria-label={t('已接入的 Provider')}>
          {connected.map((p) => (
            <button
              key={p.id}
              className={`provider-chip ${(custom ? selected : accountID) === p.id ? 'selected' : ''}`}
              onClick={() => {
                select(p.id);
                if (p.custom) edit(p.custom);
                else {
                  setFilter('');
                  setConnectionMode(p.oauth.length ? 'oauth' : 'api');
                }
              }}
              disabled={active || busy}
            >
              {p.connected && <Check size={13} />}
              <span>
                {p.name}
                {!p.custom && ` · ${p.account?.name || p.accountName || t('默认账号')}`}
              </span>
              <small>{p.modelCount}</small>
            </button>
          ))}
        </div>
      )}
      <div className="provider-modes" role="tablist" aria-label={t('接入方式')}>
        {connectionModes.map((mode) => (
          <button
            key={mode}
            type="button"
            role="tab"
            id={`${modeID}-${mode}`}
            aria-selected={connectionMode === mode}
            aria-controls={`${modeID}-panel`}
            tabIndex={connectionMode === mode ? 0 : -1}
            disabled={active || busy}
            onClick={() => chooseMode(mode)}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const index = connectionModes.indexOf(mode);
              const next =
                event.key === 'Home'
                  ? 'oauth'
                  : event.key === 'End'
                    ? 'custom'
                    : connectionModes[(index + (event.key === 'ArrowRight' ? 1 : -1) + 3) % 3];
              chooseMode(next);
              document.getElementById(`${modeID}-${next}`)?.focus();
            }}
          >
            {mode === 'oauth' ? (
              <LogIn size={19} />
            ) : mode === 'api' ? (
              <KeyRound size={19} />
            ) : (
              <Server size={19} />
            )}
            <span>
              <strong>
                {mode === 'oauth' ? t('账号登录') : mode === 'api' ? 'API Key' : t('自定义服务')}
              </strong>
              <small>
                {mode === 'oauth'
                  ? t('使用已有厂商账号')
                  : mode === 'api'
                    ? t('粘贴厂商提供的密钥')
                    : t('兼容接口或本机模型')}
              </small>
            </span>
          </button>
        ))}
      </div>
      <div id={`${modeID}-panel`} role="tabpanel" aria-labelledby={`${modeID}-${connectionMode}`}>
        {active && oauth ? (
          <div className="provider-oauth" aria-live="polite">
            <h3>
              {t('正在连接 {{provider}}', {
                provider:
                  providers.find((p) => p.id === oauth.providerID)?.name || oauth.providerID,
              })}
            </h3>
            {oauth.status === 'starting' ? (
              <p>
                <LoaderCircle size={16} className="spin" /> {t('正在准备厂商登录…')}
              </p>
            ) : (
              <>
                <p>{t('在系统浏览器中完成授权，然后回到这里确认连接。')}</p>
                {oauth.instructions && (
                  <pre className="oauth-instructions">{oauth.instructions}</pre>
                )}
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
                <div className="provider-form-heading">
                  <h3>{editing ? t('编辑自定义 Provider') : t('添加自定义 Provider')}</h3>
                  {editing && (
                    <button
                      type="button"
                      className="button"
                      disabled={disabled}
                      onClick={() => {
                        select('');
                        edit();
                      }}
                    >
                      <Plus size={15} />
                      {t('添加另一个服务')}
                    </button>
                  )}
                </div>
                {platformHelp}
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
                      setCustom({
                        ...custom,
                        protocol: e.target.value as CustomProvider['protocol'],
                      })
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
                <div className="settings-actions">
                  <button className="button primary" disabled={disabled}>
                    {t('保存 Provider')}
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() => chooseMode('oauth')}
                  >
                    {t('取消')}
                  </button>
                </div>
              </form>
            ) : (
              <div className="provider-form">
                <p className="provider-mode-help">
                  {connectionMode === 'oauth'
                    ? t('选择下方厂商，在浏览器中登录并授权，无需填写 API Key。')
                    : t('选择密钥所属的厂商，再粘贴 API Key。')}
                </p>
                <label className="provider-search">
                  <Search size={16} aria-hidden="true" />
                  <input
                    aria-label={t('查找厂商')}
                    value={filter}
                    disabled={busy}
                    onChange={(e) => {
                      setFilter(e.target.value);
                      select('');
                    }}
                    placeholder={t('名称或 Provider ID')}
                  />
                </label>
                {!engineReady ? (
                  <p className="provider-empty" role="status">
                    {t('引擎就绪后将加载可接入的厂商。')}
                  </p>
                ) : loading && !providers.length ? (
                  <p className="provider-empty" role="status">
                    <LoaderCircle size={16} className="spin" />
                    {t('正在加载厂商…')}
                  </p>
                ) : !choices.length ? (
                  <p className="provider-empty" role="status">
                    {filter.trim()
                      ? t('没有匹配的厂商，请尝试其他名称。')
                      : connectionMode === 'oauth'
                        ? t('当前引擎未提供账号登录入口，可使用 API Key 或自定义服务。')
                        : t('当前没有可用的 API Key 厂商，可添加自定义服务。')}
                  </p>
                ) : (
                  <div className="provider-choices" aria-label={t('选择厂商')}>
                    {choices.map((p) => (
                      <button
                        type="button"
                        key={p.id}
                        className={`provider-choice${selected === p.id ? ' selected' : ''}`}
                        aria-pressed={selected === p.id}
                        disabled={busy}
                        onClick={() => select(p.id)}
                        title={p.id}
                      >
                        <span>
                          <strong>{p.name}</strong>
                          {connectionMode === 'oauth' &&
                            p.id === 'openai' &&
                            p.oauth.some((m) => /chatgpt/i.test(m.label)) && <small>ChatGPT</small>}
                        </span>
                        {p.connected ? (
                          <small className="provider-choice-connected">
                            <Check size={12} />
                            {t('已接入')}
                          </small>
                        ) : (
                          selected === p.id && <Check size={15} />
                        )}
                      </button>
                    ))}
                  </div>
                )}
                {provider && (
                  <>
                    <div className="provider-meta">
                      <strong>{provider.name}</strong>
                      <span>{account?.connected ? t('已接入') : t('未配置')}</span>
                      <small>
                        {t('模型数量：{{count}}', {
                          count: account?.modelCount || provider.modelCount,
                        })}
                      </small>
                    </div>
                    {platformHelp}
                    <div className="provider-accounts">
                      <div className="provider-accounts-heading">
                        <strong>{t('此厂商的账号')}</strong>
                        <button
                          className="button"
                          disabled={disabled}
                          onClick={() => chooseAccount()}
                        >
                          <Plus size={14} />
                          {t('添加账号')}
                        </button>
                      </div>
                      {!!accounts.length && (
                        <div className="provider-account-choices" aria-label={t('选择账号')}>
                          {accounts.map((entry) => (
                            <button
                              key={entry.id}
                              type="button"
                              aria-pressed={accountID === entry.id}
                              disabled={disabled}
                              onClick={() => chooseAccount(entry)}
                            >
                              <span>
                                {entry.account?.name || entry.accountName || t('默认账号')}
                              </span>
                              {accountID === entry.id && <Check size={14} />}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="provider-account-name">
                        <label className="field">
                          <span>{accountID ? t('账号别名') : t('新账号别名')}</span>
                          <input
                            aria-label={t('账号别名')}
                            value={accountName}
                            maxLength={40}
                            disabled={disabled}
                            onChange={(e) => setAccountName(e.target.value)}
                            placeholder={t('例如：工作、个人、Go 套餐 B')}
                          />
                        </label>
                        {account && (
                          <button
                            className="button"
                            disabled={
                              disabled ||
                              !accountName.trim() ||
                              accountName.trim() ===
                                (account.account?.name || account.accountName || t('默认账号'))
                            }
                            onClick={() =>
                              void act('provider/rename', {
                                id: accountID,
                                name: accountName.trim(),
                              })
                            }
                          >
                            {t('保存别名')}
                          </button>
                        )}
                      </div>
                      <small>{t('每个账号独立保存凭据，可在模型菜单中按别名选择。')}</small>
                      {account?.accountError && (
                        <p className="error" role="alert">
                          {systemText(account.accountError)}
                        </p>
                      )}
                    </div>
                    {connectionMode === 'oauth' && !!provider.oauth.length && (
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
                          disabled={disabled || !accountName.trim()}
                          onClick={() =>
                            void act(
                              'oauth/start',
                              {
                                providerID: selected,
                                method: oauthMethod!.index,
                                inputs: authorizationInputs,
                                shared: true,
                                account: accountTarget,
                              },
                              'oauth',
                            )
                          }
                        >
                          <ExternalLink size={16} />
                          {t('登录 {{provider}}', { provider: provider.name })}
                        </button>
                      </div>
                    )}
                    {connectionMode === 'api' && provider.apiKey && (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void act('provider/key', {
                            providerID: selected,
                            key: key.trim(),
                            shared: true,
                            account: accountTarget,
                          });
                        }}
                      >
                        <label className="field">
                          <span>{account?.connected ? t('替换 API Key') : 'API Key'}</span>
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
                        <button
                          className="button"
                          disabled={disabled || !key.trim() || !accountName.trim()}
                        >
                          <KeyRound size={15} />
                          {t('保存凭据')}
                        </button>
                      </form>
                    )}
                  </>
                )}
              </div>
            )}
            {connection &&
              (!custom || editing) &&
              (connection.connected || connection.custom || connection.account) && (
                <div className="settings-actions provider-remove">
                  {remove ? (
                    <>
                      <span className="danger-copy">{t('确认移除此 Provider 的连接？')}</span>
                      <button
                        className="button danger"
                        disabled={disabled}
                        onClick={() => {
                          setRemove(false);
                          void act('provider/remove', {
                            providerID: connection.id,
                            confirmed: true,
                          });
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
      </div>
      <footer>{t('保存或登录不会自动测试模型；实际可用模型和额度由厂商账号决定。')}</footer>
    </section>
  );
}
