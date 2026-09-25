import { t, systemText } from '../shared/i18n.ts';
import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { i18n } from '../shared/i18n';
import { initializeLanguage } from './i18n';
import { LanguageSwitcher } from './language-switcher';
import { DesktopUpdateProvider } from './desktop-update';
import { useDesktopStartup } from './desktop-startup';
import { createRoot } from 'react-dom/client';
import { ArrowRight, Bot, CircleCheck, CircleDot, LoaderCircle, ShieldCheck } from 'lucide-react';
import { api, ApiError } from './api';
import { createRefreshQueue, reuseJson, type RefreshScope } from './desktop-refresh';
import { applyTaskStream, reconcileTaskStream, type TaskStreamUpdate } from '../shared/task-stream';
import { authenticateDesktop, desktop } from './desktop';
import { Wordmark, Button, Field } from './ui';
import { ConversationWorkspace } from './conversation-workspace';
import type { Bootstrap, NodeNetwork } from '../shared/types';
import './styles.css';
import './conversation-workspace.css';
import './workspace-settings.css';
import './chat-refinement.css';
function Auth({ onLogin }: { onLogin: () => void }) {
  const [setup, setSetup] = useState(false);
  const [join, setJoin] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ setupRequired: boolean }>('/auth/state')
      .then((s) => setSetup(s.setupRequired))
      .catch((e) => setError(e.message));
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const body = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await api(`/auth/${setup ? 'setup' : join ? 'join' : 'login'}`, body);
      onLogin();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-shell">
      <div className="auth-story">
        <div className="auth-brand">
          <Wordmark />
        </div>
        <div className="auth-copy">
          <span className="eyebrow">HUMAN INTENT. AI EXECUTION.</span>
          <h1>
            {t('一起，把想法')}
            <br />
            {t('变成')}
            <span>{t('交付。')}</span>
          </h1>
          <p>
            {t('把任务交给 AI，把关键决定留给人。')}
            <br />
            {t('任务自动完成，重要操作由你决定。')}
          </p>
          <div className="journey">
            <span>
              <CircleDot />
              {t('发起任务')}
            </span>
            <i />
            <span>
              <Bot />
              {t('协作执行')}
            </span>
            <i />
            <span>
              <CircleCheck />
              {t('确认交付')}
            </span>
          </div>
        </div>
        <p className="auth-foot">
          {t('{{value1}}OpenCode 驱动 · 可信团队内测', {
            value1: desktop ? 'WINDOWS DESKTOP · ' : t('内部 Web 调试 · '),
          })}
        </p>
      </div>
      <div className="auth-form">
        <LanguageSwitcher />
        <div className="auth-form-inner">
          <span className="eyebrow">YOUR SHARED WORKSPACE</span>
          <h2>{setup ? t('创建你的工作区') : join ? t('加入协作空间') : t('欢迎回到工作区')}</h2>
          <p>
            {setup
              ? t('只需初始化一次。之后可以邀请真正的协作伙伴。')
              : join
                ? t('用一次性邀请码创建属于你的独立账号。')
                : t('登录后继续你的会话。')}
          </p>
          <form onSubmit={submit}>
            {(setup || join) && (
              <Field
                label={setup ? t('本机初始化码') : t('邀请人提供的一次性邀请码')}
                hint={
                  setup
                    ? t('在 .data/setup-code.txt 中查看；不会公开注册。')
                    : t('邀请码 24 小时内有效。')
                }
              >
                <input name="code" required autoComplete="off" />
              </Field>
            )}
            {(setup || join) && (
              <Field label={t('显示名称')}>
                <input name="name" required maxLength={40} placeholder={t('大家怎么称呼你')} />
              </Field>
            )}
            <Field label={t('用户名')}>
              <input
                name="username"
                required
                pattern="[a-z0-9_-]{3,30}"
                autoComplete="username"
                placeholder={t('3–30 位小写字母、数字或下划线')}
              />
            </Field>
            <Field label={t('密码')} hint={t('至少 12 位，不要与其他账号共用。')}>
              <input
                name="password"
                type="password"
                minLength={12}
                maxLength={128}
                required
                autoComplete={setup || join ? 'new-password' : 'current-password'}
              />
            </Field>
            {error && (
              <p className="error" role="alert">
                {systemText(error)}
              </p>
            )}
            <Button type="submit" disabled={busy} variant="primary wide">
              {busy ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}{' '}
              {setup ? t('创建工作区') : join ? t('加入工作区') : t('进入工作区')}
            </Button>
          </form>
          {!setup && (
            <button
              className="text-button auth-switch"
              onClick={() => {
                setJoin(!join);
                setError('');
              }}
            >
              {join ? t('已有账号？返回登录') : t('收到邀请？创建独立账号')}
            </button>
          )}
          <div className="security-note">
            <ShieldCheck size={18} />
            <span>{t('仅限可信参与者和专用测试环境。工作目录限制并非安全沙箱。')}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function App() {
  useTranslation();
  const [data, setData] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  useDesktopStartup(!!data?.user.id && data.engine.ready && connected && !loading && !error);
  const refreshQueue = useRef<ReturnType<typeof createRefreshQueue> | null>(null);
  const applyBootstrap = (next: Bootstrap) =>
    setData((previous) => (previous?.user.id === next.user.id ? reuseJson(previous, { ...next,
      tasks: next.tasks.map(task => {
        const old = previous.tasks.find(value => value.id === task.id);
        return old ? reconcileTaskStream(old, task) : task;
      }) }) : next));
  if (!refreshQueue.current)
    refreshQueue.current = createRefreshQueue(async (scope) => {
      try {
        if (scope === 'network') {
          const network = await api<NodeNetwork>('/network');
          setData((previous) =>
            previous ? reuseJson(previous, { ...previous, network }) : previous,
          );
        } else applyBootstrap(await api<Bootstrap>('/bootstrap'));
        setError('');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          if (desktop) {
            try {
              await authenticateDesktop();
              applyBootstrap(await api<Bootstrap>('/bootstrap'));
              setError('');
            } catch (failure) {
              setData(null);
              setError((failure as Error).message);
            }
          } else setData(null);
        } else setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    });
  const refresh = refreshQueue.current;
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    if (!data?.user.id) return;
    const feed = new EventSource('/api/events');
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: RefreshScope | null = null;
    const schedule = (scope: RefreshScope) => {
      pending = pending === 'full' || scope === 'full' ? 'full' : 'network';
      if (!timer)
        timer = setTimeout(() => {
          timer = null;
          const next = pending!;
          pending = null;
          void refresh(next);
        }, 250);
    };
    const update = () => schedule('full');
    feed.addEventListener('connected', () => {
      setConnected(true);
      update();
    });
    feed.addEventListener('update', update);
    feed.addEventListener('network', () => schedule('network'));
    feed.addEventListener('delta', update);
    feed.addEventListener('task-stream', (event) => {
      try {
        const frame = JSON.parse((event as MessageEvent).data) as TaskStreamUpdate;
        setData(previous => previous ? { ...previous, tasks: previous.tasks.map(task => applyTaskStream(task, frame)) } : previous);
      } catch { update(); }
    });
    feed.onerror = () => setConnected(false);
    const fallback = setInterval(() => void refresh(), 5000);
    return () => {
      feed.close();
      clearInterval(fallback);
      if (timer) clearTimeout(timer);
    };
  }, [data?.user.id]);
  if (loading || (!data && desktop))
    return (
      <div className="loading">
        <LanguageSwitcher />
        <div className="loading-brand">
          <Wordmark />
        </div>
        <p>{systemText(error) || t('正在打开 Rivloom…')}</p>
        {error && <Button onClick={() => void refresh()}>{t('重试')}</Button>}
      </div>
    );
  if (!data) return <Auth onLogin={() => void refresh()} />;
  return (
    <ConversationWorkspace
      key={`${data.user.id}:${data.network.local?.id || 'local'}`}
      data={data}
      refresh={refresh}
      connected={connected}
      connectionError={error}
    />
  );
}

await initializeLanguage();
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nextProvider i18n={i18n}>
      <DesktopUpdateProvider><App /></DesktopUpdateProvider>
    </I18nextProvider>
  </React.StrictMode>,
);
