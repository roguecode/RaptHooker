import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from './Icon';
import { ThemeSwitch } from './ThemeSwitch';
import { UnitSource, UnitToggles } from '../units';
import { LOCALES, t, useI18n, type LocaleId } from '../i18n';

/** The top bar's "⋮" menu: units, theme and language for this browser, and TV mode. */
export function DisplayMenu() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  const langId = useId();
  const { choice, setLocale } = useI18n();

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
        className="btn icon ghost menu-btn"
        aria-label={t('Display options')}
        title={t('Display options')}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="more" size={20} />
      </button>
      {open && (
        <div id={id} className="menu-pop" role="group" aria-label={t('Display options')}>
          <div className="menu-section">
            <span className="label">{t('Units in this browser')}</span>
            <UnitToggles />
            <UnitSource />
          </div>
          <div className="menu-section">
            <span className="label">{t('Theme in this browser')}</span>
            <ThemeSwitch />
          </div>
          <div className="menu-section">
            <label className="label row" style={{ gap: '0.35rem' }} htmlFor={langId}>
              <Icon name="languages" size={14} /> {t('Language')}
            </label>
            <select
              id={langId}
              className="select"
              value={choice ?? ''}
              onChange={(e) => setLocale((e.target.value || null) as LocaleId | null)}
            >
              <option value="">{t('Automatic (browser)')}</option>
              {LOCALES.map((l) => (
                <option key={l.id} value={l.id} lang={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
          <a className="menu-item" href="#/kiosk">
            <Icon name="tv" /> {t('TV mode')}
            <span className="small faint">{t('Big readings for a spare screen')}</span>
          </a>
        </div>
      )}
    </div>
  );
}
