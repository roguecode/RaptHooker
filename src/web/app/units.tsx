import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import {
  cToF,
  DECIMAL_CHOICES,
  decimalsFrom,
  gravityDecimals,
  gravityFrom,
  SG_STEADY_DECIMALS,
  sgToPlato,
  temperatureDeltaIn,
  temperatureFrom,
  VOLUME_UNITS,
  volumeScale,
  type Decimals,
  type GravityUnit,
  type ServingUnit,
  type TemperatureUnit,
  type VolumeUnit,
} from '@rapthooker/shared';
import { useLive } from './live';
import { useStored } from './storage';
import { fixed, num } from './format';
import { t, tk, tp } from './i18n';

export interface Units {
  temperature: TemperatureUnit;
  gravity: GravityUnit;
}

interface UnitsContext extends Units {
  /** Picks units for this browser only. */
  setUnits: (u: Partial<Units>) => void;
  /** True when this browser has picked its own units rather than following the hub's defaults. */
  custom: boolean;
  /** Goes back to the hub's default units. */
  followHub: () => void;
  hubUnits: Units;
  /** Decimals readings are shown with: the hub's setting. */
  decimals: Decimals;
  /** Decimals for a gravity in the unit in use. */
  gravityDecimals: number;
  /** Decimals for a temperature. */
  tempDecimals: number;
  /** Gravity for display, split so the decimals past the third (SG) can be dimmed. */
  gravityParts: (sg: number | null | undefined) => { main: string; tail: string; unit: string };
  gravityText: (sg: number | null | undefined) => string;
  /** A gravity already in the unit in use (a chart's value), as text without its unit. */
  gravityNumber: (v: number) => string;
  gravityValue: (sg: number) => number;
  gravityFromDisplay: (v: number) => number;
  gravityLabel: string;
  /** A temperature in °C as text with its unit, with `decimals` decimals (the hub's setting if left out). */
  tempText: (c: number | null | undefined, decimals?: number) => string;
  /** A temperature already in the unit in use (a chart's value), as text without its unit. */
  tempNumber: (v: number) => string;
  tempValue: (c: number) => number;
  tempFromDisplay: (v: number) => number;
  tempDelta: (c: number) => number;
  tempLabel: string;
  /** What keg volumes are shown in, in this browser. They're always litres at the hub. */
  volume: VolumeUnit;
  setVolume: (v: VolumeUnit) => void;
  /** How to show litres for a device: "custom" uses the device's own unit, or litres when it has none. */
  volumeScale: (own?: ServingUnit | null) => VolumeScale;
  volumeText: (litres: number | null | undefined, own?: ServingUnit | null, trim?: boolean) => string;
}

export const UNITS_KEY = 'rapthooker.units';
export const VOLUME_KEY = 'rapthooker.volume';
const Ctx = createContext<UnitsContext | null>(null);

export const parseVolumeUnit = (raw: string | null): VolumeUnit => (VOLUME_UNITS.includes(raw as VolumeUnit) ? (raw as VolumeUnit) : 'l');

const DECIMALS_EXAMPLE: Decimals = { sg: 1.012345, plato: 3.08123, temperature: 19.63472 };

/** An example reading with `decimals` decimals, to pick decimals by ("1.012", "3.08", "19.6"), without its unit. */
export const decimalsExample = (which: keyof Decimals, decimals: number): string => fixed(DECIMALS_EXAMPLE[which], decimals);

/** The decimals to offer for one of them: the usual choices, and what's set if it's another. */
export const decimalsOptions = (which: keyof Decimals, current: number | null): number[] =>
  [...new Set([...DECIMAL_CHOICES[which], ...(current === null ? [] : [current])])].sort((a, b) => a - b);

/** How to show litres in a unit, in the page's language. */
export interface VolumeScale {
  /** Multiply litres by this. */
  perLitre: number;
  decimals: number;
  /** The unit on its own, as a label ("L", "pints", "cans"). */
  symbol: string;
  /** A number in this unit, already formatted as `text`, with its unit ("18.4 L", "1 pint", "33 pints"). */
  amount: (value: number, text: string) => string;
}

/** How to show litres in a unit: a device's own unit is shown as it was named, the rest in the page's language. */
export function scaleOf(unit: VolumeUnit, own?: ServingUnit | null): VolumeScale {
  const s = volumeScale(unit, own);
  if (unit === 'custom' && own) return { ...s, amount: (_v, text) => `${text} ${s.symbol}` };
  if (s.symbol === 'pints') {
    return { ...s, symbol: t('pints'), amount: (v, text) => tp(v, '{count} pint', '{count} pints', { count: text }) };
  }
  // i18n: the symbols for litres and US gallons, after a number ("19 L", "5 gal")
  const symbol = s.symbol === 'gal' ? t('gal') : t('L');
  return { ...s, symbol, amount: (_v, text) => `${text} ${symbol}` };
}

/** Litres in a scale, as text with its unit ("18.4 L", "39 pints"); `trim` drops trailing zeros ("19 L"). */
export function volumeIn(scale: VolumeScale, litres: number | null | undefined, trim = false): string {
  if (litres === null || litres === undefined || !Number.isFinite(litres)) return '–';
  return scale.amount(Number((litres * scale.perLitre).toFixed(scale.decimals)), volumeNumber(scale, litres, trim));
}

/** Litres in a scale, as a number without its unit. */
export function volumeNumber(scale: VolumeScale, litres: number | null | undefined, trim = false): string {
  if (litres === null || litres === undefined || !Number.isFinite(litres)) return '–';
  const v = Number((litres * scale.perLitre).toFixed(scale.decimals));
  return num(v === 0 ? 0 : v, scale.decimals, trim ? 0 : scale.decimals);
}

/** This browser's own choices; a unit it hasn't picked is left out (and follows the hub). */
export function parseUnitChoice(raw: string | null): Partial<Units> {
  try {
    const saved = JSON.parse(raw ?? '{}') as Partial<Record<keyof Units, unknown>> | null;
    const out: Partial<Units> = {};
    if (saved?.temperature === 'C' || saved?.temperature === 'F') out.temperature = saved.temperature;
    if (saved?.gravity === 'sg' || saved?.gravity === 'plato') out.gravity = saved.gravity;
    return out;
  } catch {
    return {};
  }
}

export function effectiveUnits(choice: Partial<Units>, hub: Units): Units {
  return { temperature: choice.temperature ?? hub.temperature, gravity: choice.gravity ?? hub.gravity };
}

const asIs = (raw: string | null) => raw;

/** Units come from this browser's own choice, or the hub's defaults for anything it hasn't picked. */
export function UnitsProvider({ children }: { children: ReactNode }) {
  const { hub } = useLive();
  const [raw, setRaw] = useStored<string | null>(UNITS_KEY, asIs);
  const choice = useMemo(() => parseUnitChoice(raw), [raw]);
  // The hub's settings are a new object with every 'hello' and 'hub' message: keep the units the same object until
  // they actually change, so forms that follow the units aren't reset on every reconnect.
  const { temperature: hubTemperature, gravity: hubGravity } = hub.units;
  const hubUnits = useMemo<Units>(() => ({ temperature: hubTemperature, gravity: hubGravity }), [hubTemperature, hubGravity]);
  const units = useMemo(() => effectiveUnits(choice, hubUnits), [choice, hubUnits]);
  const custom = choice.gravity !== undefined || choice.temperature !== undefined;
  // The same object until the hub's decimals actually change, like the units.
  const { sg: sgDecimals, plato: platoDecimals, temperature: tempDecimals } = decimalsFrom(hub.decimals);
  const decimals = useMemo<Decimals>(
    () => ({ sg: sgDecimals, plato: platoDecimals, temperature: tempDecimals }),
    [sgDecimals, platoDecimals, tempDecimals],
  );

  const setUnits = useCallback((u: Partial<Units>) => setRaw(JSON.stringify({ ...choice, ...u })), [choice, setRaw]);
  const followHub = useCallback(() => setRaw('{}'), [setRaw]);
  const [volume, setVolume] = useStored<VolumeUnit>(VOLUME_KEY, parseVolumeUnit);

  const value = useMemo<UnitsContext>(() => {
    const plato = units.gravity === 'plato';
    const f = units.temperature === 'F';
    const gd = gravityDecimals(decimals, units.gravity);
    const td = decimals.temperature;
    const gravityParts = (sg: number | null | undefined) => {
      if (sg === null || sg === undefined || !Number.isFinite(sg)) return { main: '–', tail: '', unit: plato ? '°P' : 'SG' };
      if (plato) return { main: fixed(sgToPlato(sg), gd), tail: '', unit: '°P' };
      const s = fixed(sg, gd);
      const dim = Math.max(0, gd - SG_STEADY_DECIMALS);
      return { main: dim ? s.slice(0, -dim) : s, tail: dim ? s.slice(-dim) : '', unit: 'SG' };
    };
    return {
      ...units,
      setUnits,
      custom,
      followHub,
      hubUnits,
      decimals,
      gravityDecimals: gd,
      tempDecimals: td,
      gravityParts,
      gravityText: (sg) => {
        if (sg === null || sg === undefined || !Number.isFinite(sg)) return '–';
        return plato ? `${fixed(sgToPlato(sg), gd)} °P` : fixed(sg, gd);
      },
      gravityNumber: (v) => fixed(v, gd),
      gravityValue: (sg) => (plato ? sgToPlato(sg) : sg),
      gravityFromDisplay: (v) => gravityFrom(v, units.gravity),
      gravityLabel: plato ? '°P' : 'SG',
      tempText: (c, d = td) =>
        c === null || c === undefined || !Number.isFinite(c) ? '–' : `${fixed(f ? cToF(c) : c, d)} °${units.temperature}`,
      tempNumber: (v) => fixed(v, td),
      tempValue: (c) => (f ? cToF(c) : c),
      tempFromDisplay: (v) => temperatureFrom(v, units.temperature),
      tempDelta: (c) => temperatureDeltaIn(c, units.temperature),
      tempLabel: `°${units.temperature}`,
      volume,
      setVolume,
      volumeScale: (own) => scaleOf(volume, own),
      volumeText: (litres, own, trim) => volumeIn(scaleOf(volume, own), litres, trim),
    };
  }, [units, setUnits, custom, followHub, hubUnits, decimals, volume, setVolume]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUnits(): UnitsContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useUnits outside UnitsProvider');
  return ctx;
}

function Seg({ on, label, onClick, children }: { on: boolean; label?: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={on ? 'on' : ''} aria-pressed={on} aria-label={label} onClick={onClick}>
      {children}
    </button>
  );
}

/** SG/°P and °C/°F buttons, and how keg volumes are shown once there's a Laser Level: this browser's choice. */
export function UnitToggles() {
  const u = useUnits();
  const { pills } = useLive();
  const kegs = pills.some((p) => p.kind === 'laser-level' && !p.archived);
  return (
    <div className="row" style={{ gap: '0.4rem' }}>
      <div className="segmented" role="group" aria-label={t('Gravity unit')}>
        <Seg on={u.gravity === 'sg'} label={t('SG, specific gravity')} onClick={() => u.setUnits({ gravity: 'sg' })}>
          SG
        </Seg>
        <Seg on={u.gravity === 'plato'} label={t('°P, degrees Plato')} onClick={() => u.setUnits({ gravity: 'plato' })}>
          °P
        </Seg>
      </div>
      <div className="row unit-pair">
        <div className="segmented" role="group" aria-label={t('Temperature unit')}>
          <Seg on={u.temperature === 'C'} label={t('°C, Celsius')} onClick={() => u.setUnits({ temperature: 'C' })}>
            °C
          </Seg>
          <Seg on={u.temperature === 'F'} label={t('°F, Fahrenheit')} onClick={() => u.setUnits({ temperature: 'F' })}>
            °F
          </Seg>
        </div>
        {kegs && (
          <select
            className="unit-select"
            aria-label={t('Volume unit')}
            title={t('Volume unit')}
            value={u.volume}
            onChange={(e) => u.setVolume(e.target.value as VolumeUnit)}
          >
            {VOLUME_UNITS.map((v) => (
              <option key={v} value={v}>
                {t(VOLUME_LABELS[v])}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

const VOLUME_LABELS: Record<VolumeUnit, string> = {
  l: tk('Litres'),
  gal: tk('Gallons (US)'),
  'pint-uk': tk('Pints (UK)'),
  'pint-us': tk('Pints (US)'),
  custom: tk('Custom'),
};

/** Says whether this browser follows the hub's default units, with a way back to them. */
export function UnitSource() {
  const u = useUnits();
  const hubText = t('{gravity} and {temperature}', {
    gravity: u.hubUnits.gravity === 'plato' ? '°P' : 'SG',
    temperature: `°${u.hubUnits.temperature}`,
  });
  return u.custom ? (
    <span className="small muted">
      {t('Picked in this browser.')}{' '}
      <button type="button" className="link-btn" onClick={u.followHub}>
        {t("Use the hub's ({units})", { units: hubText })}
      </button>
    </span>
  ) : (
    <span className="small muted">{t("Following the hub's default ({units}).", { units: hubText })}</span>
  );
}
