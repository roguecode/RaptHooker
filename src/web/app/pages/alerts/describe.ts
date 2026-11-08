import { alertKindInfo, ONCE_PER_BREW, type AlertRuleInput } from '@rapthooker/shared';
import type { useUnits } from '../../units';
import { t, tp } from '../../i18n';

type Words = Pick<ReturnType<typeof useUnits>, 'tempText' | 'gravityText'>;

/** What an alert watches for, in a few words ("Gravity dropping more than 10 points a day"). */
export function describeAlert(r: Pick<AlertRuleInput, 'kind' | 'threshold' | 'hours'>, u: Words): string {
  const info = alertKindInfo(r.kind);
  switch (info.measure) {
    case 'temperature':
      return `${t(info.label)} ${u.tempText(r.threshold)}`;
    case 'gravity':
      return `${t(info.label)} ${u.gravityText(r.threshold)}`;
    case 'points':
      return tp(r.threshold, 'Less than {count} point change in {hours} h', 'Less than {count} points change in {hours} h', {
        hours: r.hours,
      });
    case 'drop':
      return tp(r.threshold, 'Gravity down {count} point from the start', 'Gravity down {count} points from the start');
    case 'velocity':
      return r.kind === 'velocity_slow'
        ? tp(r.threshold, 'Gravity dropping less than {count} point a day', 'Gravity dropping less than {count} points a day')
        : tp(r.threshold, 'Gravity dropping more than {count} point a day', 'Gravity dropping more than {count} points a day');
    case 'percent':
      return `${t(info.label)} ${r.threshold}%`;
    case 'days':
      return tp(r.threshold, '{count} day into the brew', '{count} days into the brew');
    default:
      return t('Nothing heard for {minutes} min', { minutes: r.threshold });
  }
}

/** When it watches: once a brew, while brewing, or always (''), for after the description. */
export function whenText(r: Pick<AlertRuleInput, 'kind' | 'onlyDuringBrew'>): string {
  if (ONCE_PER_BREW.has(r.kind)) return t('once a brew');
  return r.onlyDuringBrew ? t('while brewing') : '';
}
