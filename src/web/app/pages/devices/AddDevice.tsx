import { useId, useRef, useState, type KeyboardEvent } from 'react';
import type { DeviceKind } from '@rapthooker/shared';
import { useLive } from '../../live';
import { t } from '../../i18n';
import { Trans } from '../../i18n/Trans';
import { Icon, type IconName } from '../../components/Icon';
import { Modal } from '../../components/ui';
import { NearbyCard } from '../dashboard/NearbyCard';
import { DeviceArt, DeviceIntro } from './DeviceArt';
import { IspindelPanel } from './IspindelTab';
import './devices.css';

/** The kinds of device that can be added, in the order of the dialog's tabs. */
const TABS: { kind: DeviceKind; icon: IconName; name: string; what: () => string; experimental?: boolean }[] = [
  { kind: 'pill', icon: 'bluetooth', name: 'RAPT Pill', what: () => t('Hydrometer · Bluetooth') },
  { kind: 'thermometer', icon: 'thermometer', name: 'RAPT Thermometer', what: () => t('Temperature · Bluetooth') },
  { kind: 'ispindel', icon: 'wifi', name: 'iSpindel', what: () => t('Hydrometer · Wi-Fi'), experimental: true },
];

/** The "Add device" button, and the dialog it opens. */
export function AddDeviceButton({ primary = false }: { primary?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`btn${primary ? ' primary' : ' small'}`} onClick={() => setOpen(true)}>
        <Icon name="plus" size={16} /> {t('Add device')}
      </button>
      {open && <AddDeviceDialog onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * Adding a device, one tab per kind: the RAPT devices heard nearby (as the dashboard lists them), and iSpindels, which
 * the hub can set up itself or explain how to.
 */
export function AddDeviceDialog({ onClose, initial }: { onClose: () => void; initial?: DeviceKind }) {
  const { nearby } = useLive();
  const found = (kind: DeviceKind) => nearby.filter((n) => n.kind === kind);
  // Open on the kind something was found for, unless asked for one.
  const [tab, setTab] = useState<DeviceKind>(() => initial ?? TABS.find((x) => found(x.kind).length > 0)?.kind ?? 'pill');
  const base = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKey = (e: KeyboardEvent, i: number) => {
    const next =
      e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const j = (next + TABS.length) % TABS.length;
    setTab(TABS[j]!.kind);
    tabRefs.current[j]?.focus();
  };

  return (
    <Modal title={t('Add a device')} onClose={onClose} wide className="add-device">
      <div className="device-tabs" role="tablist" aria-label={t('Kind of device')}>
        {TABS.map((x, i) => {
          const count = found(x.kind).length;
          const on = tab === x.kind;
          return (
            <button
              key={x.kind}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${x.kind}`}
              aria-selected={on}
              aria-controls={`${base}-panel-${x.kind}`}
              tabIndex={on ? 0 : -1}
              className={`device-tab${on ? ' on' : ''}`}
              onClick={() => setTab(x.kind)}
              onKeyDown={(e) => onKey(e, i)}
            >
              <DeviceArt icon={x.icon} />
              <span className="device-tab-text">
                <strong>{x.name}</strong>
                <small>{x.experimental ? t('{what} · experimental', { what: x.what() }) : x.what()}</small>
              </span>
              {count > 0 && (
                <span className="device-tab-count" aria-label={t('{count} found', { count })}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={`${base}-panel-${tab}`} aria-labelledby={`${base}-tab-${tab}`} className="device-panel" tabIndex={0}>
        {tab === 'pill' && <RaptPanel kind="pill" onAdded={onClose} />}
        {tab === 'thermometer' && <RaptPanel kind="thermometer" onAdded={onClose} />}
        {tab === 'ispindel' && <IspindelPanel onAdded={onClose} />}
      </div>
    </Modal>
  );
}

/** A RAPT Pill or Thermometer: how to get it heard, and the ones heard nearby (as on the dashboard). */
function RaptPanel({ kind, onAdded }: { kind: 'pill' | 'thermometer'; onAdded: () => void }) {
  const { nearby, ble } = useLive();
  const found = nearby.filter((n) => n.kind === kind);
  const pill = kind === 'pill';
  const bluetoothDown = ble && (ble.state === 'error' || ble.state === 'unavailable');
  return (
    <div className="stack">
      <DeviceIntro icon={pill ? 'bluetooth' : 'thermometer'} name={pill ? 'RAPT Pill' : 'RAPT Thermometer'}>
        {pill
          ? t("KegLand's Bluetooth hydrometer and thermometer. The hub hears it directly, or through a Bluetooth relay.")
          : t("KegLand's Bluetooth thermometer. The hub hears it directly, or through a Bluetooth relay, and records it once a minute.")}
      </DeviceIntro>
      <ol className="device-steps">
        {pill ? (
          <li>
            <Trans
              text={t('Put the pill in {mode}: RAPT app → your pill → Connect → Setup → Telemetry via Bluetooth.')}
              values={{ mode: <strong>{t('Bluetooth mode')}</strong> }}
            />
          </li>
        ) : (
          <li>{t('Switch the thermometer on. It sends its temperature over Bluetooth all the time.')}</li>
        )}
        <li>{t('Keep it within range of this hub (or of a relay).')}</li>
        <li>
          {pill
            ? t('It shows up below within a few minutes (pills only send every so often). Name it and add it.')
            : t('It shows up below within a minute. Name it and add it.')}
        </li>
      </ol>
      {bluetoothDown && (
        <div className="notice danger">
          <Icon name="alert" />
          <p>
            <strong>{t("Bluetooth isn't working.")}</strong> {ble.error ?? ''}
          </p>
        </div>
      )}
      <section className="stack" aria-label={pill ? t('Pills found') : t('Thermometers found')}>
        {found.length > 0 ? (
          found.map((n) => <NearbyCard key={n.address} pill={n} onAdded={onAdded} />)
        ) : (
          <div className="device-listening">
            <span className="radar-dot" aria-hidden="true" />
            <p>
              <strong>{pill ? t('Listening for RAPT Pills…') : t('Listening for RAPT Thermometers…')}</strong>
              <br />
              <span className="small muted">
                {t(
                  'Ones you added already, or chose to ignore, aren’t listed. Ignored ones are under Settings → Archived and ignored pills.',
                )}
              </span>
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
