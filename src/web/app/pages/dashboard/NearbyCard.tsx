import { useState } from 'react';
import type { DeviceKind, NearbyPill } from '@rapthooker/shared';
import { api, errorText } from '../../api';
import { useLive } from '../../live';
import { useUnits } from '../../units';
import { href, navigate } from '../../router';
import { num, signalQuality, timeAgo, useNow } from '../../format';
import { t } from '../../i18n';
import { Icon, type IconName } from '../../components/Icon';

/** What a card says about each kind of device found. */
const KINDS: Record<
  DeviceKind,
  { icon: IconName; heading: (p: NearbyPill) => string; label: (id: string) => string; add: () => string; failed: () => string }
> = {
  pill: {
    icon: 'bluetooth',
    heading: () => t('Found a RAPT Pill nearby'),
    label: (id) => t('Name for the pill {id} (optional)', { id }),
    add: () => t('Add pill'),
    failed: () => t("Couldn't add the pill"),
  },
  thermometer: {
    icon: 'thermometer',
    heading: () => t('Found a RAPT Thermometer nearby'),
    label: (id) => t('Name for the thermometer {id} (optional)', { id }),
    add: () => t('Add thermometer'),
    failed: () => t("Couldn't add the thermometer"),
  },
  ispindel: {
    icon: 'wifi',
    heading: (p) => t('{name} is sending to this hub', { name: p.name ?? 'iSpindel' }),
    label: (id) => t('Name for the iSpindel {id} (optional)', { id }),
    add: () => t('Add iSpindel'),
    failed: () => t("Couldn't add the iSpindel"),
  },
  tilt: {
    icon: 'tilt',
    heading: (p) => t('Found {name} nearby', { name: p.info.deviceType ?? 'Tilt' }),
    label: (id) => t('Name for the Tilt {id} (optional)', { id }),
    add: () => t('Add Tilt'),
    failed: () => t("Couldn't add the Tilt"),
  },
  'laser-level': {
    icon: 'beer',
    heading: () => t('Found a RAPT Laser Level nearby'),
    label: (id) => t('Name for the Laser Level {id} (optional)', { id }),
    add: () => t('Add Laser Level'),
    failed: () => t("Couldn't add the Laser Level"),
  },
};

/** A device heard nearby, or an iSpindel sending to the hub, that can be added. */
export function NearbyCard({ pill, onAdded }: { pill: NearbyPill; onAdded?: () => void }) {
  const { isOwner, toast, upsertPill } = useLive();
  const u = useUnits();
  const now = useNow(10_000);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const nearbySignal = signalQuality(pill.rssi);
  const kind = KINDS[pill.kind] ?? KINDS.pill;
  const ispindel = pill.kind === 'ispindel';
  const id = ispindel ? (pill.name ?? pill.raptId) : pill.raptId;
  // What it measures: a Laser Level how full its keg is (a 19 L one, until it's set up), the rest a temperature.
  const latest = pill.latest;
  const summary = !latest
    ? ''
    : pill.kind === 'laser-level'
      ? `${u.volumeText(latest.volume)} · ${latest.fill == null ? '–' : `${num(latest.fill, 0)}%`} · `
      : `${latest.gravity === null ? '' : `${u.gravityText(latest.gravity)} · `}${u.tempText(latest.temperature)} · `;
  const add = async () => {
    setBusy(true);
    try {
      const added = await api.adopt(pill.address, name.trim() || undefined);
      upsertPill(added);
      toast({ tone: 'success', title: t('{name} added', { name: added.name }), body: t('Recording has started.') });
      onAdded?.();
      navigate(href.pill(added.id));
    } catch (err) {
      toast({ tone: 'error', title: kind.failed(), body: errorText(err) });
    } finally {
      setBusy(false);
    }
  };
  const ownName = ispindel ? pill.name : pill.kind === 'tilt' ? pill.info.deviceType : null;
  return (
    <div className="panel nearby">
      <div className="radar" aria-hidden="true">
        <Icon name={kind.icon} size={20} />
      </div>
      <div className="info">
        <h2>{kind.heading(pill)}</h2>
        <div className="small muted num">
          {pill.raptId} · {summary}
          {nearbySignal
            ? ispindel
              ? t('Wi-Fi: {quality} ({rssi} dBm)', { quality: nearbySignal.label, rssi: nearbySignal.rssi })
              : t('Signal: {quality} ({rssi} dBm)', { quality: nearbySignal.label, rssi: nearbySignal.rssi })
            : t('Signal unknown')}{' '}
          · {t('heard {ago}', { ago: timeAgo(pill.lastHeardAt, now) })}
        </div>
      </div>
      {isOwner ? (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input
            className="input"
            style={{ width: '12rem' }}
            aria-label={kind.label(id)}
            placeholder={ownName ?? t('Name it (optional)')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
          />
          <button type="submit" className="btn primary" disabled={busy}>
            <Icon name="plus" /> {kind.add()}
          </button>
          <button
            type="button"
            className="btn ghost"
            title={t('Not yours? Hide it')}
            onClick={() =>
              api.ignoreNearby(pill.address, true).catch((e) => toast({ tone: 'error', title: t('Failed'), body: errorText(e) }))
            }
          >
            {t('Ignore')}
          </button>
        </form>
      ) : (
        <a className="btn" href="#/settings">
          <Icon name="lock" /> {t('Sign in to add it')}
        </a>
      )}
    </div>
  );
}
