import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDownToLine, CircleCheck, LoaderCircle, RotateCw } from 'lucide-react';
import { t } from '../shared/i18n.ts';
import { shouldPromptForUpdate, updateDownloadPercent, updateIsBusy, type DesktopUpdateSnapshot } from '../shared/desktop-update.ts';
import { desktop, desktopUpdateSnapshot, checkDesktopUpdate, skipDesktopUpdate, downloadDesktopUpdate, cancelDesktopUpdate, installDesktopUpdate } from './desktop';
import { Button, Modal } from './ui';
import './desktop-update.css';

type Updates = { snapshot: DesktopUpdateSnapshot | null; check: () => void; open: () => void; unavailable: boolean };
const UpdateContext = createContext<Updates | null>(null);

const messages: Record<string, () => string> = {
  update_check_failed: () => t('暂时无法检查更新，请检查网络后重试。'),
  update_manifest_invalid: () => t('官网更新信息暂不可用，请稍后重试。'),
  update_download_failed: () => t('更新下载未完成，请检查网络或磁盘空间后重试。'),
  update_signature_invalid: () => t('更新文件未通过安全校验，请重新下载。'),
  update_save_failed: () => t('更新偏好未能保存，请重试。'),
  update_busy: () => t('更新操作正在进行，请稍候。'),
  update_tasks_pending: () => t('还有工作尚未结束，请处理后再安装。已下载的更新会暂时保留。'),
  update_service_unavailable: () => t('暂时无法确认任务状态，请稍后重试安装。'),
  update_shutdown_failed: () => t('尚未确认后台服务完全退出，更新未安装。请重启 Rivloom 后重试。'),
  update_backup_failed: () => t('应用数据备份未完成，更新未安装。请检查磁盘空间后重试。'),
  update_install_failed: () => t('安装程序未能启动，已保留原版本。请重试更新。'),
  update_install_incomplete: () => t('上次更新未完成，当前仍在使用原版本。可以重新检查并安装更新。'),
  update_cancelled: () => t('下载已取消。'),
  update_disabled: () => t('当前运行环境不支持应用内更新。'),
};
function updateError(code: string | null) {
  return code ? messages[code]?.() || t('更新未完成，请稍后重试。') : '';
}
const byteLabel = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function DesktopUpdateProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<DesktopUpdateSnapshot | null>(null);
  const [visible, setVisible] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [requestError, setRequestError] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const snapshotRef = useRef(snapshot);
  const prompted = useRef<string | null>(null);
  const mounted = useRef(true);
  const inAction = useRef(false);

  const apply = (value: DesktopUpdateSnapshot) => {
    if (!mounted.current) return;
    if (snapshotRef.current && value.revision < snapshotRef.current.revision) return;
    const previous = snapshotRef.current;
    snapshotRef.current = value; setSnapshot(value); setUnavailable(false);
    if ((!previous && ['update_install_incomplete', 'update_install_failed', 'update_shutdown_failed', 'update_backup_failed'].includes(value.error || '')) ||
      (inAction.current && value.error && value.error !== 'update_cancelled')) setVisible(true);
    if (shouldPromptForUpdate(value) && prompted.current !== value.release!.version) {
      prompted.current = value.release!.version; setVisible(true);
    }
  };
  useEffect(() => {
    mounted.current = true;
    if (!desktop) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const value = await desktopUpdateSnapshot(); if (!stopped) apply(value); }
      catch { if (!stopped) setUnavailable(true); }
      if (!stopped) timer = setTimeout(() => void poll(), snapshotRef.current && updateIsBusy(snapshotRef.current.phase) ? 700 : 15_000);
    };
    void poll();
    return () => { stopped = true; mounted.current = false; clearTimeout(timer); };
  }, []);

  const run = async (operation: () => Promise<DesktopUpdateSnapshot>, optimistic?: DesktopUpdateSnapshot['phase']) => {
    if (inAction.current) return;
    inAction.current = true; setActionBusy(true); setRequestError('');
    if (optimistic && snapshotRef.current) setSnapshot({ ...snapshotRef.current, phase: optimistic, error: null });
    // Fetch progress while a long native invocation is outstanding, independent of the idle poll.
    const progress = setInterval(() => void desktopUpdateSnapshot().then(apply).catch(() => undefined), 700);
    try { apply(await operation()); }
    catch { if (mounted.current) { setRequestError(t('更新未完成，请稍后重试。')); await desktopUpdateSnapshot().then(apply).catch(() => undefined); } }
    finally { clearInterval(progress); inAction.current = false; if (mounted.current) setActionBusy(false); }
  };
  const check = () => {
    setVisible(true);
    void run(checkDesktopUpdate, 'checking');
  };
  const close = () => {
    if (snapshot?.phase === 'preparing' || snapshot?.phase === 'installing') return;
    if (snapshot?.phase === 'available' && snapshot.release) {
      // Closing an offer has the same meaning as the explicit Skip this version action.
      void run(async () => { const value = await skipDesktopUpdate(); if (!value.error) setVisible(false); return value; });
    } else setVisible(false);
  };
  const download = () => void run(async () => {
    const value = await downloadDesktopUpdate(); apply(value);
    return value.phase === 'ready' && !value.error ? installDesktopUpdate() : value;
  }, 'downloading');
  const cancel = () => {
    void cancelDesktopUpdate().then(apply).catch(() => setRequestError(t('取消下载未完成，请重试。')));
  };
  const busy = actionBusy || !!snapshot && updateIsBusy(snapshot.phase);
  const phase = snapshot?.phase;
  const percent = snapshot ? updateDownloadPercent(snapshot) : null;
  const failure = requestError || updateError(snapshot?.error || null);

  return <UpdateContext.Provider value={{ snapshot, check, open: () => setVisible(true), unavailable }}>
    {children}
    {desktop && visible && <Modal title={snapshot?.release ? t('Rivloom 有新版本') : t('软件更新')} close={close}
      subtitle={snapshot?.release ? t('当前 {{current}} → 新版本 {{next}}', { current: snapshot.currentVersion, next: snapshot.release.version }) : undefined}>
      <div className="desktop-update" aria-live="polite">
        {(!snapshot && !unavailable && !failure) || phase === 'checking' ? <p className="desktop-update-state"><LoaderCircle size={19} className="spin" />{t('正在检查官网版本…')}</p> :
          phase === 'disabled' ? <p>{t('当前运行环境不支持应用内更新。')}</p> :
          phase === 'idle' && !failure ? <p className="desktop-update-state"><CircleCheck size={20} />{t('已是最新版本。')}</p> : null}
        {snapshot?.release?.notes && <div className="desktop-update-notes"><h3>{t('更新内容')}</h3><p>{snapshot.release.notes}</p></div>}
        {snapshot?.release && !['downloading', 'preparing', 'installing'].includes(phase || '') &&
          <p className="desktop-update-note">{t('更新会保留你的任务、模型设置和配对设备。安装完成后将重新打开 Rivloom。')}</p>}
        {phase === 'downloading' && snapshot && <div className="desktop-update-download">
          <p><span>{t('正在下载更新…')}</span><strong>{percent === null ? byteLabel(snapshot.downloadedBytes) : `${percent}%`}</strong></p>
          <progress aria-label={t('更新下载进度')} max={100} value={percent ?? undefined} />
          <small>{byteLabel(snapshot.downloadedBytes)}{snapshot.totalBytes ? ` / ${byteLabel(snapshot.totalBytes)}` : ''}</small>
        </div>}
        {phase === 'preparing' && <p className="desktop-update-state"><LoaderCircle size={19} className="spin" />{t('正在确认任务状态并备份应用数据…')}</p>}
        {phase === 'installing' && <p className="desktop-update-state"><LoaderCircle size={19} className="spin" />{t('正在启动安装，Rivloom 即将关闭…')}</p>}
        {failure && <p className="error" role="alert">{failure}</p>}
        {unavailable && <p className="error" role="alert">{t('暂时无法读取更新状态，请重试。')}</p>}
        {snapshot?.blockers && <ul className="desktop-update-blockers">
          {snapshot.blockers.tasks > 0 && <li>{t('{{count}} 个执行或待处理任务', { count: snapshot.blockers.tasks })}</li>}
          {snapshot.blockers.queues > 0 && <li>{t('{{count}} 个队列任务', { count: snapshot.blockers.queues })}</li>}
          {snapshot.blockers.workflows > 0 && <li>{t('{{count}} 个未结束的工作流', { count: snapshot.blockers.workflows })}</li>}
          {snapshot.blockers.remoteTasks + snapshot.blockers.brainTasks > 0 && <li>{t('{{count}} 个未结束的跨机任务或回执', { count: snapshot.blockers.remoteTasks + snapshot.blockers.brainTasks })}</li>}
          {snapshot.blockers.transfers + snapshot.blockers.operations + snapshot.blockers.modelChecks > 0 && <li>{t('还有传输、请求或模型连接测试正在进行。')}</li>}
        </ul>}
        <div className="modal-actions desktop-update-actions">
          {phase === 'downloading' ? <><Button onClick={close}>{t('后台下载')}</Button><Button onClick={cancel}>{t('取消下载')}</Button></> :
            phase === 'preparing' || phase === 'installing' ? null :
            snapshot?.release ? <>
              <Button disabled={busy} onClick={() => void run(async () => { const value = await skipDesktopUpdate(); if (!value.error) setVisible(false); return value; })}>{t('跳过此版本')}</Button>
              {phase === 'ready' ? <Button disabled={busy} variant="primary" onClick={() => void run(installDesktopUpdate, 'preparing')}><RotateCw size={15} />{t('重试安装')}</Button> :
                <Button disabled={busy} variant="primary" onClick={download}><ArrowDownToLine size={15} />{t('下载并安装')}</Button>}
            </> : <Button disabled={busy} onClick={check}><RotateCw size={15} />{t('检查更新')}</Button>}
        </div>
      </div>
    </Modal>}
  </UpdateContext.Provider>;
}

export function DesktopUpdateSettings() {
  const value = useContext(UpdateContext);
  if (!desktop || !value) return null;
  const { snapshot, check, open, unavailable } = value;
  return <section className="desktop-update-settings" aria-label={t('软件更新')}>
    <div><strong>{t('软件更新')}</strong><Button disabled={!!snapshot && updateIsBusy(snapshot.phase)} onClick={check}><RotateCw size={14} />{t('检查更新')}</Button></div>
    <p>{t('启动时及每 6 小时自动检查官网版本。')}</p>
    {snapshot?.lastCheckedAt && <small>{t('上次检查：{{time}}', { time: new Date(snapshot.lastCheckedAt).toLocaleString() })}</small>}
    {snapshot?.skippedVersion && <small>{t('已跳过 {{version}}；手动检查仍可更新。', { version: snapshot.skippedVersion })}</small>}
    {snapshot?.release && <button type="button" className="text-button" onClick={open}>{t('查看 {{version}} 更新', { version: snapshot.release.version })}</button>}
    {snapshot?.error && <p className="error">{updateError(snapshot.error)}</p>}
    {unavailable && <p className="error">{t('暂时无法读取更新状态，请重试。')}</p>}
  </section>;
}
