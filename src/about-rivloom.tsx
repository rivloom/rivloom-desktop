import { useEffect, useState } from 'react';
import { Info, LoaderCircle, RotateCw } from 'lucide-react';
import { t } from '../shared/i18n.ts';
import { displayVersion, installedVersion } from './app-version';
import { CopyButton } from './copy-button';
import { desktop, desktopInfo } from './desktop';
import { Modal } from './ui';
import './about-rivloom.css';

export type RivloomVersionState =
  { status: 'loading' | 'unavailable' | 'preview' } | { status: 'ready'; version: string };

export type RivloomVersion = {
  state: RivloomVersionState;
  retry: () => void;
};

export function useRivloomVersion(): RivloomVersion {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<RivloomVersionState>({
    status: desktop ? 'loading' : 'preview',
  });

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    setState({ status: 'loading' });
    void desktopInfo()
      .then((info) => {
        const version = installedVersion(info);
        if (!cancelled)
          setState(version ? { status: 'ready', version } : { status: 'unavailable' });
      })
      .catch(() => {
        // Native errors can include local details. Show a fixed, localized failure message.
        if (!cancelled) setState({ status: 'unavailable' });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return { state, retry: () => setAttempt((previous) => previous + 1) };
}

function versionLabel(state: RivloomVersionState) {
  if (state.status === 'ready') return state.version;
  if (state.status === 'preview') return t('浏览器预览');
  if (state.status === 'loading') return t('读取版本…');
  return t('版本不可用');
}

/** A small clickable replacement for the sidebar's fixed version text. */
export function AboutRivloomEntry({
  version,
  onClick,
}: {
  version: RivloomVersion;
  onClick: () => void;
}) {
  const { state } = version;
  return (
    <button
      type="button"
      className="about-rivloom-entry"
      onClick={onClick}
      aria-label={t('关于 Rivloom')}
      title={t('关于 Rivloom')}
    >
      {state.status === 'loading' ? (
        <LoaderCircle size={13} className="spin" />
      ) : (
        <Info size={13} />
      )}
      <span>{versionLabel(state)}</span>
    </button>
  );
}

export function AboutRivloom({
  version,
  engineVersion,
  close,
}: {
  version: RivloomVersion;
  engineVersion: string;
  close: () => void;
}) {
  const { state, retry } = version;
  const engine = displayVersion(engineVersion) || t('暂不可用');
  const app = versionLabel(state);
  const summary = state.status === 'loading' ? '' : `Rivloom: ${app}\nOpenCode: ${engine}`;

  return (
    <Modal title={t('关于 Rivloom')} close={close}>
      <div className="about-rivloom">
        <dl className="about-rivloom-versions">
          <div>
            <dt>Rivloom</dt>
            <dd aria-live="polite">
              {state.status === 'loading' && <LoaderCircle size={15} className="spin" />}
              {app}
            </dd>
          </div>
          <div>
            <dt>OpenCode</dt>
            <dd>{engine}</dd>
          </div>
        </dl>
        {state.status === 'preview' && (
          <p className="about-rivloom-note">{t('当前是浏览器预览，无法读取已安装的桌面版本。')}</p>
        )}
        {state.status === 'unavailable' && (
          <div className="about-rivloom-unavailable" role="status">
            <p>{t('暂时无法读取桌面版本，请重试。')}</p>
            <button type="button" className="text-button" onClick={retry}>
              <RotateCw size={14} />
              {t('重新读取')}
            </button>
          </div>
        )}
        <div className="modal-actions about-rivloom-actions">
          <CopyButton text={summary} label={t('复制版本信息')} className="about-rivloom-copy" />
        </div>
      </div>
    </Modal>
  );
}
