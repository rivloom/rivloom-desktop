import { createInstance } from 'i18next';
import chinese from './locales/zh-CN.json' with { type: 'json' };
import english from './locales/en.json' with { type: 'json' };
import systemEnglish from './locales/system-en.json' with { type: 'json' };

export const supportedLocales = ['zh-CN', 'en'] as const;
export type Locale = (typeof supportedLocales)[number];
export function normalizeLocale(value: unknown): Locale {
  return typeof value === 'string' && /^en(?:[-_]|$)/i.test(value) ? 'en' : 'zh-CN';
}

// A separate instance lives in each process. The service keeps source-language
// messages; only the browser changes its instance's language.
export const i18n = createInstance();
void i18n.init({
  lng: 'zh-CN',
  fallbackLng: 'zh-CN',
  supportedLngs: [...supportedLocales],
  initAsync: false,
  keySeparator: false,
  nsSeparator: false,
  defaultNS: 'ui',
  returnNull: false,
  returnEmptyString: false,
  interpolation: { escapeValue: false }, // React escapes rendered text.
  resources: { 'zh-CN': { ui: chinese }, en: { ui: english } },
});
export const language = (): Locale => normalizeLocale(i18n.resolvedLanguage || i18n.language);
export const t = (source: string, values: Record<string, unknown> = {}): string =>
  String(i18n.t(source, { ...values, ns: 'ui' }));

const englishMessages: Record<string, string> = { ...english, ...systemEnglish };
const sourceForEnglish = new Map(
  Object.entries(englishMessages).map(([source, translation]) => [translation, source]),
);
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function matcher(text: string) {
  const slots: string[] = [];
  let expression = '',
    offset = 0;
  for (const match of text.matchAll(/\{\{(\w+)\}\}/g)) {
    expression += escapeRegExp(text.slice(offset, match.index)) + '([\\s\\S]*?)';
    slots.push(match[1]);
    offset = match.index! + match[0].length;
  }
  return { regex: new RegExp('^' + expression + escapeRegExp(text.slice(offset)) + '$'), slots };
}
const templates = Object.entries(englishMessages)
  .filter(([source]) => source.includes('{{'))
  .sort(
    ([left], [right]) =>
      right.replace(/\{\{\w+\}\}/g, '').length - left.replace(/\{\{\w+\}\}/g, '').length,
  )
  .map(([source, translation]) => ({
    source,
    translation,
    zh: matcher(source),
    en: matcher(translation),
  }));

/** Translate only application-owned status/error fields. Never use for user,
 * model, file, project, device-name, tool-output, or conversation text. Unknown
 * external errors pass through verbatim; captured values are never translated. */
export function systemText(value: string | null | undefined): string {
  if (!value) return '';
  const locale = language();
  if (Object.hasOwn(englishMessages, value))
    return locale === 'en' ? englishMessages[value] : value;
  const source = sourceForEnglish.get(value);
  if (source !== undefined) return locale === 'en' ? value : source;
  if (value.length > 8192) return value;
  for (const template of templates) {
    for (const input of [template.zh, template.en]) {
      const match = input.regex.exec(value);
      if (!match) continue;
      const values = Object.fromEntries(input.slots.map((slot, index) => [slot, match[index + 1]]));
      return (locale === 'en' ? template.translation : template.source).replace(
        /\{\{(\w+)\}\}/g,
        (_, slot: string) => values[slot],
      );
    }
  }
  return value;
}
