import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { t } from '../shared/i18n.ts';
import { searchExcerpt, searchTextParts, type SearchMatch, type SearchTarget } from './conversation-search';
import './conversation-search.css';

export function SearchText({ text, query = '' }: { text: string; query?: string }) {
  return <>{searchTextParts(text, query).map((part, i) => part.match ? <mark className="search-highlight" key={i}>{part.text}</mark> : part.text)}</>;
}

export function searchMatchLabel(match: Pick<SearchMatch, 'target' | 'round'>): string {
  const labels: Record<SearchTarget['kind'], string> = {
    requirement: t('需求正文'), response: t('执行结果'), plan: t('计划说明'), step: t('步骤结果'),
    queued: t('待执行消息'), message: t('回答正文'), summary: t('执行结果'), title: t('会话标题'),
    device: t('设备名称'), directory: t('工作目录'),
  };
  const parts = [match.round ? t('第 {{count}} 轮', { count: match.round }) : '', labels[match.target.kind],
    match.target.kind === 'step' ? t('第 {{count}} 次执行', { count: match.target.attempt }) : ''];
  return parts.filter(Boolean).join(' · ');
}

export function SearchNavigation({ query, matches, activeID, select, close }: {
  query: string; matches: SearchMatch[]; activeID: string; select: (match: SearchMatch) => void; close: () => void;
}) {
  const index = matches.findIndex((match) => match.id === activeID), match = matches[index];
  if (!match) return null;
  return <section className="conversation-search-navigation" aria-label={t('会话内搜索结果')}>
    <div className="search-navigation-text" aria-live="polite">
      <strong>{t('{{current}} / {{total}} 个匹配片段', { current: index + 1, total: matches.length })}<span>{searchMatchLabel(match)}</span></strong>
      <p><SearchText text={searchExcerpt(match, 60)} query={query} /></p>
    </div>
    <div className="search-navigation-buttons">
      <button type="button" className="icon-button" aria-label={t('上一处匹配')} title={t('上一处匹配')} disabled={matches.length < 2}
        onClick={() => select(matches[(index + matches.length - 1) % matches.length])}><ChevronUp size={16} /></button>
      <button type="button" className="icon-button" aria-label={t('下一处匹配')} title={t('下一处匹配')} disabled={matches.length < 2}
        onClick={() => select(matches[(index + 1) % matches.length])}><ChevronDown size={16} /></button>
      <button type="button" className="icon-button" aria-label={t('退出匹配定位')} title={t('退出匹配定位')} onClick={close}><X size={15} /></button>
    </div>
  </section>;
}
