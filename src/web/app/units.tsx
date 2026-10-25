import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import {
  cToF,
  gravityFrom,
  sgToPlato,
  temperatureDeltaIn,
  temperatureFrom,
  type GravityUnit,
  type TemperatureUnit,
} from '@rapthooker/shared';
import { useLive } from './live';
import { useStored } from './storage';
import { fixed } from './format';
import { t } from './i18n';

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
  /** Gravity for display, split so the last digit can be dimmed. */
  gravityParts: (sg: number | null | undefined) => { main: string; tail: string; unit: string };
  gravityText: (sg: number | null | undefined) => string;
  gravityValue: (sg: number) => number;
  gravityFromDisplay: (v: number) => number;
  gravityLabel: string;
  tempText: (c: number | null | undefined, decimals?: number) => string;
  tempValue: (c: number) => number;
  tempFromDisplay: (v: number) => number;
  tempDelta: (c: number) => number;
  tempLabel: string;
}

export const UNITS_KEY = 'rapthooker.units';
const Ctx = createContext<UnitsContext | null>(null);

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

  const setUnits = useCallback((u: Partial<Units>) => setRaw(JSON.stringify({ ...choice, ...u })), [choice, setRaw]);
  const followHub = useCallback(() => setRaw('{}'), [setRaw]);

  const value = useMemo<UnitsContext>(() => {
    const plato = units.gravity === 'plato';
    const f = units.temperature === 'F';
    const gravityParts = (sg: number | null | undefined) => {
      if (sg === null || sg === undefined || !Number.isFinite(sg)) return { main: '–', tail: '', unit: plato ? '°P' : 'SG' };
      if (plato) return { main: fixed(sgToPlato(sg), 1), tail: '', unit: '°P' };
      const s = fixed(sg, 4);
      return { main: s.slice(0, -1), tail: s.slice(-1), unit: 'SG' };
    };
    return {
      ...units,
      setUnits,
      custom,
      followHub,
      hubUnits,
      gravityParts,
      gravityText: (sg) => {
        if (sg === null || sg === undefined || !Number.isFinite(sg)) return '–';
        return plato ? `${fixed(sgToPlato(sg), 1)} °P` : fixed(sg, 4);
      },
      gravityValue: (sg) => (plato ? sgToPlato(sg) : sg),
      gravityFromDisplay: (v) => gravityFrom(v, units.gravity),
      gravityLabel: plato ? '°P' : 'SG',
      tempText: (c, decimals = 1) =>
        c === null || c === undefined || !Number.isFinite(c) ? '–' : `${fixed(f ? cToF(c) : c, decimals)} °${units.temperature}`,
      tempValue: (c) => (f ? cToF(c) : c),
      tempFromDisplay: (v) => temperatureFrom(v, units.temperature),
      tempDelta: (c) => temperatureDeltaIn(c, units.temperature),
      tempLabel: `°${units.temperature}`,
    };
  }, [units, setUnits, custom, followHub, hubUnits]);

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

/** SG/°P and °C/°F buttons: this browser's choice. */
export function UnitToggles() {
  const u = useUnits();
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
      <div className="segmented" role="group" aria-label={t('Temperature unit')}>
        <Seg on={u.temperature === 'C'} label={t('°C, Celsius')} onClick={() => u.setUnits({ temperature: 'C' })}>
          °C
        </Seg>
        <Seg on={u.temperature === 'F'} label={t('°F, Fahrenheit')} onClick={() => u.setUnits({ temperature: 'F' })}>
          °F
        </Seg>
      </div>
    </div>
  );
}

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
