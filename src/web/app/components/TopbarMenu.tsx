import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

/**
 * An icon button in the top bar that opens a small panel under it. A click or Tab outside it, Escape or moving to
 * another page closes it again.
 */
export function TopbarMenu({
  label,
  icon,
  className,
  buttonClassName,
  badge,
  children,
}: {
  label: string;
  icon: IconName;
  className?: string;
  /** More classes for the button (a glow, say). */
  buttonClassName?: string;
  /** Shown on the button's corner (a count). */
  badge?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    const onRoute = () => setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', onRoute);
    wrap.current?.querySelector<HTMLElement>('.menu-pop button, .menu-pop a')?.focus();
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('hashchange', onRoute);
    };
  }, [open]);

  return (
    <div
      className="menu-wrap"
      ref={wrap}
      onBlur={(e) => {
        if (open && e.relatedTarget && !wrap.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        ref={button}
        type="button"
        className={buttonClassName ? `btn icon ghost menu-btn ${buttonClassName}` : 'btn icon ghost menu-btn'}
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name={icon} size={20} />
        {badge}
      </button>
      {open && (
        <div id={id} className={className ? `menu-pop ${className}` : 'menu-pop'} role="group" aria-label={label}>
          {children}
        </div>
      )}
    </div>
  );
}
