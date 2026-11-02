import { useState } from 'react';
import { SCREEN_PANEL, type ScreenDevice } from '@rapthooker/shared';
import { errorText } from '../../api';
import { useLive } from '../../live';
import { t, tk } from '../../i18n';
import { Icon } from '../../components/Icon';
import { screensApi } from './screensApi';

const FIXES = [
  { bit: SCREEN_PANEL.flip, label: tk('Turn it upside down') },
  { bit: SCREEN_PANEL.mirror, label: tk('Mirror it') },
  { bit: SCREEN_PANEL.swap, label: tk('Swap red and blue') },
  { bit: SCREEN_PANEL.invert, label: tk('Invert the colours') },
] as const;

/**
 * Checking a board's panel (models with `panel`): the screen shows a test pattern, and each fix turns, mirrors or
 * recolours it straight away. Boards sold under one name come with different panels, and a new batch may need these.
 */
export function PanelFix({ screen, compact = false }: { screen: ScreenDevice; compact?: boolean }) {
  const { upsertScreen, toast } = useLive();
  const [busy, setBusy] = useState(false);
  const [showing, setShowing] = useState(false);
  const panel = screen.panel ?? 0;

  const pattern = async () => {
    await screensApi.action(screen.id, 'test-pattern');
    setShowing(true);
  };
  const run = async (what: () => Promise<void>) => {
    setBusy(true);
    try {
      await what();
    } catch (err) {
      toast({ tone: 'error', title: t("The screen didn't answer"), body: errorText(err) });
    } finally {
      setBusy(false);
    }
  };
  const toggle = (bit: number) =>
    run(async () => {
      upsertScreen(await screensApi.patch(screen.id, { panel: panel ^ bit }));
      if (!showing) await pattern();
    });

  return (
    <fieldset className={`fieldset panel-fix${compact ? ' compact' : ''}`}>
      <legend>{t('Does the screen look right?')}</legend>
      <p className="hint">
        {t(
          'The test pattern has red at the top, words that read left to right and a black band at the bottom. If yours looks different, fix it here: each change shows straight away.',
        )}
      </p>
      <div className="row panel-fix-actions">
        <button type="button" className="btn small" disabled={busy} onClick={() => void run(pattern)}>
          <Icon name="screen" size={14} /> {showing ? t('Show the test pattern again') : t('Show the test pattern')}
        </button>
        {FIXES.map((f) => {
          const on = (panel & f.bit) !== 0;
          return (
            <button
              key={f.bit}
              type="button"
              className={`chip${on ? ' on' : ''}`}
              aria-pressed={on}
              disabled={busy}
              onClick={() => void toggle(f.bit)}
            >
              {t(f.label)}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
