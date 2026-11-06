import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
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
  { kind: 'laser-level', icon: 'beer', name: 'RAPT Laser Level', what: () => t('Keg level · Bluetooth'), experimental: true },
  { kind: 'tilt', icon: 'tilt', name: 'Tilt', what: () => t('Hydrometer · Bluetooth'), experimental: true },
  { kind: 'ispindel', icon: 'wifi', name: 'iSpindel', what: () => t('Hydrometer · Wi-Fi') },
];

type BluetoothKind = 'pill' | 'thermometer' | 'tilt' | 'laser-level';

/** What the dialog says about each kind of device the hub hears over Bluetooth. */
const BLUETOOTH: Record<
  BluetoothKind,
  {
    icon: IconName;
    name: string;
    intro: () => string;
    steps: () => ReactNode[];
    found: () => string;
    listening: () => string;
    untested?: boolean;
  }
> = {
  pill: {
    icon: 'bluetooth',
    name: 'RAPT Pill',
    intro: () => t("KegLand's Bluetooth hydrometer and thermometer. The hub hears it directly, or through a Bluetooth relay."),
    steps: () => [
      <Trans
        key="mode"
        text={t('Put the pill in {mode}: RAPT app → your pill → Connect → Setup → Telemetry via Bluetooth.')}
        values={{ mode: <strong>{t('Bluetooth mode')}</strong> }}
      />,
      t('Keep it within range of this hub (or of a relay).'),
      t('It shows up below within a few minutes (pills only send every so often). Name it and add it.'),
    ],
    found: () => t('Pills found'),
    listening: () => t('Listening for RAPT Pills…'),
  },
  thermometer: {
    icon: 'thermometer',
    name: 'RAPT Thermometer',
    intro: () =>
      t("KegLand's Bluetooth thermometer. The hub hears it directly, or through a Bluetooth relay, and records it once a minute."),
    steps: () => [
      t('Switch the thermometer on. It sends its temperature over Bluetooth all the time.'),
      t('Keep it within range of this hub (or of a relay).'),
      t('It shows up below within a minute. Name it and add it.'),
    ],
    found: () => t('Thermometers found'),
    listening: () => t('Listening for RAPT Thermometers…'),
  },
  'laser-level': {
    icon: 'beer',
    name: 'RAPT Laser Level',
    intro: () =>
      t(
        "KegLand's keg lid that measures how far down the beer is with a laser, so the hub can show how full the keg is. The hub hears it directly, or through a Bluetooth relay, and records it once a minute.",
      ),
    steps: () => [
      t('Fit it to the keg and switch it on. It sends its reading over Bluetooth all the time.'),
      t('Keep it within range of this hub (or of a relay).'),
      t("It shows up below within a minute. Name it and add it, then set the keg's size on its page (it starts as a 19 L keg)."),
    ],
    found: () => t('Laser Levels found'),
    listening: () => t('Listening for RAPT Laser Levels…'),
    untested: true,
  },
  tilt: {
    icon: 'tilt',
    name: 'Tilt',
    intro: () =>
      t(
        'A Bluetooth hydrometer that floats in your fermenter. The hub hears it directly, or through a Bluetooth relay, and records it once a minute.',
      ),
    steps: () => [
      t('Put the Tilt in your fermenter (or a jug of water). It sends its reading over Bluetooth every few seconds.'),
      t('Keep it within range of this hub (or of a relay).'),
      t('It shows up below within a minute, by its colour. Name it and add it.'),
    ],
    found: () => t('Tilts found'),
    listening: () => t('Listening for Tilts…'),
    untested: true,
  },
};

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
 * Adding a device, one tab per kind: the ones heard nearby over Bluetooth (as the dashboard lists them), and iSpindels,
 * which the hub can set up itself or explain how to.
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
        {tab === 'ispindel' ? <IspindelPanel onAdded={onClose} /> : <BluetoothPanel kind={tab as BluetoothKind} onAdded={onClose} />}
      </div>
    </Modal>
  );
}

/** A device the hub hears over Bluetooth: how to get it heard, and the ones heard nearby (as on the dashboard). */
function BluetoothPanel({ kind, onAdded }: { kind: BluetoothKind; onAdded: () => void }) {
  const { nearby, ble } = useLive();
  const found = nearby.filter((n) => n.kind === kind);
  const about = BLUETOOTH[kind];
  const bluetoothDown = ble && (ble.state === 'error' || ble.state === 'unavailable');
  return (
    <div className="stack">
      <DeviceIntro
        icon={about.icon}
        name={about.name}
        badge={about.untested ? <span className="chip warning">{t('Experimental')}</span> : undefined}
      >
        {about.intro()}
      </DeviceIntro>
      <ol className="device-steps">
        {about.steps().map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      {bluetoothDown && (
        <div className="notice danger">
          <Icon name="alert" />
          <p>
            <strong>{t("Bluetooth isn't working.")}</strong> {ble.error ?? ''}
          </p>
        </div>
      )}
      <section className="stack" aria-label={about.found()}>
        {found.length > 0 ? (
          found.map((n) => <NearbyCard key={n.address} pill={n} onAdded={onAdded} />)
        ) : (
          <div className="device-listening">
            <span className="radar-dot" aria-hidden="true" />
            <p>
              <strong>{about.listening()}</strong>
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
