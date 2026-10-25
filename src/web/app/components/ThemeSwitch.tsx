import { Icon } from './Icon';
import { THEME_OPTIONS, useTheme } from '../theme';
import { t } from '../i18n';

/** Auto (follows the system), Dark or Light, for this browser. */
export function ThemeSwitch() {
  const { pref, setPref } = useTheme();
  return (
    <div className="segmented" role="group" aria-label={t('Theme')}>
      {THEME_OPTIONS.map((o) => (
        <button key={o.id} type="button" className={pref === o.id ? 'on' : ''} aria-pressed={pref === o.id} onClick={() => setPref(o.id)}>
          <Icon name={o.icon} size={14} />
          {t(o.label)}
        </button>
      ))}
    </div>
  );
}
