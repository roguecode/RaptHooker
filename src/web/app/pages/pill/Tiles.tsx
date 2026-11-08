import type { ReactNode } from 'react';
import type { Pill } from '@rapthooker/shared';
import { useUnits, volumeNumber } from '../../units';
import { dateOnly, dateTime, days, duration, fixed, signalQuality, timeAgo, timeOnly } from '../../format';
import { Icon, type IconName } from '../../components/Icon';
import { CollapsiblePanel, usePanelOpen } from '../../components/CollapsiblePanel';
import { BatteryBar, SignalBars } from '../../components/ui';
import { t, tp } from '../../i18n';
import { KegBar, LOW_FILL, vesselOf } from '../devices/keg';
import './pill.css';

function Tile({
  icon,
  k,
  v,
  unit,
  s,
  badge,
  children,
  mono = false,
  warn = false,
  title,
}: {
  icon: IconName;
  k: string;
  v: string;
  unit?: string;
  s?: string;
  /** Where the value comes from. */
  badge?: string;
  children?: ReactNode;
  mono?: boolean;
  warn?: boolean;
  title?: string;
}) {
  return (
    <div className={`tile${mono ? ' mono' : ''}${warn ? ' tile-warn' : ''}`} title={title}>
      <span className="k">
        <Icon name={icon} size={14} /> {k}
        {badge && <span className="tile-src">{badge}</span>}
      </span>
      <span className="v">
        {v}
        {unit && <small>{unit}</small>}
      </span>
      {children}
      {s && <span className="s">{s}</span>}
    </div>
  );
}

/** "−3.1 /day" */
export const perDay = (v: number | null | undefined): string =>
  v === null || v === undefined ? '–' : t('{value} /day', { value: `${v > 0 ? '+' : v < 0 ? '−' : ''}${fixed(Math.abs(v), 1)}` });

/** Share of the expected readings that arrived, %, or null when it can't be told yet. */
export function caughtPercent(c: Pill['live']['caught']): number | null {
  if (!c || c.expected <= 0) return null;
  return Math.min(100, Math.round((c.received / c.expected) * 100));
}

/** How well the hub hears the device, and whether that needs looking at. */
export function reception(pill: Pill) {
  const caught = caughtPercent(pill.live.caught);
  const signal = signalQuality(pill.live.rssi);
  return { caught, lowCatch: caught !== null && caught < 80, signal, weakSignal: signal !== null && signal.level <= 1 };
}

/** The tiles, in a panel that starts folded. What needs looking at shows in its heading while it's folded. */
export function DataPanel({ pill, now }: { pill: Pill; now: number }) {
  const [open, toggle] = usePanelOpen('pill.data', false);
  const { caught, lowCatch, signal, weakSignal } = reception(pill);
  return (
    <CollapsiblePanel
      open={open}
      onToggle={toggle}
      className="pill-data"
      title={
        <>
          {/* i18n: the heading over a pill's or thermometer's latest values: battery, signal, firmware... */}
          <Icon name="grid" /> {t('Data')}
        </>
      }
      badges={
        !open &&
        (lowCatch || weakSignal) && (
          <>
            {lowCatch && caught !== null && (
              <span className="chip warning">
                <Icon name="alert" size={12} /> {t('Readings caught: {percent}%', { percent: caught })}
              </span>
            )}
            {weakSignal && signal && (
              <span className="chip warning">
                <Icon name="alert" size={12} /> {t('Signal: {quality}', { quality: signal.label })}
              </span>
            )}
          </>
        )
      }
    >
      <Tiles pill={pill} now={now} />
    </CollapsiblePanel>
  );
}

export function Tiles({ pill, now }: { pill: Pill; now: number }) {
  const u = useUnits();
  const r = pill.live.latest;
  const m = pill.model;
  const fromTilt = m.gravitySource === 'tilt';
  const smoothed = m.smoothing !== 'off';
  const computed = m.velocitySource === 'computed';
  const v = r?.velocity ?? null;
  const pillV = r?.pillVelocity ?? null;
  const ourV = pill.live.computedVelocity;
  const caught = pill.live.caught;
  const { caught: pct, lowCatch, signal, weakSignal } = reception(pill);
  const sinceRestart = caught !== null && caught.since > now - 23 * 3_600_000;
  const thermometer = pill.kind === 'thermometer';
  const tilt = pill.kind === 'tilt';
  const laser = pill.kind === 'laser-level';
  // A pill or thermometer is named in the hints; a Tilt or Laser Level isn't.
  const other = tilt || laser;

  const caughtTile = (
    <Tile
      icon="check"
      // i18n: the share of the expected readings that arrived
      k={t('Caught')}
      v={pct === null ? '–' : `${pct}`}
      unit={pct === null ? undefined : '%'}
      s={
        caught === null
          ? t('Still learning the interval')
          : sinceRestart
            ? t('of readings since {time}', { time: timeOnly(caught.since) })
            : t('of readings today')
      }
      warn={lowCatch}
      title={
        caught
          ? tp(
              caught.expected,
              '{received} of the {count} reading expected since {date}',
              '{received} of the {count} readings expected since {date}',
              {
                received: caught.received,
                date: dateTime(caught.since),
              },
            )
          : undefined
      }
    >
      {lowCatch && (
        <span className="tile-note">
          {thermometer
            ? t('Missing quite a few: try the hub (or a relay) closer to the thermometer.')
            : other
              ? t('Missing quite a few: try the hub (or a relay) closer to it.')
              : t('Missing quite a few: try the hub (or a relay) closer to the pill.')}
        </span>
      )}
    </Tile>
  );
  const wifi = pill.kind === 'ispindel';
  const signalTile = (
    <Tile
      icon={wifi ? 'wifi' : 'signal'}
      k={t('Signal')}
      v={signal ? signal.label : '–'}
      s={
        wifi
          ? signal
            ? t('{rssi} dBm Wi-Fi signal', { rssi: signal.rssi })
            : t('Its Wi-Fi')
          : signal
            ? t('{rssi} dBm at the hub', { rssi: signal.rssi })
            : t('At the hub')
      }
      warn={weakSignal}
      title={
        wifi
          ? t("The iSpindel's Wi-Fi signal strength: the closer to 0 dBm, the stronger. Anything better than −80 dBm is fine.")
          : t('Bluetooth signal strength: the closer to 0 dBm, the stronger. Anything better than −85 dBm is fine.')
      }
    >
      <SignalBars rssi={pill.live.rssi} />
      {weakSignal && (
        <span className="tile-note">
          {thermometer
            ? t('Some readings may be missed: try the hub (or a relay) closer to the thermometer.')
            : wifi
              ? t('Some readings may be missed: its Wi-Fi is weak where it is.')
              : other
                ? t('Some readings may be missed: try the hub (or a relay) closer to it.')
                : t('Some readings may be missed: try the hub (or a relay) closer to the pill.')}
        </span>
      )}
    </Tile>
  );
  const temperatureTile = (
    <Tile
      icon="thermometer"
      k={t('Temperature')}
      v={u.tempText(r?.temperature, thermometer ? undefined : Math.max(2, u.tempDecimals))}
      s={pill.offsets.temperature ? t('Calibrated') : undefined}
    />
  );
  const intervalTile = (
    <Tile
      icon="clock"
      k={t('Interval')}
      v={pill.live.intervalSec ? duration(pill.live.intervalSec * 1000) : '–'}
      s={pill.live.intervalSec ? t('Learned from its readings') : t('Learning…')}
    />
  );
  const lastHeardTile = (
    <Tile icon="activity" k={t('Last heard')} v={timeAgo(pill.live.lastHeardAt, now)} s={dateTime(pill.live.lastHeardAt)} />
  );
  const sinceTile = (
    <Tile
      icon="calendar"
      k={t('Recording since')}
      v={dateOnly(pill.live.firstReadingAt ?? pill.createdAt)}
      s={days(now - (pill.live.firstReadingAt ?? pill.createdAt))}
    />
  );

  if (thermometer) {
    return (
      <section className="tiles pill-tiles" aria-label={t('Latest values')}>
        {temperatureTile}
        {caughtTile}
        {signalTile}
        {intervalTile}
        {lastHeardTile}
        <Tile icon="bluetooth" k="Bluetooth" v={pill.address} s="RAPT Thermometer" mono />
        {sinceTile}
      </section>
    );
  }

  if (laser) {
    const vessel = vesselOf(pill);
    const scale = u.volumeScale(pill.servingUnit);
    return (
      <section className="tiles pill-tiles" aria-label={t('Latest values')}>
        <Tile
          icon="beer"
          k={t('In the keg')}
          v={volumeNumber(scale, r?.volume)}
          unit={scale.symbol}
          s={t('of {amount}', { amount: u.volumeText(vessel.capacity, pill.servingUnit, true) })}
        >
          <KegBar fill={r?.fill} color={pill.color} />
        </Tile>
        <Tile
          icon="percent"
          k={t('Full')}
          v={r?.fill == null ? '–' : fixed(r.fill, 0)}
          unit="%"
          warn={r?.fill != null && r.fill < LOW_FILL}
        />
        <Tile
          icon="down"
          k={t('Distance')}
          v={r?.distance == null ? '–' : fixed(r.distance, 0)}
          unit="mm"
          s={t('Down to the beer')}
          title={t('From the Laser Level down to the beer. Empty is {empty} mm, full {full} mm (set under its settings).', {
            empty: fixed(vessel.emptyMm, 0),
            full: fixed(vessel.fullMm, 0),
          })}
        />
        <Tile icon="thermometer" k={t('Temperature')} v={u.tempText(r?.temperature)} s={t("The sensor's own, in the lid")} />
        <Tile icon="battery" k={t('Battery')} v={r?.battery != null ? fixed(r.battery, 0) : '–'} unit="%">
          <BatteryBar percent={r?.battery} />
        </Tile>
        {caughtTile}
        {signalTile}
        {intervalTile}
        {lastHeardTile}
        <Tile icon="cpu" k={t('Firmware')} v={pill.info.firmware ?? '–'} s="RAPT Laser Level" mono />
        <Tile icon="bluetooth" k="Bluetooth" v={pill.address} s="RAPT Laser Level" mono />
        {sinceTile}
      </section>
    );
  }

  return (
    <section className="tiles pill-tiles" aria-label={t('Latest values')}>
      <Tile
        icon="droplet"
        k={t('Gravity')}
        badge={fromTilt ? 'RaptHooker' : tilt ? 'Tilt' : t('from the pill')}
        v={u.gravityText(r?.gravity)}
        s={
          r && r.gravity !== null
            ? r.plausible
              ? t('{value} points', { value: fixed((r.gravity - 1) * 1000, 1) })
              : t('Not used: is the pill floating?')
            : undefined
        }
        title={fromTilt ? t('Worked out by RaptHooker from the tilt') : t("The pill's own gravity")}
      >
        {r && (fromTilt || smoothed) && (
          <span className="tile-note num">{t('Pill says {gravity}', { gravity: u.gravityText(r.pillGravity) })}</span>
        )}
        {smoothed && (
          <span className="tile-note">{m.smoothing === 'light' ? t('Smoothed: 1-hour average') : t('Smoothed: 4-hour average')}</span>
        )}
      </Tile>
      {temperatureTile}
      <Tile
        icon={v !== null && v > 0 ? 'up' : 'down'}
        k={t('Velocity')}
        badge={computed ? 'RaptHooker' : t('from the pill')}
        v={v === null ? '–' : `${v > 0 ? '+' : ''}${fixed(v, 2)}`}
        unit={v === null ? undefined : t('pts/day')}
        s={
          v === null
            ? computed
              ? t('RaptHooker needs a few hours of readings')
              : t('The pill needs more data first')
            : v < -0.5
              ? t('Fermenting')
              : v > 0.5
                ? t('Rising')
                : t('Steady')
        }
        title={
          computed
            ? tp(
                m.velocityHours,
                'Worked out by RaptHooker over the last {count} hour',
                'Worked out by RaptHooker over the last {count} hours',
              )
            : t("The pill's own velocity")
        }
      >
        {(pillV !== null || ourV !== null) && (
          <span className="tile-note num">{t('Pill says {pill} · RaptHooker {ours}', { pill: perDay(pillV), ours: perDay(ourV) })}</span>
        )}
      </Tile>
      {caughtTile}
      {!tilt && (
        <Tile icon="battery" k={t('Battery')} v={r?.battery != null ? fixed(r.battery, 0) : '–'} unit="%">
          <BatteryBar percent={r?.battery} />
        </Tile>
      )}
      {signalTile}
      {!tilt && <Tile icon="tilt" k={t('Tilt')} v={r?.tilt != null ? fixed(r.tilt, 1) : '–'} unit="°" s={t('From vertical')} />}
      {pill.kind === 'ispindel' ? (
        <Tile icon="zap" k={t('Battery voltage')} v={r?.voltage != null ? fixed(r.voltage, 2) : '–'} unit="V" />
      ) : tilt ? null : (
        <Tile
          icon="axes"
          k={t('Accelerometer')}
          v={r && r.x !== null && r.y !== null && r.z !== null ? `${r.x.toFixed(0)} / ${r.y.toFixed(0)} / ${r.z.toFixed(0)}` : '–'}
          s="x / y / z"
        />
      )}
      {intervalTile}
      {lastHeardTile}
      {pill.kind === 'ispindel' ? (
        <Tile icon="wifi" k="iSpindel" v={pill.address.replace(/^ISPINDEL:/, '')} s={t('Chip ID, over Wi-Fi')} mono />
      ) : tilt ? (
        <Tile icon="bluetooth" k="Bluetooth" v={pill.address} s={pill.info.deviceType ?? 'Tilt'} mono />
      ) : (
        <>
          <Tile
            icon="cpu"
            k={t('Firmware')}
            v={pill.info.firmware ?? '–'}
            s={
              pill.info.deviceType
                ? t('{device} · format v{version}', { device: pill.info.deviceType, version: pill.info.payloadVersion ?? '?' })
                : undefined
            }
            mono
          />
          <Tile icon="bluetooth" k="Bluetooth" v={pill.address} s={`RAPT ID ${pill.raptId}`} mono />
        </>
      )}
      {sinceTile}
    </section>
  );
}
