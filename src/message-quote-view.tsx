import { useEffect, useState } from 'react';
import { t } from '../shared/i18n';
import { SearchText } from './conversation-search-view';
import { splitQuotedMessage, type MessageQuote } from './message-quote';
import { MessageMarkdown } from './message-markdown';

export function MessageQuoteCard({ quote, remove, disabled = false, searchQuery = '' }: {
  quote: MessageQuote; remove?: () => void; disabled?: boolean; searchQuery?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [quote.text, quote.author]);
  const long = quote.text.length > 160 || quote.text.split('\n').length > 3;
  return <aside className={`message-quote-card${remove ? ' composer-quote' : ''}`} aria-label={remove ? t('待发送的引用') : t('引用内容')}>
    <header><strong>{t('引用 {{name}}', { name: quote.author === 'assistant' ? 'Rivloom' : t('你') })}</strong>
      <span>{long && <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? t('收起') : t('查看全文')}</button>}
        {remove && <button type="button" disabled={disabled} onClick={remove}>{t('移除引用')}</button>}</span></header>
    <div className={`message-quote-content${expanded || searchQuery ? ' expanded' : long ? ' collapsed' : ''}`}>{quote.author === 'assistant'
      ? <MessageMarkdown text={quote.text} searchQuery={searchQuery} compact /> : <SearchText text={quote.text} query={searchQuery} />}</div>
  </aside>;
}

export function UserMessageText({ text, searchQuery = '' }: { text: string; searchQuery?: string }) {
  const value = splitQuotedMessage(text);
  return <div className="user-message-body">{value.quote && <MessageQuoteCard quote={value.quote} searchQuery={searchQuery} />}
    <div className="chat-message-text"><SearchText text={value.text} query={searchQuery} /></div></div>;
}
