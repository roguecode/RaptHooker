import { useId } from 'react';
import { Icon } from './Icon';
import { ThemeSwitch } from './ThemeSwitch';
import { PalettePicker } from './PalettePicker';
import { TopbarMenu } from './TopbarMenu';
import { UnitSource, UnitToggles } from '../units';
import { LOCALES, t, useI18n, type LocaleId } from '../i18n';

/** The top bar's "⋮" menu: units, theme and language for this browser, and TV mode. */
export function DisplayMenu() {
  return (
    <TopbarMenu label={t('Display options')} icon="more">
      <DisplayOptions />
    </TopbarMenu>
  );
}

function DisplayOptions() {
  const langId = useId();
  const { choice, setLocale } = useI18n();
  return (
    <>
      <div className="menu-section">
        <span className="label">{t('Units in this browser')}</span>
        <UnitToggles />
        <UnitSource />
      </div>
      <div className="menu-section">
        <span className="label">{t('Theme in this browser')}</span>
        <ThemeSwitch />
        <PalettePicker compact />
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
    </>
  );
}
