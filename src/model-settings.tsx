import { ProviderSettings } from './provider-settings.tsx';
import { t, systemText, language } from '../shared/i18n.ts';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Check,
  LoaderCircle,
  PlugZap,
  RefreshCw,
  ShieldCheck,
  Square,
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
  const [testConfirmed, setTestConfirmed] = useState(false);
  const [testModel, setTestModel] = useState('');
  const [selectedDefault, setSelectedDefault] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [providerRevision, setProviderRevision] = useState(0);

  const applySettings = (next: ModelSettings) => {
    setSettings(next);
    setSelectedDefault((current) =>
      current && next.models.some((model) => model.id === current) ? current : next.defaultModel,
    );
    const models = next.models;
    setTestModel((current) =>
      current && models.some((model) => model.id === current) ? current : models[0]?.id || '',
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

  const availableModels = useMemo(() => settings?.models || [], [settings]);
  const latestCheck = testModel ? settings?.checks[testModel] : undefined;
  const actionsLocked = !owner || !engineReady || !!settings?.busy || busy;

  async function mutate(path: string, body: unknown) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await api<ModelSettings>(path, body);
      if (next.models) applySettings(next);
      else await load();
      onChanged();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!settings && error)
    return (
      <div className="error" role="alert">
        {systemText(error)}
        <button className="button" onClick={() => void load()}>
          {t('刷新状态')}
        </button>
      </div>
    );
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
        <button
          className="button"
          disabled={busy}
          onClick={() => {
            void load();
            setProviderRevision((v) => v + 1);
          }}
        >
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

      <ProviderSettings
        owner={owner}
        engineReady={engineReady}
        revision={providerRevision}
        locked={!engineReady || !!settings.busy}
        onChanged={() => {
          void load();
          onChanged();
        }}
      />
      <div className="settings-grid">
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
            <span>{t('要测试的模型')}</span>
            <select
              aria-label={t('要测试的模型')}
              value={testModel}
              onChange={(event) => {
                setTestModel(event.target.value);
                setTestConfirmed(false);
              }}
              disabled={!owner || testing || !availableModels.length}
            >
              {availableModels.length ? (
                availableModels.map((model) => (
                  <option value={model.id} key={model.id}>
                    {model.name}
                  </option>
                ))
              ) : (
                <option value="">{t('先接入模型 Provider')}</option>
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
              aria-label={t('默认模型')}
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
