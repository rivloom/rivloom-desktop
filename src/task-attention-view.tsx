import { t, systemText, language } from '../shared/i18n.ts';
import { useEffect, useRef, useState } from 'react';
import { Bell, BellOff, CheckCheck, ChevronRight, Inbox, Play, RefreshCw, Volume2 } from 'lucide-react';
import { api } from './api';
import { desktop, notifyAttention, takeNotificationTarget } from './desktop';
import { reuseJson } from './desktop-refresh';
import { useDisplayClock } from './use-display-clock';
import { playCompletionSound } from './completion-sound';
import {
  attentionLabels,
  completionSoundFor,
  type CompletionSound,
  type AttentionSnapshot,
  type NotificationPreferences,
} from '../shared/task-attention';

export function useTaskAttention(identity: string, open: (key: string) => void) {
  const [snapshot, setSnapshot] = useState<Pick<AttentionSnapshot, 'items' | 'preferences'> | null>(
    null,
  );
  const [error, setError] = useState('');
  const [notificationError, setNotificationError] = useState('');
  const [soundError, setSoundError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let targetPending = false;
    async function takeTarget() {
      if (!desktop || cancelled || targetPending) return;
      targetPending = true;
      try {
        const target = await takeNotificationTarget();
        if (target && !cancelled) openRef.current(target);
      } catch {
        /* API can be unavailable in a browser or while the window is closing. */
      } finally {
        targetPending = false;
      }
    }
    async function poll() {
      try {
        const value = await api<AttentionSnapshot>(
          '/attention/check',
          {},
          { timeoutMilliseconds: 10_000 },
        );
        if (cancelled) return;
        // checkedAt and notification deliveries are transient, not display state.
        // Still deliver every returned notification even when the visible list is unchanged.
        setSnapshot((previous) =>
          reuseJson(previous, { items: value.items, preferences: value.preferences }),
        );
        setError('');
        const sound = completionSoundFor(value);
        if (sound) {
          try { await playCompletionSound(sound); if (!cancelled) setSoundError(false); }
          catch { if (!cancelled) setSoundError(true); }
        }
        if (cancelled) return;
        if (desktop && value.notifications.length) {
          const first = value.notifications[0];
          try {
            await notifyAttention(
              value.notifications.length === 1 ? first.conversationKey : 'attention',
              first.kind,
              value.notifications.length,
              value.notifications.some(item => item.kind === 'completed'),
            );
            if (!cancelled) setNotificationError('');
          } catch (cause) {
            if (!cancelled) setNotificationError(String(cause));
          }
        }
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message);
      } finally {
        if (!cancelled) {
          await takeTarget();
          timer = setTimeout(() => void poll(), 3000);
        }
      }
    }
    setSnapshot(null);
    void poll();
    window.addEventListener('focus', takeTarget);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener('focus', takeTarget);
    };
  }, [identity, revision]);
  async function preferences(value: NotificationPreferences) {
    if (saving) return;
    setSaving(true);
    try {
      const saved = await api<NotificationPreferences>('/attention/preferences', value);
      setSnapshot((previous) => (previous ? { ...previous, preferences: saved } : previous));
      setError('');
      if (!saved.enabled || saved.completionSound === 'off' || saved.quietUntil !== null && saved.quietUntil > Date.now()) {
        try { await playCompletionSound('off'); } catch { /* Preference is saved even if audio is unavailable. */ }
        setSoundError(false);
      }
      setRevision((v) => v + 1);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function previewSound(sound: CompletionSound) {
    try { await playCompletionSound(sound); setSoundError(false); }
    catch { setSoundError(true); }
  }
  return {
    snapshot,
    error,
    notificationError,
    soundError,
    previewSound,
    saving,
    preferences,
    refresh: () => setRevision((v) => v + 1),
  };
}

export function TaskAttentionView({
  controller,
  open,
}: {
  controller: ReturnType<typeof useTaskAttention>;
  open: (key: string) => void;
}) {
  const { snapshot, error, notificationError, soundError, previewSound, saving, preferences, refresh } = controller;
  const [filter, setFilter] = useState('all');
  const items = snapshot?.items || [];
  const prefs = snapshot?.preferences;
  const now = useDisplayClock(!!prefs?.quietUntil && prefs.quietUntil > Date.now());
  const quiet = !!prefs?.quietUntil && prefs.quietUntil > now;
  const filtered = items.filter((item) => filter === 'all' || item.kind === filter);
  return (
    <section className="attention-page" aria-label={t('待办中心')}>
      <div className="attention-heading">
        <div>
          <span className="eyebrow">{t('需要你的处理')}</span>
          <h1>
            {t('待办')}
            <span>{items.length}</span>
          </h1>
          <p>{t('审批和回答都从这里回到原会话。')}</p>
        </div>
        <button className="button" onClick={refresh}>
          <RefreshCw size={16} />
          {t('刷新')}
        </button>
      </div>
      <div className="attention-preferences">
        <Bell size={18} />
        <label>
          <input
            type="checkbox"
            checked={prefs?.enabled ?? false}
            disabled={!prefs || saving}
            onChange={(e) => prefs && void preferences({ ...prefs, enabled: e.target.checked })}
          />
          {t('桌面通知')}
        </label>
        <button
          className="button"
          disabled={!prefs || saving}
          onClick={() =>
            prefs &&
            void preferences({
              ...prefs,
              quietUntil: quiet ? null : Date.now() + 60 * 60_000,
            })
          }
        >
          <BellOff size={15} />
          {quiet ? t('结束免打扰') : t('免打扰 1 小时')}
        </button>
        <small>
          {quiet
            ? t('免打扰至 {{value1}}', {
                value1: new Date(prefs!.quietUntil!).toLocaleTimeString(language(), {
                  hour: '2-digit',
                  minute: '2-digit',
                }),
              })
            : desktop
              ? t('应用运行时提醒；通知只显示状态，不展示任务正文。')
              : t('系统通知在 Windows 安装版中提供。')}
        </small>
      </div>
      <div className="attention-sound-preferences">
        <Volume2 size={18} aria-hidden="true" />
        <label htmlFor="completion-sound">{t('任务完成提示音')}</label>
        <select id="completion-sound" value={prefs?.completionSound ?? 'chime'} disabled={!prefs || saving}
          onChange={event => prefs && void preferences({ ...prefs, completionSound: event.target.value as CompletionSound })}>
          <option value="off">{t('关闭声音')}</option>
          <option value="chime">{t('轻柔双音')}</option>
          <option value="bell">{t('清脆铃声')}</option>
          <option value="pulse">{t('简短提示')}</option>
        </select>
        <button type="button" className="button" disabled={!prefs || saving || prefs.completionSound === 'off'}
          onClick={() => prefs && void previewSound(prefs.completionSound)}><Play size={14} />{t('试听')}</button>
        <small>{t('在此设备播放，也提醒远端 Node 完成的任务。关闭桌面通知或开启免打扰时保持静音。')}</small>
      </div>
      {soundError && <p className="attention-notice" role="status">{t('提示音未播放，请检查系统音量并点击试听。')}</p>}
      {error && (
        <p className="error" role="alert">
          {t('待办暂未刷新：{{value1}}。下方保留上次状态。', { value1: systemText(error) })}
        </p>
      )}
      {notificationError && (
        <p className="attention-notice" role="status">
          {t('系统通知未发送：{{value1}}。你仍可在这里处理任务。', {
            value1: systemText(notificationError),
          })}
        </p>
      )}
      <div className="attention-filters" role="group" aria-label={t('待办分类')}>
        {[
          ['all', t('全部')],
          ['approval', t('待审批')],
          ['input', t('待回答')],
          ['interrupted', t('执行中断')],
          ['failed', t('需要检查')],
        ].map(([key, label]) => (
          <button
            key={key}
            className={filter === key ? 'active' : ''}
            aria-pressed={filter === key}
            onClick={() => setFilter(key)}
          >
            {label}
            <span>{key === 'all' ? items.length : items.filter((i) => i.kind === key).length}</span>
          </button>
        ))}
      </div>
      {!snapshot && !error ? (
        <p className="attention-empty">{t('正在读取待办…')}</p>
      ) : filtered.length ? (
        <div className="attention-list">
          {filtered.map((item) => (
            <button
              className="attention-card"
              key={item.key}
              onClick={() => open(item.conversationKey)}
            >
              <span className={`attention-kind ${item.kind}`}>
                <Inbox size={16} />
                {attentionLabels[item.kind]}
              </span>
              <span className="attention-card-copy">
                <strong>{item.title}</strong>
                <span>{systemText(item.detail)}</span>
                <time dateTime={item.updatedAt}>
                  {new Date(item.updatedAt).toLocaleString(language())}
                </time>
              </span>
              <ChevronRight size={18} />
            </button>
          ))}
        </div>
      ) : (
        <div className="attention-empty">
          <CheckCheck size={32} />
          <strong>
            {items.length ? t('这个分类暂时没有待办') : t('当前没有需要你处理的任务')}
          </strong>
          <span>{t('新的审批和提问会出现在这里。')}</span>
        </div>
      )}
    </section>
  );
}
