import { useState } from 'react';
import type { NearbyPill } from '@rapthooker/shared';
import { api, errorText } from '../../api';
import { useLive } from '../../live';
import { useUnits } from '../../units';
import { href, navigate } from '../../router';
import { signalQuality, timeAgo, useNow } from '../../format';
import { t } from '../../i18n';
import { Icon } from '../../components/Icon';

/** A RAPT Pill or Thermometer heard nearby, or an iSpindel sending to the hub, that can be added. */
export function NearbyCard({ pill, onAdded }: { pill: NearbyPill; onAdded?: () => void }) {
  const { isOwner, toast, upsertPill } = useLive();
  const u = useUnits();
  const now = useNow(10_000);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const nearbySignal = signalQuality(pill.rssi);
  const thermometer = pill.kind === 'thermometer';
  const ispindel = pill.kind === 'ispindel';
  const id = ispindel ? (pill.name ?? pill.raptId) : pill.raptId;
  const add = async () => {
    setBusy(true);
    try {
      const added = await api.adopt(pill.address, name.trim() || undefined);
      upsertPill(added);
      toast({ tone: 'success', title: t('{name} added', { name: added.name }), body: t('Recording has started.') });
      onAdded?.();
      navigate(href.pill(added.id));
    } catch (err) {
      toast({
        tone: 'error',
        title: thermometer ? t("Couldn't add the thermometer") : ispindel ? t("Couldn't add the iSpindel") : t("Couldn't add the pill"),
        body: errorText(err),
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel nearby">
      <div className="radar" aria-hidden="true">
        <Icon name={thermometer ? 'thermometer' : ispindel ? 'wifi' : 'bluetooth'} size={20} />
      </div>
      <div className="info">
        <h2>
          {thermometer
            ? t('Found a RAPT Thermometer nearby')
            : ispindel
              ? t('{name} is sending to this hub', { name: pill.name ?? 'iSpindel' })
              : t('Found a RAPT Pill nearby')}
        </h2>
        <div className="small muted num">
          {pill.raptId} ·{' '}
          {pill.latest ? `${thermometer ? '' : `${u.gravityText(pill.latest.gravity)} · `}${u.tempText(pill.latest.temperature)} · ` : ''}
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
            aria-label={
              thermometer
                ? t('Name for the thermometer {id} (optional)', { id })
                : ispindel
                  ? t('Name for the iSpindel {id} (optional)', { id })
                  : t('Name for the pill {id} (optional)', { id })
            }
            placeholder={ispindel && pill.name ? pill.name : t('Name it (optional)')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
          />
          <button type="submit" className="btn primary" disabled={busy}>
            <Icon name="plus" /> {thermometer ? t('Add thermometer') : ispindel ? t('Add iSpindel') : t('Add pill')}
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
