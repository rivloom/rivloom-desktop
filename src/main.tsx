import React, { useEffect, useState, useRef, type ReactNode, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowUpRight,
  ArrowLeft,
  Plus,
  Search,
  LayoutDashboard,
  Users,
  FolderGit2,
  Check,
  X,
  Play,
  Square,
  ChevronRight,
  CircleCheck,
  CircleDot,
  GitBranch,
  ShieldCheck,
  Activity as ActivityIcon,
  FileCode2,
  Bot,
  LogOut,
  LoaderCircle,
  AlertTriangle,
  MessageSquarePlus,
  ArrowRight,
  Copy,
  RefreshCw,
  Settings2,
  Network,
} from 'lucide-react';
import { api } from './api';
import { authenticateDesktop, desktop, chooseProjectDirectory } from './desktop';
import { ModelSettingsView } from './model-settings';
import { NodeNetworkView } from './node-network';
import {
  stateLabels,
  activeStates,
  type Task,
  type Bootstrap,
  type Activity,
  type TaskState,
} from '../shared/types';
import './styles.css';

const time = (value: string) =>
  new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
function Mark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
function Badge({ state }: { state: TaskState }) {
  return (
    <span className={`badge state-${state}`}>
      <span />
      {stateLabels[state]}
    </span>
  );
}
function Button({
  children,
  onClick,
  variant = '',
  disabled = false,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: string;
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  return (
    <button type={type} className={`button ${variant}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}
function Modal({
  title,
  subtitle,
  children,
  close,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="modal" onCancel={close}>
      <div className="modal-heading">
        <div>
          <span className="eyebrow">RIVLOOM / WORKSPACE</span>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button className="icon-button" onClick={close} aria-label="关闭">
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

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
        <a className="brand">
          <Mark />
          rivloom<span>PREVIEW</span>
        </a>
        <div className="auth-copy">
          <span className="eyebrow">HUMAN INTENT. AI EXECUTION.</span>
          <h1>
            一起，把想法
            <br />
            变成<span>交付。</span>
          </h1>
          <p>
            把任务交给 AI，把关键决定留给人。
            <br />
            从发起、执行到验收，每一步都有负责人。
          </p>
          <div className="journey">
            <span>
              <CircleDot />
              发起任务
            </span>
            <i />
            <span>
              <Bot />
              协作执行
            </span>
            <i />
            <span>
              <CircleCheck />
              确认交付
            </span>
          </div>
        </div>
        <p className="auth-foot">
          {desktop ? 'WINDOWS DESKTOP · ' : '内部 Web 调试 · '}OpenCode 驱动 · 可信团队内测
        </p>
      </div>
      <div className="auth-form">
        <div className="auth-form-inner">
          <span className="eyebrow">YOUR SHARED WORKSPACE</span>
          <h2>{setup ? '创建你的工作区' : join ? '加入协作空间' : '欢迎回到工作区'}</h2>
          <p>
            {setup
              ? '只需初始化一次。之后可以邀请真正的协作伙伴。'
              : join
                ? '用一次性邀请码创建属于你的独立账号。'
                : '登录后继续你的任务，而不仅仅是一段对话。'}
          </p>
          <form onSubmit={submit}>
            {(setup || join) && (
              <Field
                label={setup ? '本机初始化码' : '邀请人提供的一次性邀请码'}
                hint={
                  setup
                    ? '在 .data/setup-code.txt 中查看；不会公开注册。'
                    : '邀请码 24 小时内有效。'
                }
              >
                <input name="code" required autoComplete="off" />
              </Field>
            )}
            {(setup || join) && (
              <Field label="显示名称">
                <input name="name" required maxLength={40} placeholder="大家怎么称呼你" />
              </Field>
            )}
            <Field label="用户名">
              <input
                name="username"
                required
                pattern="[a-z0-9_-]{3,30}"
                autoComplete="username"
                placeholder="3–30 位小写字母、数字或下划线"
              />
            </Field>
            <Field label="密码" hint="至少 12 位，不要与其他账号共用。">
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
                {error}
              </p>
            )}
            <Button type="submit" disabled={busy} variant="primary wide">
              {busy ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}{' '}
              {setup ? '创建工作区' : join ? '加入工作区' : '进入工作区'}
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
              {join ? '已有账号？返回登录' : '收到邀请？创建独立账号'}
            </button>
          )}
          <div className="security-note">
            <ShieldCheck size={18} />
            <span>仅限可信参与者和专用测试环境。工作目录限制并非安全沙箱。</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'tasks' | 'projects' | 'team' | 'network' | 'models'>('tasks');
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState<
    'task' | 'project' | 'invite' | 'run' | 'requirement' | 'review' | null
  >(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState('');
  const [tab, setTab] = useState('overview');
  const [history, setHistory] = useState<Activity[]>([]);
  const [stream, setStream] = useState('');
  const [connected, setConnected] = useState(false);
  const [projectDirectory, setProjectDirectory] = useState('');
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const refresh = async () => {
    try {
      setData(await api<Bootstrap>('/bootstrap'));
    } catch (e) {
      if (desktop && (e as Error).message.includes('登录')) {
        try {
          await authenticateDesktop();
          setData(await api<Bootstrap>('/bootstrap'));
        } catch (desktopError) {
          setData(null);
          setError((desktopError as Error).message);
        }
      } else if ((e as Error).message.includes('登录')) setData(null);
      else setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    if (!data?.user.id) return;
    const feed = new EventSource('/api/events');
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const update = () => {
      if (!refreshTimer)
        refreshTimer = setTimeout(() => {
          void refresh();
          refreshTimer = null;
        }, 250);
    };
    feed.addEventListener('connected', () => {
      setConnected(true);
      update();
    });
    feed.addEventListener('update', update);
    feed.addEventListener('network', update);
    feed.addEventListener('delta', (e) => {
      const value = JSON.parse((e as MessageEvent).data);
      if (value.taskID === selectedRef.current)
        setStream((previous) => (previous + value.delta).slice(-14000));
    });
    feed.onerror = () => setConnected(false);
    const fallback = setInterval(() => void refresh(), 5000);
    return () => {
      feed.close();
      clearInterval(fallback);
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [data?.user.id]);
  const current = data?.tasks.find((t) => t.id === selected);
  useEffect(() => {
    setStream('');
    setTab('overview');
  }, [selected]);
  useEffect(() => {
    if (current)
      api<{ activities: Activity[] }>(`/tasks/${current.id}`)
        .then((r) => setHistory(r.activities))
        .catch(() => {});
  }, [current?.id, current?.version]);
  async function action(fn: () => Promise<unknown>, close = false) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
      if (close) setModal(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (loading)
    return (
      <div className="loading">
        <Mark />
        <p>正在打开任务空间…</p>
      </div>
    );
  if (!data && desktop)
    return (
      <div className="loading">
        <Mark />
        <p>{error || '正在建立本机身份…'}</p>
        {error && (
          <Button variant="secondary" onClick={() => void refresh()}>
            重试
          </Button>
        )}
      </div>
    );
  if (!data) return <Auth onLogin={() => void refresh()} />;
  const { user, users, projects, tasks, engine, network } = data;
  const name = (uid: string | null) => users.find((u) => u.id === uid)?.name || 'OpenCode';
  const counts = {
    active: tasks.filter((t) => activeStates.includes(t.state)).length,
    attention: tasks.filter(
      (t) => t.state === 'waiting_approval' || t.state === 'waiting_input' || t.state === 'review',
    ).length,
    done: tasks.filter((t) => t.state === 'accepted').length,
  };
  const visible = tasks.filter(
    (t) =>
      (filter === 'all' ||
        (filter === 'mine' &&
          (t.assigneeID === user.id ||
            (t.approverID === user.id && t.state === 'waiting_approval') ||
            (t.reviewerID === user.id && t.state === 'review'))) ||
        (filter === 'active' && activeStates.includes(t.state)) ||
        (filter === 'done' && t.state === 'accepted')) &&
      `${t.title} ${t.number}`.toLowerCase().includes(search.toLowerCase()),
  );
  const go = (next: typeof view) => {
    setView(next);
    setSelected(null);
  };
  const step =
    current?.state === 'open'
      ? 0
      : current?.state === 'ready'
        ? 1
        : current?.state === 'accepted'
          ? 4
          : current?.state === 'review'
            ? 3
            : 2;
  const roleSelect = (label: string, key: string) => (
    <Field label={label}>
      <select name={key} defaultValue={user.id}>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
            {u.id === user.id ? '（我）' : ''}
          </option>
        ))}
      </select>
    </Field>
  );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" onClick={() => go('tasks')}>
          <Mark />
          rivloom
        </a>
        <div className="workspace-label">
          <span className="workspace-icon">B</span>
          <div>
            {network.local?.brains[0]?.name || '本机 Brain'}
            <small>{desktop ? '自动发现已启动' : 'INTERNAL WEB DEBUG'}</small>
          </div>
        </div>
        <span className="nav-heading">任务与节点</span>
        <nav>
          <button className={view === 'tasks' ? 'active' : ''} onClick={() => go('tasks')}>
            <LayoutDashboard size={18} />
            任务工作台<span>{tasks.length}</span>
          </button>
          <button className={view === 'projects' ? 'active' : ''} onClick={() => go('projects')}>
            <FolderGit2 size={18} />
            本地项目<span>{projects.length}</span>
          </button>
          <button className={view === 'team' ? 'active' : ''} onClick={() => go('team')}>
            <Users size={18} />
            协作成员<span>{users.length}</span>
          </button>
          <button className={view === 'network' ? 'active' : ''} onClick={() => go('network')}>
            <Network size={18} />
            节点与 Brain
            <span>
              {network.nearby.filter((node) => node.online).length + (network.local ? 1 : 0)}
            </span>
          </button>
          <button className={view === 'models' ? 'active' : ''} onClick={() => go('models')}>
            <Settings2 size={18} />
            模型与额度<span>{engine.models.length}</span>
          </button>
        </nav>
        <div className="sidebar-guide">
          <span className="eyebrow">BUILD TOGETHER</span>
          <p>
            人负责决定。
            <br />
            AI 负责执行。
          </p>
          <span className="guide-line" />
          <small>
            任务有目标，执行有审批，
            <br />
            交付有验收。
          </small>
        </div>
        <div className="sidebar-bottom">
          <div className="engine-dot">
            <span className={engine.ready ? 'online' : ''} />
            <div>
              OpenCode {engine.version}
              <small>{engine.ready ? '本机引擎已连接' : '引擎尚未就绪'}</small>
            </div>
          </div>
          {desktop ? (
            <div className="user-row local-user" title="当前 Windows 用户的本机身份">
              <span className="avatar">{user.name.slice(0, 1)}</span>
              <div>
                {user.name}
                <small>本机操作者</small>
              </div>
            </div>
          ) : (
            <button
              className="user-row"
              onClick={() =>
                void action(async () => {
                  await api('/auth/logout', {});
                  setData(null);
                })
              }
              title="退出登录"
            >
              <span className="avatar">{user.name.slice(0, 1)}</span>
              <div>
                {user.name}
                <small>{user.owner ? '工作区创建者' : '协作成员'}</small>
              </div>
              <LogOut size={16} />
            </button>
          )}
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div>
            Rivloom
            <ChevronRight size={14} />
            <strong>
              {view === 'tasks'
                ? '任务工作台'
                : view === 'projects'
                  ? '本地项目'
                  : view === 'team'
                    ? '协作成员'
                    : view === 'network'
                      ? '节点与 Brain'
                      : '模型与额度'}
            </strong>
            {current && (
              <>
                <ChevronRight size={14} />
                <span>RV-{String(current.number).padStart(3, '0')}</span>
              </>
            )}
          </div>
          <div className="topbar-right">
            <span className="preview-label">MVP / 内测</span>
            <span className={`connection ${connected ? 'ok' : ''}`}>
              <i />
              {connected ? '实时同步' : '正在重连'}
            </span>
            <button
              className="icon-button"
              title="刷新数据"
              aria-label="刷新数据"
              onClick={() => void refresh()}
            >
              <RefreshCw size={16} />
            </button>
          </div>
        </header>
        <main>
          {error && (
            <div className="error global-error" role="alert">
              <AlertTriangle size={18} />
              <span>{error}</span>
              <button
                aria-label="关闭错误提示"
                className="icon-button"
                onClick={() => setError('')}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {!engine.ready && (
            <div className="notice">
              <LoaderCircle size={17} />
              {engine.error || 'OpenCode 正在启动；你可以先创建任务和邀请成员。'}
            </div>
          )}
          {view === 'tasks' && !current && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">TASKS, NOT JUST CHATS</span>
                  <h1>
                    任务工作台<span className="heading-dot">.</span>
                  </h1>
                  <p>从一个明确的目标，到一份经过确认的交付。</p>
                </div>
                <Button
                  variant="primary"
                  onClick={() => setModal(projects.length ? 'task' : 'project')}
                >
                  <Plus size={18} />
                  创建任务
                </Button>
              </div>
              <div className="stats">
                <div>
                  <span>
                    全部任务
                    <LayoutDashboard size={17} />
                  </span>
                  <strong>{String(tasks.length).padStart(2, '0')}</strong>
                  <small>明确目标与责任</small>
                </div>
                <div>
                  <span>
                    AI 执行中
                    <Bot size={18} />
                  </span>
                  <strong>{String(counts.active).padStart(2, '0')}</strong>
                  <small>持续同步执行进度</small>
                </div>
                <div className={counts.attention ? 'attention-stat' : ''}>
                  <span>
                    等待人工确认
                    <ShieldCheck size={18} />
                  </span>
                  <strong>{String(counts.attention).padStart(2, '0')}</strong>
                  <small>审批、补充与验收</small>
                </div>
                <div>
                  <span>
                    已确认交付
                    <CircleCheck size={18} />
                  </span>
                  <strong>{String(counts.done).padStart(2, '0')}</strong>
                  <small>由指定验收人确认</small>
                </div>
              </div>
              <section className="task-panel">
                <div className="panel-toolbar">
                  <div className="filter-tabs">
                    {[
                      ['all', '全部任务'],
                      ['mine', '与我相关'],
                      ['active', '执行中'],
                      ['done', '已验收'],
                    ].map(([key, label]) => (
                      <button
                        className={filter === key ? 'selected' : ''}
                        key={key}
                        onClick={() => setFilter(key)}
                      >
                        {label}
                        {key === 'all' && <span>{tasks.length}</span>}
                      </button>
                    ))}
                  </div>
                  <label className="search">
                    <Search size={16} />
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="搜索任务…"
                      aria-label="搜索任务"
                    />
                    <span>⌕</span>
                  </label>
                </div>
                <div className="task-table">
                  <div className="table-heading">
                    <span>任务 / 目标</span>
                    <span>状态</span>
                    <span>接受人</span>
                    <span>最后更新</span>
                    <span />
                  </div>
                  {visible.map((t) => (
                    <button key={t.id} className="task-row" onClick={() => setSelected(t.id)}>
                      <div className="task-name">
                        <span className={`task-glyph ${t.state === 'accepted' ? 'complete' : ''}`}>
                          {t.state === 'accepted' ? <Check size={19} /> : <FileCode2 size={19} />}
                        </span>
                        <div>
                          <strong>{t.title}</strong>
                          <small>
                            RV-{String(t.number).padStart(3, '0')}
                            <i /> {projects.find((p) => p.id === t.projectID)?.name}
                          </small>
                        </div>
                      </div>
                      <Badge state={t.state} />
                      <span className="person">
                        <i>{name(t.assigneeID).slice(0, 1)}</i>
                        {name(t.assigneeID)}
                      </span>
                      <span className="time">{time(t.updatedAt)}</span>
                      <ChevronRight size={16} />
                    </button>
                  ))}
                </div>
                {!visible.length && (
                  <div className="empty">
                    <div className="empty-symbol">
                      <GitBranch size={32} />
                      <span>
                        <Plus size={15} />
                      </span>
                    </div>
                    <h3>
                      {search
                        ? '没有找到这个任务'
                        : tasks.length
                          ? '这个视图暂时没有任务'
                          : '你的第一份交付，从这里开始'}
                    </h3>
                    <p>
                      {tasks.length
                        ? '调整筛选或创建一个新任务。'
                        : '添加一个可信的 Git 项目，写下目标与验收标准，\n再邀请 AI 和协作伙伴加入。'}
                    </p>
                    <Button onClick={() => setModal(projects.length ? 'task' : 'project')}>
                      <Plus size={16} />
                      {projects.length ? '创建第一个任务' : '添加本地项目'}
                    </Button>
                  </div>
                )}
                <div className="table-footer">
                  <span>{visible.length} 个任务 · 所有状态由工作区管理</span>
                  <span>
                    <ShieldCheck size={14} />
                    人工审批始终保留
                  </span>
                </div>
              </section>
              <div className="bottom-note">
                <GitBranch size={15} />
                代码在本机执行。请只授权专用测试仓库，不要在工作区放置生产凭据。
              </div>
            </>
          )}
          {view === 'tasks' && current && (
            <>
              <button className="text-button back" onClick={() => setSelected(null)}>
                <ArrowLeft size={15} />
                返回任务列表
              </button>
              <div className="detail-heading">
                <div>
                  <div className="detail-meta">
                    <span>RV-{String(current.number).padStart(3, '0')}</span>
                    <Badge state={current.state} />
                  </div>
                  <h1>{current.title}</h1>
                  <p>
                    <FolderGit2 size={15} />
                    {projects.find((p) => p.id === current.projectID)?.name}
                    <span>
                      由 {name(current.creatorID)} 发起 · {time(current.createdAt)}
                    </span>
                  </p>
                </div>
                <div className="action-group">
                  {current.state === 'open' && user.id === current.assigneeID && (
                    <Button
                      variant="primary"
                      disabled={busy}
                      onClick={() => void action(() => api(`/tasks/${current.id}/claim`, {}))}
                    >
                      <Check size={17} />
                      接受任务
                    </Button>
                  )}
                  {['ready', 'stopped', 'failed', 'interrupted', 'review'].includes(
                    current.state,
                  ) &&
                    user.id === current.assigneeID && (
                      <Button
                        variant="primary"
                        disabled={busy || !engine.ready}
                        onClick={() => setModal('run')}
                      >
                        <Play size={16} />
                        {current.sessionID ? '继续执行' : '开始执行'}
                      </Button>
                    )}
                  {(activeStates.includes(current.state) || current.state === 'interrupted') && (
                    <Button
                      variant="danger"
                      disabled={busy || current.state === 'stopping'}
                      onClick={() => void action(() => api(`/tasks/${current.id}/stop`, {}))}
                    >
                      <Square size={14} />
                      停止执行
                    </Button>
                  )}
                  {current.state === 'review' && user.id === current.reviewerID && (
                    <Button
                      variant="primary"
                      onClick={() => {
                        setTab('artifacts');
                        setModal('review');
                      }}
                    >
                      <CircleCheck size={17} />
                      验收产物
                    </Button>
                  )}
                </div>
              </div>
              <div className="progress-steps">
                {['任务发起', '接受任务', '协作执行', '产物验收', '确认交付'].map(
                  (label, index) => (
                    <div key={label} className={index <= step ? 'reached' : ''}>
                      <span>{index < step ? <Check size={13} /> : index + 1}</span>
                      {label}
                      {index < 4 && <i />}
                    </div>
                  ),
                )}
              </div>
              <div className="detail-grid">
                <div className="detail-main">
                  {current.error && (
                    <div className="error">
                      <AlertTriangle size={17} />
                      {current.error}
                    </div>
                  )}
                  {current.approvals.map((p) => (
                    <section className="approval-card" key={p.id}>
                      <div className="approval-title">
                        <span>
                          <ShieldCheck size={21} />
                        </span>
                        <div>
                          <strong>AI 正在等待操作审批</strong>
                          <p>
                            {name(current.approverID)} 负责审批 ·{' '}
                            {p.permission === 'edit'
                              ? '修改文件'
                              : p.permission === 'bash'
                                ? '执行命令'
                                : p.permission}
                          </p>
                        </div>
                      </div>
                      <pre>
                        {String(p.metadata.command || p.metadata.diff || p.patterns.join('\n'))}
                      </pre>
                      <div className="approval-footer">
                        <small>仅授权本次请求。请检查全部内容。</small>
                        {user.id === current.approverID ? (
                          <div className="action-group">
                            <Button
                              disabled={busy}
                              onClick={() =>
                                void action(() =>
                                  api(`/tasks/${current.id}/permissions/${p.id}`, {
                                    reply: 'reject',
                                  }),
                                )
                              }
                            >
                              拒绝
                            </Button>
                            <Button
                              variant="primary"
                              disabled={busy}
                              onClick={() =>
                                void action(() =>
                                  api(`/tasks/${current.id}/permissions/${p.id}`, {
                                    reply: 'once',
                                  }),
                                )
                              }
                            >
                              <Check size={16} />
                              仅本次允许
                            </Button>
                          </div>
                        ) : (
                          <span>等待 {name(current.approverID)} 回复</span>
                        )}
                      </div>
                    </section>
                  ))}
                  {current.questions.map((q) => (
                    <section className="approval-card" key={q.id}>
                      <h3>AI 需要补充信息</h3>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          const form = new FormData(e.currentTarget);
                          void action(() =>
                            api(`/tasks/${current.id}/questions/${q.id}`, {
                              answers: q.questions.map((_, i) => [String(form.get(`answer-${i}`))]),
                            }),
                          );
                        }}
                      >
                        {q.questions.map((question, i) => (
                          <Field
                            key={i}
                            label={question.question}
                            hint={question.options
                              .map((o) => `${o.label}：${o.description}`)
                              .join('；')}
                          >
                            <input
                              name={`answer-${i}`}
                              required
                              placeholder="输入答案；多选题可用文字说明"
                              disabled={![current.creatorID, current.assigneeID].includes(user.id)}
                            />
                          </Field>
                        ))}
                        {[current.creatorID, current.assigneeID].includes(user.id) && (
                          <Button type="submit" variant="primary" disabled={busy}>
                            回复 AI
                          </Button>
                        )}
                      </form>
                    </section>
                  ))}
                  <section className="detail-content">
                    <div className="detail-tabs">
                      {[
                        ['overview', '任务概览'],
                        ['execution', '执行记录'],
                        ['artifacts', `产物与差异 ${current.artifacts.length || ''}`],
                        ['activity', '活动记录'],
                      ].map(([key, label]) => (
                        <button
                          key={key}
                          className={tab === key ? 'selected' : ''}
                          onClick={() => setTab(key)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    {tab === 'overview' && (
                      <div className="overview">
                        <div className="section-label">
                          <CircleDot size={16} />
                          <h3>任务目标</h3>
                        </div>
                        <p className="preserve">{current.description}</p>
                        <div className="section-label">
                          <CircleCheck size={16} />
                          <h3>验收标准</h3>
                        </div>
                        <div className="criteria preserve">{current.criteria}</div>
                        <div className="section-label">
                          <Bot size={17} />
                          <h3>执行安排</h3>
                        </div>
                        <p>
                          接受人启动任务后，由 OpenCode 执行。修改文件与运行命令需要{' '}
                          {name(current.approverID)} 逐次审批；执行结束后由{' '}
                          {name(current.reviewerID)} 查看产物并验收。
                        </p>
                        {current.state !== 'accepted' &&
                          [current.creatorID, current.assigneeID].includes(user.id) && (
                            <Button onClick={() => setModal('requirement')}>
                              <MessageSquarePlus size={17} />
                              补充要求
                            </Button>
                          )}
                        {current.state === 'accepted' && (
                          <div className="success-line">
                            <CircleCheck size={20} />
                            {name(current.acceptedBy)}{' '}
                            已确认验收。文件保留在本地项目中，不自动提交或推送。
                          </div>
                        )}
                      </div>
                    )}
                    {tab === 'execution' && (
                      <div className="execution">
                        {!current.messages.length && (
                          <div className="empty compact">
                            <Bot size={30} />
                            <h3>尚未开始执行</h3>
                            <p>真实引擎启动后，输出和工具记录会出现在这里。</p>
                          </div>
                        )}
                        {current.messages.map((message) => (
                          <article key={message.id} className={`message ${message.role}`}>
                            <div className="message-label">
                              {message.role === 'assistant' ? (
                                <Bot size={16} />
                              ) : (
                                <CircleDot size={16} />
                              )}
                              <strong>
                                {message.role === 'assistant' ? 'OpenCode' : '任务要求'}
                              </strong>
                              <span>
                                {message.role === 'assistant' ? 'AI EXECUTION' : 'HUMAN INTENT'}
                              </span>
                            </div>
                            {message.text && <p className="preserve">{message.text}</p>}
                            {message.tools.map((tool, i) => (
                              <details className="tool-call" key={i}>
                                <summary>
                                  <FileCode2 size={15} />
                                  <span>{tool.title}</span>
                                  <small>{tool.status}</small>
                                </summary>
                                <pre>{tool.output || '等待执行结果…'}</pre>
                              </details>
                            ))}
                          </article>
                        ))}
                        {stream && activeStates.includes(current.state) && (
                          <details className="live-stream" open>
                            <summary>
                              <span className="pulse" />
                              实时输出
                            </summary>
                            <pre>{stream}</pre>
                          </details>
                        )}
                      </div>
                    )}
                    {tab === 'artifacts' && (
                      <div className="artifacts">
                        <div className="artifact-summary">
                          <GitBranch size={16} />
                          <span>{current.artifacts.length} 个变更文件</span>
                          <strong className="add">
                            +{current.artifacts.reduce((n, f) => n + f.additions, 0)}
                          </strong>
                          <strong className="del">
                            −{current.artifacts.reduce((n, f) => n + f.deletions, 0)}
                          </strong>
                        </div>
                        {current.artifacts.length ? (
                          <>
                            <p className="muted">
                              来源：{current.diffSource}
                              。这里展示执行结束或停止时的快照；验收时会再次核对。
                            </p>
                            {current.artifacts.map((file) => (
                              <details className="file-diff" key={file.file} open>
                                <summary>
                                  <FileCode2 size={16} />
                                  <strong>{file.file}</strong>
                                  <span className="add">+{file.additions}</span>
                                  <span className="del">−{file.deletions}</span>
                                </summary>
                                <pre>
                                  {file.patch.split('\n').map((line, i) => (
                                    <div
                                      key={i}
                                      className={
                                        line.startsWith('+')
                                          ? 'diff-add'
                                          : line.startsWith('-')
                                            ? 'diff-del'
                                            : line.startsWith('@@')
                                              ? 'diff-hunk'
                                              : ''
                                      }
                                    >
                                      <span>{line || ' '}</span>
                                    </div>
                                  ))}
                                </pre>
                              </details>
                            ))}
                          </>
                        ) : (
                          <div className="empty compact">
                            <FileCode2 size={30} />
                            <h3>
                              {current.sessionID ? '没有捕获到文件变更' : '产物将在执行后出现'}
                            </h3>
                            <p>请结合执行结果和验收标准判断任务是否完成。</p>
                          </div>
                        )}
                      </div>
                    )}
                    {tab === 'activity' && (
                      <div className="timeline">
                        {history.map((item) => (
                          <div className="timeline-item" key={item.id}>
                            <span className="timeline-point">
                              <ActivityIcon size={13} />
                            </span>
                            <div>
                              <strong>{name(item.actorID)}</strong>
                              <p>{item.text}</p>
                              <small>{time(item.at)}</small>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                </div>
                <aside className="task-aside">
                  <section>
                    <h3>
                      任务责任人<span>4 个角色</span>
                    </h3>
                    {[
                      ['发起', current.creatorID, '定义目标与要求'],
                      ['接受', current.assigneeID, '负责执行与跟进'],
                      ['审批', current.approverID, '确认敏感操作'],
                      ['验收', current.reviewerID, '确认最终交付'],
                    ].map(([role, uid, hint]) => (
                      <div className="role-row" key={role}>
                        <span>{role}</span>
                        <i className="avatar">{name(uid).slice(0, 1)}</i>
                        <div>
                          <strong>
                            {name(uid)}
                            {uid === user.id && <em>我</em>}
                          </strong>
                          <small>{hint}</small>
                        </div>
                      </div>
                    ))}
                  </section>
                  <section>
                    <h3>执行环境</h3>
                    <dl>
                      <dt>引擎</dt>
                      <dd>OpenCode {engine.version}</dd>
                      <dt>模型</dt>
                      <dd className="mono">{current.model}</dd>
                      <dt>项目目录</dt>
                      <dd className="mono">
                        {projects.find((p) => p.id === current.projectID)?.directory}
                      </dd>
                      <dt>会话</dt>
                      <dd className="mono">{current.sessionID || '接受并执行后创建'}</dd>
                      <dt>权限策略</dt>
                      <dd>文件修改 / 命令 → 每次确认</dd>
                    </dl>
                  </section>
                  <div className="aside-note">
                    <ShieldCheck size={20} />
                    <p>在专用环境中协作</p>
                    <small>
                      AI
                      以本机用户权限执行。审批不能替代操作系统沙箱。已执行的修改不会随停止而撤销。
                    </small>
                  </div>
                </aside>
              </div>
            </>
          )}
          {view === 'projects' && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">LOCAL BY DEFAULT</span>
                  <h1>
                    本地项目<span className="heading-dot">.</span>
                  </h1>
                  <p>代码留在执行主机。每个项目同一时间只处理一个任务。</p>
                </div>
                {user.owner && (
                  <Button variant="primary" onClick={() => setModal('project')}>
                    <Plus size={17} />
                    添加项目
                  </Button>
                )}
              </div>
              <div className="project-grid">
                {projects.map((p) => (
                  <section className="project-card" key={p.id}>
                    <FolderGit2 size={26} />
                    <span className="preview-label">GIT</span>
                    <h2>{p.name}</h2>
                    <p className="mono">{p.directory}</p>
                    <footer>
                      <span>{tasks.filter((t) => t.projectID === p.id).length} 个任务</span>
                      <Button
                        onClick={() => {
                          go('tasks');
                          setModal('task');
                        }}
                      >
                        创建任务
                        <ArrowUpRight size={16} />
                      </Button>
                    </footer>
                  </section>
                ))}
              </div>
              {!projects.length && (
                <div className="empty">
                  <FolderGit2 size={35} />
                  <h3>添加一个专用测试仓库</h3>
                  <p>需要有初始提交的 Git 仓库。首次执行前，工作区必须干净。</p>
                </div>
              )}
              <div className="notice">
                <AlertTriangle size={17} />
                请先在本机审核仓库内的 OpenCode 配置、插件与指令。可信目录不是安全隔离。
              </div>
            </>
          )}
          {view === 'team' && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">BETTER, TOGETHER</span>
                  <h1>
                    协作成员<span className="heading-dot">.</span>
                  </h1>
                  <p>独立账号、独立登录。任务角色由服务端验证。</p>
                </div>
                {user.owner && (
                  <Button
                    variant="primary"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        const value = await api<{ code: string }>('/invitations', {});
                        setInvite(value.code);
                        setModal('invite');
                      })
                    }
                  >
                    <Plus size={17} />
                    邀请成员
                  </Button>
                )}
              </div>
              <div className="members">
                {users.map((u) => (
                  <div className="member" key={u.id}>
                    <span className="avatar">{u.name.slice(0, 1)}</span>
                    <div>
                      <h3>
                        {u.name} {u.id === user.id && <small>你</small>}
                      </h3>
                      <p>@{u.username}</p>
                    </div>
                    <span className="member-role">{u.owner ? '工作区创建者' : '协作成员'}</span>
                    <span>
                      <ShieldCheck size={16} />
                      独立账号
                    </span>
                  </div>
                ))}
              </div>
              <div className="collaboration-note">
                <Users size={25} />
                <div>
                  <h3>独立账号是 Brain 权限的基础</h3>
                  <p>
                    当前邀请码用于本 Brain 的账号协议。附近设备会在“节点与
                    Brain”中自动出现，但发现不会直接授予成员或项目权限；设备配对完成后再把独立身份带入跨节点任务。
                  </p>
                </div>
              </div>
            </>
          )}
          {view === 'models' && (
            <ModelSettingsView
              owner={user.owner}
              engineReady={engine.ready}
              onChanged={() => void refresh()}
            />
          )}
          {view === 'network' && (
            <NodeNetworkView
              network={network}
              owner={user.owner}
              busy={busy}
              onRequestPairing={(nodeID) => void action(() => api('/network/pairings', { nodeID }))}
              onConfirmPairing={(pairingID) =>
                void action(() => api(`/network/pairings/${pairingID}/confirm`, {}))
              }
              onCancelPairing={(pairingID) =>
                void action(() => api(`/network/pairings/${pairingID}/cancel`, {}))
              }
              onRevokeTrust={(nodeID) => {
                if (
                  globalThis.confirm(
                    '撤销后，两台设备将不能继续通过该信任关系协作。确定撤销此设备吗？',
                  )
                )
                  void action(() => api(`/network/trusted/${nodeID}/revoke`, { confirmed: true }));
              }}
              onCreateRemoteTask={(nodeID, targetBrainID, input) =>
                void action(() =>
                  api('/network/tasks', {
                    nodeID,
                    targetBrainID,
                    ...input,
                    confirmed: true,
                  }),
                )
              }
              onRespondRemoteTask={(taskID, decision) =>
                void action(() =>
                  api(
                    `/network/tasks/${taskID}/${decision === 'accepted' ? 'accept' : 'decline'}`,
                    {
                      confirmed: true,
                    },
                  ),
                )
              }
              onCancelRemoteTask={(taskID) => {
                if (globalThis.confirm('确定取消这条跨设备任务邀请吗？'))
                  void action(() => api(`/network/tasks/${taskID}/cancel`, { confirmed: true }));
              }}
            />
          )}
        </main>
        <footer className="app-footer">
          <span>RIVLOOM · 人与 AI 的任务空间</span>
          <span>本地优先 / 审批可追溯 / 交付需验收</span>
        </footer>
      </div>
      {modal === 'project' && (
        <Modal
          title="添加本地项目"
          subtitle="授权一个已审核的 Git 测试仓库。只有工作区创建者可添加。"
          close={() => setModal(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void action(
                () =>
                  api('/projects', {
                    name: f.get('name'),
                    directory: f.get('directory'),
                    trusted: true,
                  }),
                true,
              );
            }}
          >
            <Field label="项目名称">
              <input name="name" required placeholder="例如：Website" maxLength={60} />
            </Field>
            <Field
              label="执行主机上的绝对路径"
              hint={
                desktop
                  ? '选择本机可信的测试仓库，需要有至少一次 Git 提交。'
                  : '仓库需要有至少一次 Git 提交。这是执行主机的路径。'
              }
            >
              <input
                name="directory"
                required
                placeholder="C:\projects\my-test-repo"
                value={projectDirectory}
                onChange={(e) => setProjectDirectory(e.target.value)}
              />
            </Field>
            {desktop && (
              <Button
                onClick={() => {
                  void chooseProjectDirectory()
                    .then((path) => {
                      if (path) setProjectDirectory(path);
                    })
                    .catch(() => setError('无法打开目录选择器，请手动填写路径。'));
                }}
              >
                <FolderGit2 size={16} />
                浏览本机文件夹
              </Button>
            )}
            <label className="checkbox">
              <input type="checkbox" required />
              我已检查项目配置与插件，确认这是可信的专用测试环境，并了解这里没有安全沙箱。
            </label>
            {error && <p className="error">{error}</p>}
            <div className="modal-actions">
              <Button onClick={() => setModal(null)}>取消</Button>
              <Button type="submit" variant="primary" disabled={busy || !user.owner}>
                添加项目
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {modal === 'task' && (
        <Modal
          title="创建协作任务"
          subtitle="先写清交付目标，再确定谁负责每个决定。"
          close={() => setModal(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = Object.fromEntries(new FormData(e.currentTarget));
              void action(async () => {
                const result = await api<Task>('/tasks', form);
                setSelected(result.id);
              }, true);
            }}
          >
            <Field label="任务标题">
              <input
                name="title"
                required
                placeholder="例如：修复 slugify 函数并补齐测试"
                maxLength={120}
              />
            </Field>
            <Field label="所属项目">
              <select name="projectID">
                {projects.map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="目标与要求">
              <textarea
                name="description"
                required
                rows={3}
                placeholder="说明需要完成什么、涉及哪些文件，以及不要做什么。"
                maxLength={12000}
              />
            </Field>
            <Field label="验收标准">
              <textarea
                name="criteria"
                required
                rows={2}
                placeholder="例如：现有测试全部通过，不修改测试文件；提供修改说明。"
                maxLength={4000}
              />
            </Field>
            <div className="form-row">
              {roleSelect('接受人', 'assigneeID')}
              {roleSelect('审批人', 'approverID')}
              {roleSelect('验收人', 'reviewerID')}
            </div>
            <Field
              label="执行模型"
              hint="模型请求会把任务内容发送给所选提供方；免费模型可用性和数据政策由提供方决定。"
            >
              <select name="model" defaultValue={data.defaultModel}>
                {engine.models.length ? (
                  engine.models.map((m) => (
                    <option value={m.id} key={m.id}>
                      {m.name}
                    </option>
                  ))
                ) : (
                  <option value={data.defaultModel}>{data.defaultModel}</option>
                )}
              </select>
            </Field>
            {error && <p className="error">{error}</p>}
            <div className="modal-actions">
              <span className="muted">创建后由接受人启动执行</span>
              <Button type="submit" variant="primary" disabled={busy}>
                创建任务
                <ArrowRight size={16} />
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {modal === 'invite' && (
        <Modal
          title="邀请一位协作伙伴"
          subtitle="当前邀请码属于本 Brain，仅可使用一次，有效期为 24 小时。"
          close={() => setModal(null)}
        >
          <div className="invite-code">{invite}</div>
          <p>
            这项能力已经验证独立账号和任务角色，但尚未连接附近节点。后续设备配对会把成员加入请求送到对应
            Brain，不会依靠共享本机页面或切换用户视角。
          </p>
          <div className="notice">这里只生成邀请码，不会代你发送邀请或公开应用。</div>
          <div className="modal-actions">
            <Button onClick={() => setModal(null)}>完成</Button>
            <Button
              variant="primary"
              onClick={() => void action(() => navigator.clipboard.writeText(invite))}
            >
              <Copy size={16} />
              复制邀请码
            </Button>
          </div>
        </Modal>
      )}
      {modal === 'run' && current && (
        <Modal
          title={current.sessionID ? '继续执行任务' : '确认开始执行'}
          subtitle={`接受人 ${user.name} 将启动真实 OpenCode 会话。`}
          close={() => setModal(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              setStream('');
              void action(
                () =>
                  api(`/tasks/${current.id}/run`, {
                    confirmed: true,
                    addition: current.sessionID ? String(f.get('addition')) : undefined,
                  }),
                true,
              );
              setTab('execution');
            }}
          >
            <div className="notice">
              <AlertTriangle size={19} />
              AI
              可以实际修改文件和执行命令。逐次审批不能提供沙箱隔离；停止也不会回滚已经完成的操作。
            </div>
            {current.sessionID && (
              <Field label="本次继续执行的要求">
                <textarea
                  name="addition"
                  required
                  rows={5}
                  defaultValue={`请继续完成任务，并遵循以下最新要求：\n${current.description}\n验收标准：${current.criteria}`}
                />
              </Field>
            )}
            <label className="checkbox">
              <input type="checkbox" required />
              我确认该项目是可信测试环境，同意把任务内容发送给所选模型，并已检查当前修改。
            </label>
            {error && <p className="error">{error}</p>}
            <div className="modal-actions">
              <Button onClick={() => setModal(null)}>取消</Button>
              <Button type="submit" variant="primary" disabled={busy}>
                <Play size={16} />
                确认执行
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {modal === 'requirement' && current && (
        <Modal
          title="补充任务要求"
          subtitle="执行中的任务会先停止；新要求留下记录，由接受人确认后继续。"
          close={() => setModal(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void action(
                () => api(`/tasks/${current.id}/requirements`, { text: f.get('text') }),
                true,
              );
            }}
          >
            <Field label="补充要求">
              <textarea
                name="text"
                required
                rows={5}
                maxLength={12000}
                placeholder="描述新的约束、范围或期望行为…"
              />
            </Field>
            {error && <p className="error">{error}</p>}
            <div className="modal-actions">
              <Button onClick={() => setModal(null)}>取消</Button>
              <Button type="submit" variant="primary" disabled={busy}>
                保存要求{activeStates.includes(current.state) ? '并停止' : ''}
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {modal === 'review' && current && (
        <Modal
          title="确认本次交付"
          subtitle={`指定验收人：${name(current.reviewerID)}。请先关闭此窗口查看差异和测试记录，再确认验收。`}
          close={() => setModal(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void action(
                () =>
                  api(`/tasks/${current.id}/accept`, {
                    version: current.version,
                    note: f.get('note'),
                    confirmed: true,
                  }),
                true,
              );
            }}
          >
            <div className="criteria preserve">{current.criteria}</div>
            <Field label="验收意见">
              <textarea
                name="note"
                required
                rows={3}
                placeholder="说明已核对的标准，或需要继续修改的内容。"
              />
            </Field>
            <label className="checkbox">
              <input type="checkbox" required />
              我已查看产物和测试记录，确认达到验收标准。验收不会自动提交、推送或部署。
            </label>
            {error && <p className="error">{error}</p>}
            <div className="modal-actions">
              <Button
                disabled={busy}
                onClick={() => {
                  const note = (
                    document.querySelector('dialog textarea[name="note"]') as HTMLTextAreaElement
                  )?.value;
                  if (!note?.trim()) {
                    setError('请先填写退回修改的意见');
                    return;
                  }
                  void action(() => api(`/tasks/${current.id}/request-changes`, { note }), true);
                }}
              >
                退回修改
              </Button>
              <Button type="submit" variant="primary" disabled={busy}>
                <CircleCheck size={17} />
                确认验收
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
