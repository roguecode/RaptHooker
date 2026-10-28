import type { CSSProperties } from 'react';
import { PALETTES, useTheme, type Palette } from '../theme';
import { t } from '../i18n';

/**
 * The colours for this browser, each with a dark and a light version. `compact` shows only the swatches. With `value`
 * and `onChange` it picks a palette for something else (a screen image) instead of this browser.
 */
export function PalettePicker({
  compact = false,
  value,
  onChange,
}: {
  compact?: boolean;
  value?: Palette;
  onChange?: (palette: Palette) => void;
}) {
  const theme = useTheme();
  const palette = value ?? theme.palette;
  const setPalette = onChange ?? theme.setPalette;
  return (
    <div className={`palette-picker${compact ? ' compact' : ''}`} role="group" aria-label={t('Colours')}>
      {PALETTES.map((p) => {
        const on = palette === p.id;
        const label = t(p.label);
        return (
          <button
            key={p.id}
            type="button"
            className={on ? 'on' : ''}
            aria-pressed={on}
            aria-label={compact ? label : undefined}
            title={compact ? label : undefined}
            onClick={() => setPalette(p.id)}
          >
            <span className="palette-swatch" style={{ '--swatch': p.swatch } as CSSProperties} aria-hidden="true" />
            {!compact && label}
          </button>
        );
      })}
    </div>
  );
}
