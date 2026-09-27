import { t } from '../shared/i18n.ts';
import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import wordmark from './assets/brand/rivloom-wordmark.png';

export function Wordmark() {
  return (
    <svg
      className="rivloom-wordmark"
      viewBox="64 344 1332 412"
      width="118"
      height="37"
      role="img"
      aria-label="Rivloom"
      focusable="false"
    >
      <image href={wordmark} width="1448" height="1086" />
    </svg>
  );
}
export function Button({
  children,
  onClick,
  variant = '',
  disabled = false,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: string;
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  return (
    <button type={type} className={`button ${variant}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}
export function Modal({
  title,
  subtitle,
  children,
  close,
  className = '',
  returnFocus,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  close: () => void;
  className?: string;
  returnFocus?: HTMLElement | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleID = useId();
  const subtitleID = useId();
  useLayoutEffect(() => {
    const dialog = ref.current;
    const previous = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    dialog?.showModal();
    return () => {
      // Removing an open dialog does not reliably restore focus in WebView2.
      if (dialog?.open) dialog.close();
      if (previous?.isConnected && !previous.closest('[inert]') &&
        (document.activeElement === document.body || dialog?.contains(document.activeElement)))
        previous.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog ref={ref} className={`modal conversation-modal ${className}`} onCancel={(event) => { event.preventDefault(); event.stopPropagation(); close(); }} aria-labelledby={titleID} aria-describedby={subtitle ? subtitleID : undefined}>
      <div className="modal-heading">
        <div>
          <h2 id={titleID}>{title}</h2>
          {subtitle && <p id={subtitleID} title={subtitle}>{subtitle}</p>}
        </div>
        <button type="button" className="icon-button" onClick={close} aria-label={t('关闭')}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
