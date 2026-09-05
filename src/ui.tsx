import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import symbolGradient from './assets/brand/rivloom-symbol-gradient.png';
import symbolWhite from './assets/brand/rivloom-symbol-white.png';
import wordmark from './assets/brand/rivloom-wordmark.png';

export function Mark({ variant = 'gradient' }: { variant?: 'gradient' | 'white' }) {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg
        className="rivloom-symbol"
        viewBox={variant === 'white' ? '312 223 645 851' : '325 211 675 851'}
        width="32"
        height="40"
        focusable="false"
      >
        <image
          href={variant === 'white' ? symbolWhite : symbolGradient}
          width="1254"
          height="1254"
        />
      </svg>
    </span>
  );
}

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
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="modal conversation-modal" onCancel={close}>
      <div className="modal-heading">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button className="icon-button" onClick={close} aria-label="关闭">
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
