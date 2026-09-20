import { t } from '../shared/i18n.ts';
import { primaryShortcut } from './keyboard-platform.ts';
import { normalizeComposerSendMode, type ComposerSendMode } from './composer-keyboard.ts';

export function ComposerSendPreference({ value, onChange, disabled = false }: {
  value: ComposerSendMode;
  onChange: (value: ComposerSendMode) => void;
  disabled?: boolean;
}) {
  return <label className="field composer-send-preference">
    <span>{t('发送快捷键')}</span>
    <select value={value} disabled={disabled} onChange={(event) => onChange(normalizeComposerSendMode(event.target.value))}>
      <option value="enter">{t('Enter 发送')}</option>
      <option value="ctrl-enter">{t('{{shortcut}} 发送', { shortcut: primaryShortcut('Enter') })}</option>
    </select>
    <small>{t('Shift + Enter 始终换行；选择设备或输入法候选时不会发送。')}</small>
  </label>;
}
