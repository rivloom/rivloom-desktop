import { t, systemText, language } from '../shared/i18n.ts';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  AlertTriangle,
  Check,
  CircleCheck,
  KeyRound,
  LoaderCircle,
  PlugZap,
  RefreshCw,
  ShieldCheck,
  Square,
  Trash2,
} from 'lucide-react';
import { api } from './api';
import type { ModelCheck, ModelSettings } from '../shared/types';

const formatTime = (value: string | null) =>
  value
    ? new Date(value).toLocaleString(language(), {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : t('尚无记录');

const stateText: Record<ModelSettings['credentialState'], string> = {
  get unconfigured() {
    return t('未配置');
  },
  get configured_unverified() {
    return t('已配置，待验证');
  },
  get verified() {
    return t('本次凭据已验证');
  },
  get needs_review() {
    return t('状态需要核对');
  },
};
const checkText: Record<ModelCheck['status'], string> = {
  get testing() {
    return t('正在测试');
  },
  get passed() {
    return t('连接通过');
  },
  get failed() {
    return t('连接失败');
  },
  get interrupted() {
    return t('测试中断');
  },
};
export function ModelSettingsView({
  owner,
  engineReady,
  onChanged,
  executionSettings,
}: {
  owner: boolean;
  engineReady: boolean;
  onChanged: () => void;
  executionSettings?: ReactNode;
}) {
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [key, setKey] = useState('');
  const [shared, setShared] = useState(false);
  const [testConfirmed, setTestConfirmed] = useState(false);
  const [testModel, setTestModel] = useState('');
  const [selectedDefault, setSelectedDefault] = useState('');
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const applySettings = (next: ModelSettings) => {
    setSettings(next);
    setSelectedDefault((current) =>
      current && next.models.some((model) => model.id === current) ? current : next.defaultModel,
    );
    const deepseek = next.models.filter((model) => model.id.startsWith('deepseek/'));
    setTestModel((current) =>
      current && deepseek.some((model) => model.id === current) ? current : deepseek[0]?.id || '',
    );
  };

  const load = async () => {
    try {
      const next = await api<ModelSettings>('/model-settings');
      applySettings(next);
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  useEffect(() => {
    void load();
  }, []);
  const testing = settings
    ? Object.values(settings.checks).some((check) => check.status === 'testing')
    : false;
  useEffect(() => {
    if (!testing) return;
    const timer = setInterval(() => void load(), 1000);
    return () => clearInterval(timer);
  }, [testing]);

  const deepseekModels = useMemo(
    () => settings?.models.filter((model) => model.id.startsWith('deepseek/')) || [],
    [settings],
  );
  const latestCheck = testModel ? settings?.checks[testModel] : undefined;
  const actionsLocked = !owner || !engineReady || !!settings?.busy || busy;

  async function mutate(path: string, body: unknown, clearKey = false) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await api<ModelSettings>(path, body);
      applySettings(next);
      onChanged();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      if (clearKey) {
        setKey('');
        setShared(false);
      }
      setBusy(false);
    }
  }

  function saveCredential(event: FormEvent) {
    event.preventDefault();
    if (!key || !shared) return;
    void mutate('/model-settings/deepseek', { key, shared: true }, true);
  }

  if (!settings) {
    return (
      <div className="settings-loading">
        <LoaderCircle className="spin" size={21} />
        {t('正在读取 OpenCode 模型配置…')}
      </div>
    );
  }

  return (
    <>
      <div className="page-heading settings-heading">
        <div>
          <span className="eyebrow">MODEL ACCESS, OWNED BY THE WORKSPACE</span>
          <h1>
            {executionSettings ? t('模型与执行') : t('模型与额度')}
            <span className="heading-dot">.</span>
          </h1>
          <p>{t('凭据交给本机 OpenCode 管理；任务只记录所选模型和操作结果。')}</p>
        </div>
        <button className="button" disabled={busy} onClick={() => void load()}>
          <RefreshCw size={16} />
          {t('刷新状态')}
        </button>
      </div>

      {error && (
        <div className="error global-error" role="alert">
          <AlertTriangle size={18} />
          <span>{systemText(error)}</span>
          <button className="icon-button" aria-label={t('关闭错误')} onClick={() => setError('')}>
            ×
          </button>
        </div>
      )}
      {!owner && (
        <div className="notice">
          <ShieldCheck size={17} />
          {t(
            '你可以查看工作区当前使用的模型。只有工作区创建者可以修改凭据、测试连接和设置默认模型。',
          )}
        </div>
      )}
      {settings.busyReason && (
        <div className="notice">
          <AlertTriangle size={17} />
          {t('模型凭据和连接测试暂时锁定：')}
          {systemText(settings.busyReason)}
          {t('。默认模型仍可修改，只影响之后创建的任务。')}
        </div>
      )}

      <div className="settings-grid">
        <section className="settings-card credential-card">
          <header>
            <span className="settings-icon">
              <KeyRound size={21} />
            </span>
            <div>
              <span className="eyebrow">PROVIDER CREDENTIAL</span>
              <h2>{t('DeepSeek 官方 API')}</h2>
            </div>
            <span className={`credential-state state-${settings.credentialState}`}>
              {settings.credentialState === 'verified' && <CircleCheck size={14} />}
              {stateText[settings.credentialState]}
            </span>
          </header>
          <p className="settings-copy">
            {t(
              '在这台执行主机上配置一次，工作区任务即可选择 DeepSeek 模型。Rivloom 不会把完整 Key 写入业务数据库、活动记录或界面响应。',
            )}
          </p>
          <form onSubmit={saveCredential}>
            <label className="field">
              <span>{settings.deepseekConfigured ? t('替换 API Key') : 'DeepSeek API Key'}</span>
              <input
                type="password"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                minLength={20}
                maxLength={512}
                autoComplete="new-password"
                spellCheck={false}
                placeholder={t('粘贴 DeepSeek 官方控制台创建的 Key')}
                disabled={!owner}
              />
              <small>{t('保存后输入框立即清空；客户端不会再次显示已有 Key。')}</small>
            </label>
            <label className="checkbox settings-confirm">
              <input
                type="checkbox"
                checked={shared}
                onChange={(event) => setShared(event.target.checked)}
                disabled={!owner}
              />
              <span>{t('我确认工作区任务会使用这个账号的额度，连接测试也可能产生费用。')}</span>
            </label>
            <div className="settings-actions">
              <button
                type="submit"
                className="button primary"
                disabled={actionsLocked || key.trim().length < 20 || !shared}
              >
                {busy ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}
                {settings.deepseekConfigured ? t('替换凭据') : t('保存凭据')}
              </button>
              {settings.deepseekConfigured &&
                (removeConfirm ? (
                  <>
                    <span className="danger-copy">
                      {t('确认移除？新任务将不能选择 DeepSeek。')}
                    </span>
                    <button
                      type="button"
                      className="button danger"
                      disabled={actionsLocked}
                      onClick={() => {
                        setRemoveConfirm(false);
                        void mutate('/model-settings/deepseek/remove', { confirmed: true });
                      }}
                    >
                      {t('确认移除')}
                    </button>
                    <button
                      type="button"
                      className="button"
                      onClick={() => setRemoveConfirm(false)}
                    >
                      {t('取消')}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="button danger"
                    disabled={actionsLocked}
                    onClick={() => setRemoveConfirm(true)}
                  >
                    <Trash2 size={15} />
                    {t('移除')}
                  </button>
                ))}
            </div>
          </form>
          <footer>
            {t('最近保存：')}
            {formatTime(settings.credentialUpdatedAt)}
            <span>{t('凭据由 OpenCode 官方认证接口写入本机配置。')}</span>
          </footer>
        </section>

        <section className="settings-card">
          <header>
            <span className="settings-icon">
              <PlugZap size={21} />
            </span>
            <div>
              <span className="eyebrow">REAL CONNECTION CHECK</span>
              <h2>{t('连接测试')}</h2>
            </div>
          </header>
          <p className="settings-copy">
            {t(
              '通过 OpenCode 发起一次真实、无工具权限的最小模型请求。不会自动重试；10 分钟内最多测试 3 次。',
            )}
          </p>
          <label className="field">
            <span>{t('要测试的 DeepSeek 模型')}</span>
            <select
              value={testModel}
              onChange={(event) => {
                setTestModel(event.target.value);
                setTestConfirmed(false);
              }}
              disabled={!owner || testing || !deepseekModels.length}
            >
              {deepseekModels.length ? (
                deepseekModels.map((model) => (
                  <option value={model.id} key={model.id}>
                    {model.name}
                  </option>
                ))
              ) : (
                <option value="">{t('先保存 DeepSeek 凭据')}</option>
              )}
            </select>
          </label>
          {latestCheck && (
            <div className={`check-result check-${latestCheck.status}`}>
              {latestCheck.status === 'testing' ? (
                <LoaderCircle className="spin" size={18} />
              ) : latestCheck.status === 'passed' ? (
                <Check size={18} />
              ) : (
                <AlertTriangle size={18} />
              )}
              <div>
                <strong>{checkText[latestCheck.status]}</strong>
                <p>{systemText(latestCheck.message)}</p>
                <small>{formatTime(latestCheck.at)}</small>
              </div>
            </div>
          )}
          {!testing && (
            <label className="checkbox settings-confirm">
              <input
                type="checkbox"
                checked={testConfirmed}
                onChange={(event) => setTestConfirmed(event.target.checked)}
                disabled={!owner || !testModel}
              />
              <span>{t('我确认这会发送一次真实请求，可能消耗额度；失败后由我决定是否重试。')}</span>
            </label>
          )}
          <div className="settings-actions">
            {testing ? (
              <button
                className="button danger"
                disabled={!owner || busy}
                onClick={() => void mutate('/model-settings/test/stop', {})}
              >
                <Square size={15} />
                {t('停止测试')}
              </button>
            ) : (
              <button
                className="button primary"
                disabled={actionsLocked || !testModel || !testConfirmed}
                onClick={() => {
                  setTestConfirmed(false);
                  void mutate('/model-settings/test', { model: testModel, confirmed: true });
                }}
              >
                <PlugZap size={16} />
                {t('开始真实测试')}
              </button>
            )}
          </div>
        </section>

        <section className="settings-card default-card">
          <header>
            <span className="settings-icon">
              <ShieldCheck size={21} />
            </span>
            <div>
              <span className="eyebrow">NEW TASK DEFAULT</span>
              <h2>{t('默认执行模型')}</h2>
            </div>
          </header>
          <p className="settings-copy">
            {t('只影响之后创建任务时的默认选择。每个任务仍会锁定自己的模型，不会随这里变化。')}
          </p>
          <label className="field">
            <span>{t('默认模型')}</span>
            <select
              value={selectedDefault}
              onChange={(event) => setSelectedDefault(event.target.value)}
              disabled={!owner || !settings.models.length}
            >
              {settings.models.map((model) => (
                <option value={model.id} key={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
          </label>
          <div className="settings-actions">
            <button
              className="button primary"
              disabled={
                !owner || busy || !selectedDefault || selectedDefault === settings.defaultModel
              }
              onClick={() => void mutate('/model-settings/default', { model: selectedDefault })}
            >
              <Check size={16} />
              {t('保存默认模型')}
            </button>
          </div>
          <footer>
            {t('当前默认：')}
            <span className="mono">{settings.defaultModel || t('暂无可用模型')}</span>
          </footer>
        </section>
      </div>

      {executionSettings}
    </>
  );
}
