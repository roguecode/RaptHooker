import { useCallback, useState } from 'react';
import type { ChartExclusion, Pill } from '@rapthooker/shared';
import { api, errorText } from '../api';
import { useLive } from '../live';
import { dateTime } from '../format';
import { t } from '../i18n';
import { Icon } from './Icon';
import { Confirm } from './ui';
import type { TimeWindow } from './chartMath';

const SHOW_KEY = 'rapthooker.exclusions';

/** Whether charts leave out the excluded ranges (on unless turned off in this browser). */
export function useShowExclusions(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(SHOW_KEY) !== 'off';
    } catch {
      return true;
    }
  });
  const set = useCallback((next: boolean) => {
    setOn(next);
    try {
      localStorage.setItem(SHOW_KEY, next ? 'on' : 'off');
    } catch {}
  }, []);
  return [on, set];
}

/** The chart option that switches between the excluded ranges' curves and the readings themselves. */
export function ExclusionsToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      className={`chip${on ? ' on' : ''}`}
      aria-pressed={on}
      title={on ? t('Excluded ranges are drawn as curves. Turn off to see the readings.') : t('Turn on to leave the excluded ranges out.')}
      onClick={() => onChange(!on)}
    >
      <Icon name="eyeOff" size={12} /> {t('Exclusions')}
    </button>
  );
}

/** "Exclude this range" for a zoomed-in chart: asks first, then leaves the range out of the device's charts. */
export function ExcludeRangeButton({
  pill,
  range,
  onExcluded,
}: {
  pill: Pill;
  range: TimeWindow;
  onExcluded: (range: TimeWindow) => void;
}) {
  const { toast, upsertPill } = useLive();
  const [asking, setAsking] = useState<TimeWindow | null>(null);
  return (
    <>
      <button type="button" className="chip" onClick={() => setAsking({ from: Math.round(range.from), to: Math.round(range.to) })}>
        <Icon name="eyeOff" size={12} /> {t('Exclude this range')}
      </button>
      {asking && (
        <Confirm
          title={t('Exclude this range?')}
          body={
            <p>
              {t(
                "This will exclude from {start} to {end} from the graph and replace it with extrapolated data in the view. This doesn't delete the data, and you can remove this exclusion at any time.",
                { start: dateTime(asking.from), end: dateTime(asking.to) },
              )}
            </p>
          }
          confirm={t('Exclude range')}
          onClose={() => setAsking(null)}
          onConfirm={async () => {
            try {
              upsertPill(await api.addExclusion(pill.id, asking));
              onExcluded(asking);
              toast({
                tone: 'success',
                title: t('Range excluded'),
                body: t('Point at it on the chart, or tap it, to put the readings back.'),
              });
            } catch (err) {
              toast({ tone: 'error', title: t("Couldn't exclude the range"), body: errorText(err) });
            }
          }}
        />
      )}
    </>
  );
}

/** Puts an excluded range's readings back on the device's charts. */
export function useRemoveExclusion(pill: Pill | undefined): (exclusion: ChartExclusion) => void {
  const { toast, upsertPill } = useLive();
  const id = pill?.id;
  return useCallback(
    (exclusion: ChartExclusion) => {
      if (!id) return;
      api.removeExclusion(id, exclusion.id).then(
        (updated) => {
          upsertPill(updated);
          toast({
            tone: 'success',
            title: t('Exclusion removed'),
            body: t('The readings from {from} to {to} are back on the chart.', {
              from: dateTime(exclusion.from),
              to: dateTime(exclusion.to),
            }),
          });
        },
        (err: unknown) => toast({ tone: 'error', title: t("Couldn't remove the exclusion"), body: errorText(err) }),
      );
    },
    [id, toast, upsertPill],
  );
}
