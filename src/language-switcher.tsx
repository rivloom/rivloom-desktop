import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Languages } from 'lucide-react';
import { language, systemText, t, type Locale } from '../shared/i18n';
import { changeLanguage } from './i18n';

export function LanguageSwitcher() {
  useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className="language-control">
      <label>
        <Languages size={16} />
        <span>{t('界面语言')}</span>
        <select
          aria-label={t('界面语言')}
          value={language()}
          disabled={busy}
          onChange={async (event) => {
            const next = event.target.value as Locale;
            setBusy(true);
            setError('');
            try {
              await changeLanguage(next);
            } catch {
              setError('语言设置未能保存，请重试。');
            } finally {
              setBusy(false);
            }
          }}
        >
          <option value="zh-CN" lang="zh-CN">
            简体中文
          </option>
          <option value="en" lang="en">
            English
          </option>
        </select>
      </label>
      {error && <small role="alert">{systemText(error)}</small>}
    </div>
  );
}
