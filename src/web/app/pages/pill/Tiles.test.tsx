// @vitest-environment happy-dom
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makePill, makeReading, renderWithHub } from '../../test/render';
import { caughtPercent, perDay, Tiles } from './Tiles';

const HOUR = 3_600_000;

/** A tile by its name ("Gravity", "Caught"...). */
function tile(name: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('.tile')].find((t) =>
    t.querySelector('.k')?.textContent?.trim().startsWith(name),
  );
  if (!found) throw new Error(`No ${name} tile`);
  return found;
}
const part = (name: string, sel: string) => tile(name).querySelector(sel)?.textContent ?? null;

describe('pill tiles', () => {
  it("shows the pill's own values by default", async () => {
    const pill = makePill();
    await renderWithHub(<Tiles pill={pill} now={Date.now()} />, { pills: [pill] });

    expect(part('Gravity', '.tile-src')).toBe('from the pill');
    expect(part('Gravity', '.v')).toBe('1.0123');
    expect(part('Gravity', '.s')).toBe('12.3 points');
    expect(tile('Gravity').title).toBe("The pill's own gravity");
    expect(tile('Gravity').querySelector('.tile-note')).toBeNull();

    expect(part('Temperature', '.v')).toBe('19.20 °C');
    expect(part('Velocity', '.tile-src')).toBe('from the pill');
    expect(part('Velocity', '.v')).toBe('-4.20pts/day');
    expect(part('Velocity', '.s')).toBe('Fermenting');
    expect(part('Battery', '.v')).toBe('87%');
    expect(part('Signal', '.v')).toBe('Excellent');
    expect(part('Signal', '.s')).toBe('-62 dBm at the hub');
    expect(tile('Signal').classList.contains('tile-warn')).toBe(false);
    expect(screen.getByRole('img', { name: 'Signal: Excellent' })).toBeTruthy();
    expect(part('Bluetooth', '.v')).toBe('F0:0D:5E:ED:00:03');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it("labels RaptHooker's own gravity and velocity, with the pill's alongside", async () => {
    const pill = makePill({
      model: { gravitySource: 'tilt', velocitySource: 'computed', smoothing: 'light' },
      live: { latest: makeReading({ gravity: 1.0131, pillGravity: 1.015, velocity: -3.9, pillVelocity: -4.2 }), computedVelocity: -3.9 },
    });
    await renderWithHub(<Tiles pill={pill} now={Date.now()} />, { pills: [pill] });

    expect(part('Gravity', '.tile-src')).toBe('RaptHooker');
    expect(tile('Gravity').title).toBe('Worked out by RaptHooker from the tilt');
    expect(tile('Gravity').textContent).toContain('Pill says 1.0150');
    expect(tile('Gravity').textContent).toContain('Smoothed: 1-hour average');
    expect(part('Velocity', '.tile-src')).toBe('RaptHooker');
    expect(tile('Velocity').title).toBe('Worked out by RaptHooker over the last 24 hours');
    expect(tile('Velocity').textContent).toContain('Pill says −4.2 /day · RaptHooker −3.9 /day');
  });

  it('warns when the pill does not seem to be floating', async () => {
    const pill = makePill({ live: { latest: makeReading({ gravity: 1.2, pillGravity: 1.2, plausible: false }) } });
    await renderWithHub(<Tiles pill={pill} now={Date.now()} />, { pills: [pill] });

    expect(screen.getByRole('status').textContent).toContain('This reading looks wrong: is the pill floating?');
    expect(part('Gravity', '.s')).toBe('Not used: is the pill floating?');
  });

  it('shows how many readings were caught', async () => {
    const now = Date.now();
    const good = makePill({ live: { caught: { since: now - 24 * HOUR, expected: 288, received: 280 } } });
    const view = await renderWithHub(<Tiles pill={good} now={now} />, { pills: [good] });
    expect(part('Caught', '.v')).toBe('97%');
    expect(part('Caught', '.s')).toBe('of readings today');
    expect(tile('Caught').classList.contains('tile-warn')).toBe(false);
    expect(tile('Caught').title).toMatch(/^280 of the 288 readings expected since /);

    const poor = makePill({ live: { caught: { since: now - 6 * HOUR, expected: 72, received: 50 } } });
    view.rerender(<Tiles pill={poor} now={now} />);
    expect(part('Caught', '.v')).toBe('69%');
    expect(part('Caught', '.s')).toMatch(/^of readings since /);
    expect(tile('Caught').classList.contains('tile-warn')).toBe(true);
    expect(tile('Caught').textContent).toContain('Missing quite a few');

    const fresh = makePill({ live: { caught: null } });
    view.rerender(<Tiles pill={fresh} now={now} />);
    expect(part('Caught', '.v')).toBe('–');
    expect(part('Caught', '.s')).toBe('Still learning the interval');
  });

  it('rates the Bluetooth signal and warns when it is weak', async () => {
    const pill = makePill({ live: { rssi: -91 } });
    const view = await renderWithHub(<Tiles pill={pill} now={Date.now()} />, { pills: [pill] });
    expect(part('Signal', '.v')).toBe('Weak');
    expect(part('Signal', '.s')).toBe('-91 dBm at the hub');
    expect(tile('Signal').classList.contains('tile-warn')).toBe(true);
    expect(tile('Signal').textContent).toContain('Some readings may be missed');
    expect(tile('Signal').querySelector('.signal-bars')?.classList.contains('weak')).toBe(true);

    const unknown = makePill({ live: { rssi: null } });
    view.rerender(<Tiles pill={unknown} now={Date.now()} />);
    expect(part('Signal', '.v')).toBe('–');
    expect(part('Signal', '.s')).toBe('At the hub');
    expect(tile('Signal').classList.contains('tile-warn')).toBe(false);
    expect(screen.getByRole('img', { name: 'Signal unknown' })).toBeTruthy();
  });

  it("uses the hub's default units", async () => {
    const pill = makePill();
    await renderWithHub(<Tiles pill={pill} now={Date.now()} />, { pills: [pill], hub: { units: { gravity: 'plato', temperature: 'F' } } });
    expect(part('Gravity', '.v')).toBe('3.1 °P');
    expect(part('Temperature', '.v')).toBe('66.56 °F');
  });
});

describe('tile helpers', () => {
  it('works out the caught percentage', () => {
    expect(caughtPercent(null)).toBeNull();
    expect(caughtPercent({ since: 0, expected: 0, received: 3 })).toBeNull();
    expect(caughtPercent({ since: 0, expected: 200, received: 199 })).toBe(100);
    expect(caughtPercent({ since: 0, expected: 200, received: 230 })).toBe(100);
    expect(caughtPercent({ since: 0, expected: 200, received: 150 })).toBe(75);
  });

  it('writes a velocity per day with a proper minus sign', () => {
    expect(perDay(null)).toBe('–');
    expect(perDay(-3.14)).toBe('−3.1 /day');
    expect(perDay(0.25)).toBe('+0.3 /day');
    expect(perDay(0)).toBe('0.0 /day');
  });
});
