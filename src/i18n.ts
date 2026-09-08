import { invoke, isTauri } from '@tauri-apps/api/core';
import { i18n, language, normalizeLocale, type Locale } from '../shared/i18n';

const storageKey = 'rivloom.ui.language';
export async function initializeLanguage() {
  let selected: Locale = 'zh-CN';
  if (isTauri()) {
    try {
      const info = await invoke<{ locale: string }>('desktop_info');
      selected = normalizeLocale(info.locale);
    } catch {
      // Authentication/startup errors remain visible in the ordinary app flow.
    }
  } else {
    try {
      selected = normalizeLocale(localStorage.getItem(storageKey));
    } catch {
      /* Storage may be disabled. */
    }
  }
  await i18n.changeLanguage(selected);
  document.documentElement.lang = language();
}

export async function changeLanguage(locale: Locale) {
  if (locale !== 'zh-CN' && locale !== 'en') throw new Error('Unsupported language');
  if (isTauri()) {
    await invoke('set_desktop_language', { locale });
  } else {
    // Do not claim restart persistence when browser storage refuses the write.
    localStorage.setItem(storageKey, locale);
  }
  await i18n.changeLanguage(locale);
  document.documentElement.lang = locale;
}
