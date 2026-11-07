import { gravityIn, stableClearsAt, velocityClearsAt, type AlertRuleInput } from '@rapthooker/shared';
import { fixed, num } from '../../format';
import { t, tp } from '../../i18n';

/** Rounded to what anyone types, so 0.3 + 0.15 is 0.45. */
const tidy = (points: number) => Math.round(points * 10_000) / 10_000;

/** Decimals that show `points` as SG exactly (0.5 points: 0.0005), from 3 to 6. */
function decimals(points: number): number {
  const s = String(Math.abs(tidy(points)));
  return Math.min(6, 3 + (s.includes('e') ? 3 : (s.split('.')[1]?.length ?? 0)));
}

/** `points` as an SG difference: 0.5 points is "0.0005". */
const sg = (points: number) => fixed(tidy(points) / 1000, decimals(points));

/** A drop of `points` from about `start`, as SG: 0.5 from 1.050 is 1.0500 to 1.0495. */
function drop(points: number, start: number) {
  const d = decimals(points);
  const from = Math.max(start, 1.002 + points / 1000);
  const to = from - tidy(points) / 1000;
  return { from: fixed(from, d), to: fixed(to, d), plato: num(gravityIn(from, 'plato') - gravityIn(to, 'plato'), 2) };
}

/**
 * What a gravity-points threshold means, worked out as the user types it: the drop in SG with an example, and what
 * else decides when the alert goes off and clears. For "Fermentation slows", "Fermentation speeds up" and
 * "Fermentation stable"; nothing for other kinds or a threshold that won't do.
 */
export function RuleExample({ rule, threshold, plato }: { rule: AlertRuleInput; threshold: number; plato: boolean }) {
  const { kind } = rule;
  const velocity = kind === 'velocity_slow' || kind === 'velocity_fast';
  if ((!velocity && kind !== 'gravity_stable') || !Number.isFinite(threshold) || threshold <= 0) return null;
  // While a box is empty (NaN) its part is left out.
  if (!velocity && !(rule.hours > 0)) return null;
  const cooldown = Number.isFinite(rule.cooldownMin) && rule.cooldownMin >= 0 ? rule.cooldownMin : null;

  const ex = drop(threshold, velocity ? 1.05 : 1.012);
  const vars = { amount: sg(threshold), from: ex.from, to: ex.to };
  const main = velocity
    ? kind === 'velocity_slow'
      ? t("Alerts when the gravity drops by less than {amount} in a day (that's {from} to {to}).", vars)
      : t("Alerts when the gravity drops by more than {amount} in a day (that's {from} to {to}).", vars)
    : tp(
        rule.hours,
        "Alerts when the gravity moves by less than {amount} over {count} hour (that's {from} to {to}).",
        "Alerts when the gravity moves by less than {amount} over {count} hours (that's {from} to {to}).",
        vars,
      );

  const also: string[] = [];
  if (kind === 'velocity_slow')
    also.push(
      t('It clears once the gravity drops by more than {amount} a day.', { amount: sg(velocityClearsAt(kind, threshold)) }),
      t(
        "While a brew is running, it waits until the gravity has dropped 0.002 from the OG, so it doesn't go off before fermentation starts.",
      ),
    );
  else if (kind === 'velocity_fast')
    also.push(t('It clears once the gravity drops by less than {amount} a day.', { amount: sg(velocityClearsAt(kind, threshold)) }));
  else
    also.push(
      t('It clears once the gravity moves by more than {amount} over the window.', { amount: sg(stableClearsAt(threshold)) }),
      t('It needs readings covering the whole window, and a running brew must have been going that long.'),
    );
  if (velocity)
    also.push(
      t(
        "It goes by the velocity on each pill's page (the pill's own, or RaptHooker's over the hours set there): a trend, so it follows changes a little late.",
      ),
    );
  also.push(t("Readings that look wrong (a pill that isn't floating) are skipped."));
  if (cooldown !== null)
    also.push(
      cooldown > 0
        ? tp(
            cooldown,
            "It notifies you at most once every {count} minute (Don't repeat for).",
            "It notifies you at most once every {count} minutes (Don't repeat for).",
          )
        : t("It notifies you every time it goes off (Don't repeat for is 0)."),
    );

  return (
    <div className="rule-example">
      <p aria-live="polite">
        <strong>{main}</strong> {plato && t("In °P, that's about {amount}.", { amount: ex.plato })}{' '}
        {velocity ? t('A point is 0.001, so a velocity of −12 /day is 12 points: 0.012 a day.') : t('A point is 0.001.')}
      </p>
      <ul>
        {also.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
    </div>
  );
}
