import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { signalQuality } from '../format';
import { t } from '../i18n';
import { Trans } from '../i18n/Trans';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Dialogs that are open, newest last: Escape and the focus guard only act for the top one. */
const openDialogs: symbol[] = [];
const isTop = (id: symbol) => openDialogs[openDialogs.length - 1] === id;

/**
 * A dialog over the whole page. It's rendered into <body> (a portal), so a card or panel it's opened from can't trap it:
 * their backdrop-filter or transform would otherwise make the dimmed backdrop cover only that card.
 */
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: ReactNode;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const dialog = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const [id] = useState(() => Symbol('dialog'));
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    openDialogs.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isTop(id)) return;
      e.preventDefault();
      close.current();
    };
    // Focus that wanders out of the top dialog (a click on the page behind, a screen reader) is brought back.
    const onFocus = (e: FocusEvent) => {
      const el = dialog.current;
      if (el?.isConnected && isTop(id) && e.target instanceof Node && !el.contains(e.target)) el.focus({ preventScroll: true });
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocus);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocus);
      const i = openDialogs.indexOf(id);
      if (i !== -1) openDialogs.splice(i, 1);
    };
  }, [id]);

  // Focus moves into the dialog when it opens and back to whatever opened it when it closes.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = dialog.current;
    if (el && !el.contains(document.activeElement)) {
      const first = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].find((x) => !x.classList.contains('modal-close'));
      (first ?? el).focus({ preventScroll: true });
    }
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  // Tab and Shift+Tab stay inside the dialog.
  const trap = (e: ReactKeyboardEvent) => {
    if (e.key !== 'Tab' || !dialog.current) return;
    const items = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialog}
        className={`modal${wide ? ' wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={trap}
      >
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <h2 className="spacer" id={titleId}>
            {title}
          </h2>
          <button type="button" className="icon-btn modal-close" onClick={onClose} aria-label={t('Close')}>
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function Confirm({
  title,
  body,
  confirm,
  danger = false,
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  confirm: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <div className="muted">{body}</div>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          {t('Cancel')}
        </button>
        <button
          type="button"
          className={`btn ${danger ? 'danger' : 'primary'}`}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
              onClose();
            } finally {
              setBusy(false);
            }
          }}
        >
          {confirm}
        </button>
      </div>
    </Modal>
  );
}

export function Switch({
  on,
  onChange,
  disabled,
  label,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      className={`switch${on ? ' on' : ''}`}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!on);
      }}
    />
  );
}

export function SignalBars({ rssi }: { rssi: number | null | undefined }) {
  const q = signalQuality(rssi);
  const level = q?.level ?? 0;
  const tone = q?.quality === 'very-weak' ? ' very-weak' : q?.quality === 'weak' ? ' weak' : '';
  return (
    <span className={`signal-bars${tone}`} role="img" aria-label={q ? t('Signal: {quality}', { quality: q.label }) : t('Signal unknown')}>
      {[0.35, 0.55, 0.78, 1].map((h, i) => (
        <i key={h} className={i < level ? 'on' : ''} style={{ height: `${h * 100}%` }} />
      ))}
    </span>
  );
}

export function BatteryBar({ percent }: { percent: number | null | undefined }) {
  const p = Math.max(0, Math.min(100, percent ?? 0));
  return (
    <div className={`battery-bar${p < 20 ? ' low' : ''}`} aria-hidden="true">
      <i style={{ width: `${p}%` }} />
    </div>
  );
}

export function OwnerOnly({ isOwner, children }: { isOwner: boolean; children: ReactNode }) {
  if (isOwner) return <>{children}</>;
  return (
    <p className="hint">
      <Trans
        text={t('{signIn} to make changes.')}
        values={{
          signIn: (
            <a href="#/settings" style={{ textDecoration: 'underline' }}>
              {t('Sign in with the owner PIN')}
            </a>
          ),
        }}
      />
    </p>
  );
}

export function Skeleton({ height = '12rem' }: { height?: string }) {
  return <div className="skeleton" style={{ height }} />;
}
