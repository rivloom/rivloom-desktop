import { useEffect, useRef, useState } from 'react';
import { Check, Copy, LoaderCircle } from 'lucide-react';
import { t } from '../shared/i18n.ts';
import './copy-button.css';

export function CopyButton({
  text,
  label,
  className = '',
}: {
  text: string;
  label: string;
  className?: string;
}) {
  const [state, setState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const request = useRef(0);
  useEffect(() => {
    request.current++;
    setState('idle');
    return () => {
      request.current++;
    };
  }, [text]);
  useEffect(() => {
    if (state !== 'copied') return;
    const timer = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  async function copy() {
    if (!text.trim() || state === 'copying') return;
    const current = ++request.current;
    setState('copying');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      if (request.current === current) setState('copied');
    } catch {
      if (request.current === current) setState('failed');
    }
  }
  return (
    <span className={`copy-control ${className}`}>
      <button
        type="button"
        className="copy-button"
        onClick={() => void copy()}
        disabled={!text.trim() || state === 'copying'}
        aria-label={label}
        title={label}
      >
        {state === 'copied' ? (
          <Check size={13} />
        ) : state === 'copying' ? (
          <LoaderCircle className="spin" size={13} />
        ) : (
          <Copy size={13} />
        )}
        <span>
          {state === 'copied' ? t('已复制') : state === 'failed' ? t('重试复制') : t('复制')}
        </span>
      </button>
      <span
        className={state === 'failed' ? 'copy-feedback' : 'copy-announcement'}
        role="status"
        aria-live="polite"
      >
        {state === 'copied'
          ? t('已复制到剪贴板')
          : state === 'failed'
            ? t('复制失败，请选中文字后按 Ctrl+C。')
            : ''}
      </span>
    </span>
  );
}
