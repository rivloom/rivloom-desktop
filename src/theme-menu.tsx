import { useState, useSyncExternalStore } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { t } from '../shared/i18n';
import { ContextMenu, useContextMenu } from './context-menu';
import { selectTheme, subscribeTheme, themeSnapshot, type ThemePreference } from './theme';

export function ThemeMenu({ className = '' }: { className?: string }) {
  const theme = useSyncExternalStore(subscribeTheme, themeSnapshot);
  const menu = useContextMenu();
  const [announced, setAnnounced] = useState(false);
  const choices: { id: ThemePreference; label: string; Icon: typeof Sun }[] = [
    { id: 'light', label: t('浅色'), Icon: Sun },
    { id: 'dark', label: t('深色'), Icon: Moon },
    { id: 'system', label: t('跟随系统'), Icon: Monitor },
  ];
  const Icon = theme.preference === 'system' ? Monitor : theme.resolved === 'dark' ? Moon : Sun;
  return <div className={`theme-control ${className}`}>
    <button type="button" className="workspace-tool theme-toggle" aria-label={t('外观')} title={t('外观')}
      {...menu.trigger} disabled={theme.saving}>
      <Icon size={16} aria-hidden="true" /><span>{t('外观')}</span>
    </button>
    <ContextMenu menu={menu} label={t('外观')}
      actions={choices.map(choice => ({ id: choice.id, label: choice.label,
        icon: <choice.Icon size={15} aria-hidden="true" />,
        checked: choice.id === theme.preference,
        select: () => { setAnnounced(true); void selectTheme(choice.id); },
      }))} />
    {theme.failed && <span className="theme-save-error" role="alert">{t('外观设置未能保存，请重试。')}</span>}
    <span className="theme-announcement" role="status" aria-live="polite">{announced && !theme.saving && !theme.failed ? choices.find(choice => choice.id === theme.preference)?.label : ''}</span>
  </div>;
}
