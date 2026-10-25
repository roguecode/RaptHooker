/** The first-run guide on the dashboard: which steps are done, and whether to show it. */

export type GuideStepId = 'pin' | 'bluetooth' | 'add' | 'extras';

export interface GuideState {
  pinSet: boolean;
  /** Pills added to the hub (archived ones too). */
  pills: number;
  /** Pills heard nearby that haven't been added. */
  nearby: number;
  brewing: boolean;
  /** Counts, or null while unknown. */
  webhooks: number | null;
  alerts: number | null;
}

export interface GuideStep {
  id: GuideStepId;
  done: boolean;
  optional: boolean;
}

export function guideSteps(s: GuideState): GuideStep[] {
  const added = s.pills > 0;
  return [
    { id: 'pin', done: s.pinSet, optional: false },
    { id: 'bluetooth', done: added || s.nearby > 0, optional: false },
    { id: 'add', done: added, optional: false },
    { id: 'extras', done: s.brewing || (s.webhooks ?? 0) > 0 || (s.alerts ?? 0) > 0, optional: true },
  ];
}

/** The steps a hub can't do without: an owner PIN and a pill. */
export const guideNeeded = (s: Pick<GuideState, 'pinSet' | 'pills'>): boolean => !s.pinSet || s.pills === 0;

/** 'seen': this browser has shown the guide while setting up; 'dismissed': hidden for good (while there are pills). */
export type GuideMemory = 'seen' | 'dismissed' | null;

export const parseGuideMemory = (raw: string | null): GuideMemory => (raw === 'seen' || raw === 'dismissed' ? raw : null);

/**
 * Shown while setup is unfinished, and afterwards (with the optional extras) in a browser that followed it, until
 * dismissed. Dismissing it with no pills only lasts for this visit: it comes back while the hub has no pills.
 */
export function guideVisible(opts: { needed: boolean; pills: number; memory: GuideMemory; hiddenThisVisit: boolean }): boolean {
  if (opts.hiddenThisVisit) return false;
  if (opts.memory === 'dismissed' && opts.pills > 0) return false;
  return opts.needed || opts.memory === 'seen';
}
