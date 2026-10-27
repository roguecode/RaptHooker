import { useId, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

const STORE_KEY = 'rapthooker.panels';

function remembered(): Record<string, unknown> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
    return saved && typeof saved === 'object' ? (saved as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Whether a folding panel is open: as it was last left in this browser, or `initial`. */
export function usePanelOpen(name: string, initial: boolean): [open: boolean, toggle: () => void] {
  const [open, setOpen] = useState(() => {
    const saved = remembered()[name];
    return typeof saved === 'boolean' ? saved : initial;
  });
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ ...remembered(), [name]: !open }));
    } catch {
      // Storage turned off: it just isn't remembered.
    }
  };
  return [open, toggle];
}

/** A panel whose heading folds its content away. The badges, lead and actions stay in the heading either way. */
export function CollapsiblePanel({
  open,
  onToggle,
  title,
  badges,
  lead,
  actions,
  label,
  className,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  title: ReactNode;
  badges?: ReactNode;
  lead?: ReactNode;
  actions?: ReactNode;
  /** Names the panel as a region. */
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  const bodyId = useId();
  return (
    <section className={`panel collapsible${open ? ' open' : ''}${className ? ` ${className}` : ''}`} aria-label={label}>
      <div className="panel-head">
        <div>
          <h2>
            <button type="button" className="panel-toggle" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
              <Icon name="right" size={16} className="panel-chevron" />
              {title}
            </button>
            {badges}
          </h2>
          {lead && <p>{lead}</p>}
        </div>
        {actions && <div className="row">{actions}</div>}
      </div>
      <div id={bodyId} className="panel-body" hidden={!open}>
        {open && children}
      </div>
    </section>
  );
}
