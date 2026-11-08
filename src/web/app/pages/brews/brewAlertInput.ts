import type { AlertRuleInput, BrewAlertInput } from '@rapthooker/shared';
import { t } from '../../i18n';

/** A new alert for a brew (or a profile) starts as "Fermentation starts": the step most brews want. */
export const newBrewAlert = (): AlertRuleInput => ({
  name: t('Fermentation starts'),
  enabled: true,
  pillIds: 'all',
  kind: 'fermentation_started',
  threshold: 3,
  hours: 48,
  onlyDuringBrew: true,
  cooldownMin: 60,
  channelIds: 'all',
  message: '',
  addToTimeline: true,
});

/** The alert editor's rule as a brew's alert: the brew says which pill, and while it runs. */
export const brewInputOf = ({ pillIds: _p, onlyDuringBrew: _o, ...input }: AlertRuleInput): BrewAlertInput => input;

/** A brew's alert (or a profile's) in the alert editor. */
export const ruleInputOf = (a: BrewAlertInput): AlertRuleInput => ({ ...a, pillIds: 'all', onlyDuringBrew: true });
