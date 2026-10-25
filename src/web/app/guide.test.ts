import { describe, expect, it } from 'vitest';
import { guideNeeded, guideSteps, guideVisible, parseGuideMemory, type GuideState } from './guide';

const fresh: GuideState = { pinSet: false, pills: 0, nearby: 0, brewing: false, webhooks: null, alerts: null };
const done = (s: GuideState) => Object.fromEntries(guideSteps(s).map((x) => [x.id, x.done]));

describe('first-run guide steps', () => {
  it('starts with nothing done', () => {
    expect(done(fresh)).toEqual({ pin: false, bluetooth: false, add: false, extras: false });
  });

  it('ticks off as the hub gets set up', () => {
    expect(done({ ...fresh, pinSet: true })).toMatchObject({ pin: true, bluetooth: false });
    expect(done({ ...fresh, pinSet: true, nearby: 1 })).toMatchObject({ bluetooth: true, add: false });
    expect(done({ ...fresh, pinSet: true, pills: 1 })).toMatchObject({ bluetooth: true, add: true, extras: false });
    expect(done({ ...fresh, pills: 1, webhooks: 2 }).extras).toBe(true);
    expect(done({ ...fresh, pills: 1, brewing: true }).extras).toBe(true);
    expect(done({ ...fresh, pills: 1, alerts: 0, webhooks: 0 }).extras).toBe(false);
  });

  it('marks only the extras as optional', () => {
    expect(
      guideSteps(fresh)
        .filter((s) => s.optional)
        .map((s) => s.id),
    ).toEqual(['extras']);
  });

  it('is needed until there is a PIN and a pill', () => {
    expect(guideNeeded({ pinSet: false, pills: 2 })).toBe(true);
    expect(guideNeeded({ pinSet: true, pills: 0 })).toBe(true);
    expect(guideNeeded({ pinSet: true, pills: 1 })).toBe(false);
  });
});

describe('first-run guide visibility', () => {
  it('shows while setup is unfinished', () => {
    expect(guideVisible({ needed: true, pills: 0, memory: null, hiddenThisVisit: false })).toBe(true);
  });

  it('stays hidden for an existing hub this browser never set up', () => {
    expect(guideVisible({ needed: false, pills: 3, memory: null, hiddenThisVisit: false })).toBe(false);
  });

  it('shows the finishing touches to a browser that followed it, until dismissed', () => {
    expect(guideVisible({ needed: false, pills: 1, memory: 'seen', hiddenThisVisit: false })).toBe(true);
    expect(guideVisible({ needed: false, pills: 1, memory: 'dismissed', hiddenThisVisit: false })).toBe(false);
  });

  it('comes back after dismissing only while there are no pills', () => {
    expect(guideVisible({ needed: true, pills: 2, memory: 'dismissed', hiddenThisVisit: false })).toBe(false);
    expect(guideVisible({ needed: true, pills: 0, memory: 'dismissed', hiddenThisVisit: false })).toBe(true);
    expect(guideVisible({ needed: true, pills: 0, memory: 'dismissed', hiddenThisVisit: true })).toBe(false);
  });

  it('reads the saved memory defensively', () => {
    expect(parseGuideMemory('seen')).toBe('seen');
    expect(parseGuideMemory('dismissed')).toBe('dismissed');
    expect(parseGuideMemory('')).toBeNull();
    expect(parseGuideMemory(null)).toBeNull();
  });
});
