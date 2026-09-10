import { memo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { CopyButton } from './copy-button';
import { i18n, t } from '../shared/i18n.ts';
import './message-markdown.css';

function plainText(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(plainText).join('');
  if (value && typeof value === 'object' && 'props' in value) return plainText((value.props as { children?: ReactNode }).children);
  return '';
}
export const MessageMarkdown = memo(function MessageMarkdown({ text }: { text: string }) {
  useTranslation('ui', { i18n });
  return <div className="message-markdown"><Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} skipHtml components={{
    a: ({ href, children }) => href && /^https?:\/\//i.test(href)
      ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
    img: ({ alt }) => <span className="markdown-image-label">{alt || t('图片')}</span>,
    pre: ({ children }) => <div className="markdown-code"><div className="markdown-code-toolbar"><span>{t('代码')}</span>
      <CopyButton text={plainText(children).replace(/\n$/, '')} label={t('复制代码')} /></div><pre>{children}</pre></div>,
    table: ({ children }) => <div className="markdown-table"><table>{children}</table></div>,
  }}>{text}</Markdown></div>;
});
