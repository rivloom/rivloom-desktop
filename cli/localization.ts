import chinese from './locales/zh-CN.json' with { type: 'json' };
import { i18n, language, systemText } from '../shared/i18n.ts';

export type CliLocale = 'en' | 'zh-CN';
let current: CliLocale = 'en';
const catalog: Record<string, string> = chinese;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const templates = Object.entries(catalog).filter(([key]) => key.includes('{{')).sort(([a], [b]) => b.length - a.length).map(([key, value]) => {
  const slots: string[] = []; let offset = 0, expression = '';
  for (const part of key.matchAll(/\{\{(\w+)\}\}/g)) {
    expression += escape(key.slice(offset, part.index)) + '([\\s\\S]*?)'; slots.push(part[1]); offset = part.index! + part[0].length;
  }
  return { pattern: new RegExp('^' + expression + escape(key.slice(offset)) + '$'), slots, value };
});

/** Strip only the global language option; preserve option values and everything after --. */
export function prepareCliArguments(argv: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  current = /^zh(?:[-_.]|$)/i.test(env.LC_ALL || env.LC_MESSAGES || env.LANG || '') ? 'zh-CN' : 'en';
  const values = new Set(['--data-dir', '--name', '--code', '--account', '--account-id', '--project', '--model', '--approval', '--thinking', '--executable', '--peer-port']);
  const args: string[] = []; let seen = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') { args.push(...argv.slice(index)); break; }
    if (arg === '--lang') {
      if (seen) throw new Error('Duplicate option --lang');
      seen = true; const value = argv[++index];
      if (value !== 'en' && value !== 'zh-CN') throw new Error('--lang must be en or zh-CN.');
      current = value; continue;
    }
    args.push(arg);
    if (values.has(arg) && argv[index + 1] && !argv[index + 1].startsWith('--')) args.push(argv[++index]);
  }
  return { args, locale: current };
}

export function cliText(text: string, locale: CliLocale = current): string {
  if (locale === 'en') return text;
  if (Object.hasOwn(catalog, text)) return catalog[text];
  if (text.length > 8192) return text;
  for (const { pattern, slots, value } of templates) {
    const match = pattern.exec(text); if (!match) continue;
    return value.replace(/\{\{(\w+)\}\}/g, (_, slot: string) => match[slots.indexOf(slot) + 1]);
  }
  return text;
}

export function cliHelp(text: string, locale: CliLocale = current): string {
  return text.split('\n').map(line => {
    const entry = line.match(/^(\s*\S.*?\s{2,})(\S.*)$/);
    return entry ? entry[1] + cliText(entry[2], locale) : line.replace(/\S.*$/, value => cliText(value, locale));
  }).join('\n');
}

/** Only an application-owned API error field; never translate JSON keys, model output or user names. */
export function cliSystemText(text: string): string {
  const previous = language(); void i18n.changeLanguage(current);
  try { return systemText(text); } finally { void i18n.changeLanguage(previous); }
}
