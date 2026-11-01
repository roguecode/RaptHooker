import { useCallback, useEffect, useId, useState } from 'react';
import { screenModel, type ScreenSetupProgress, type WifiNetwork, type WifiStatus } from '@rapthooker/shared';
import { errorText } from '../../api';
import { useLive } from '../../live';
import { useUnits } from '../../units';
import { intlLocale } from '../../format';
import { t, tp } from '../../i18n';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/ui';
import { browserTimeZone } from '../../components/imageLinkOptions';
import { screensApi } from './screensApi';
import { BrowserSetup } from './BrowserSetup';

const KIND_LABELS = {
  sdpro: () => t('{name}, as it came', { name: screenModel('sdpro-240')?.name ?? 'Smart weather clock' }),
  rapthooker: () => t('RaptHooker screen, waiting to be set up'),
};

/** A name for a new screen that the hub hasn't got yet. */
export function newScreenName(taken: string[]): string {
  const base = t('Screen');
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base} ${i}`)) return `${base} ${i}`;
}

/** What a new screen's picture starts as: this browser's language, time zone and units. */
export function useNewLook() {
  const units = useUnits();
  return { lang: intlLocale(), tz: browserTimeZone(), gravity: units.gravity, temperature: units.temperature };
}

/**
 * Adding a screen: the hub looks for Wi-Fi networks (a new screen opens its own), then joins the one picked to put
 * RaptHooker firmware on the screen and connect it to the hub's network. A hub that can't switch Wi-Fi networks
 * hands over to BrowserSetup, which does the same from this browser.
 */
export function AddScreen({ onClose, onStarted }: { onClose: () => void; onStarted: (p: ScreenSetupProgress) => void }) {
  const [wifi, setWifi] = useState<WifiStatus | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [nets, setNets] = useState<WifiNetwork[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [picked, setPicked] = useState<WifiNetwork | null>(null);
  const [fromBrowser, setFromBrowser] = useState(false);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      setNets(await screensApi.scan());
      setFailed(null);
    } catch (err) {
      setFailed(errorText(err));
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    let live = true;
    screensApi.wifi().then(
      (w) => {
        if (!live) return;
        setWifi(w);
        if (w.canSetUp) void scan();
      },
      (err) => live && setFailed(errorText(err)),
    );
    return () => {
      live = false;
    };
  }, [scan]);

  const title = (
    <>
      <Icon name="screen" /> {t('Add a screen')}
    </>
  );

  if (fromBrowser || (wifi && !wifi.canSetUp)) {
    return (
      <Modal title={title} onClose={onClose} wide>
        <BrowserSetup reason={wifi && !wifi.canSetUp ? wifi.reason : null} onDone={onClose} />
      </Modal>
    );
  }

  return (
    <Modal title={title} onClose={onClose} wide className="add-screen">
      {picked && wifi ? (
        <SetupForm hotspot={picked} wifi={wifi} nets={nets ?? []} onBack={() => setPicked(null)} onStarted={onStarted} />
      ) : (
        <ScanList nets={nets} scanning={scanning} failed={failed} onScan={() => void scan()} onPick={setPicked} />
      )}
      {!picked && wifi?.canSetUp && (
        <p className="hint">
          <button type="button" className="link-btn" onClick={() => setFromBrowser(true)}>
            {t('Set it up from this device instead')}
          </button>{' '}
          {t("(if the screen is out of the hub's reach)")}
        </p>
      )}
    </Modal>
  );
}

function ScanList({
  nets,
  scanning,
  failed,
  onScan,
  onPick,
}: {
  nets: WifiNetwork[] | null;
  scanning: boolean;
  failed: string | null;
  onScan: () => void;
  onPick: (n: WifiNetwork) => void;
}) {
  const screens = (nets ?? []).filter((n) => n.kind !== null).sort((a, b) => b.signal - a.signal);
  const others = (nets ?? []).filter((n) => n.kind === null && n.ssid && !n.current);
  return (
    <div className="stack">
      <p className="muted">
        {t(
          'Plug the screen in near the hub. A new one opens its own Wi-Fi network, called "Smart weather clock": the hub joins it for a minute to put RaptHooker on the screen and connect it to your Wi-Fi.',
        )}
      </p>
      <div className="row">
        <button type="button" className="btn" disabled={scanning} onClick={onScan}>
          <Icon name="refresh" size={16} /> {scanning ? t('Looking for Wi-Fi networks…') : t('Scan again')}
        </button>
      </div>
      {failed && (
        <div className="notice danger" role="alert">
          <Icon name="alert" />
          <p>{failed}</p>
        </div>
      )}
      {nets === null && scanning && <div className="skeleton" style={{ height: '6rem' }} />}
      {nets !== null && (
        <>
          <h3 className="subhead">{t('Screens')}</h3>
          {screens.length === 0 ? (
            <div className="notice">
              <Icon name="info" />
              <p>
                {t(
                  "No screens found yet. A new screen's network can take a minute to appear after it's plugged in. A screen that was set up before only opens its own network after 5 minutes away from its Wi-Fi.",
                )}
              </p>
            </div>
          ) : (
            <ul className="wifi-list">
              {screens.map((n) => (
                <WifiRow key={n.bssid || n.ssid} net={n} onPick={onPick} highlight />
              ))}
            </ul>
          )}
          {others.length > 0 && (
            <details className="wifi-others">
              <summary>{tp(others.length, '{count} other network', '{count} other networks')}</summary>
              <p className="hint">
                {t(
                  "If your screen's network has another name, pick it here. RaptHooker checks it's a screen it knows before changing anything.",
                )}
              </p>
              <ul className="wifi-list">
                {others.map((n) => (
                  <WifiRow key={n.bssid || n.ssid} net={n} onPick={onPick} />
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function WifiRow({ net, onPick, highlight = false }: { net: WifiNetwork; onPick: (n: WifiNetwork) => void; highlight?: boolean }) {
  return (
    <li className={`wifi-row${highlight ? ' likely' : ''}`}>
      <Icon name={highlight ? 'screen' : 'wifi'} />
      <div className="grow">
        <strong>{net.ssid}</strong>
        <span className="small muted">
          {net.kind ? KIND_LABELS[net.kind]() : `${net.band} GHz`} · {t('signal {percent}%', { percent: net.signal })}
          {net.secure ? ` · ${t('password')}` : ''}
        </span>
      </div>
      <button type="button" className={`btn small${highlight ? ' primary' : ''}`} onClick={() => onPick(net)}>
        {t('Set up')}
      </button>
    </li>
  );
}

const OTHER = '\u0000other';

function SetupForm({
  hotspot,
  wifi,
  nets,
  onBack,
  onStarted,
}: {
  hotspot: WifiNetwork;
  wifi: WifiStatus;
  nets: WifiNetwork[];
  onBack: () => void;
  onStarted: (p: ScreenSetupProgress) => void;
}) {
  const { pills, screens, toast } = useLive();
  const look = useNewLook();
  const ids = { name: useId(), pill: useId(), ssid: useId(), other: useId(), password: useId() };
  // The networks the screen could join: 2.4 GHz ones that aren't screens, the hub's own first.
  const choices = [
    ...new Set([...(wifi.ssid ? [wifi.ssid] : []), ...nets.filter((n) => n.band === 2.4 && n.kind === null && n.ssid).map((n) => n.ssid)]),
  ];
  const [name, setName] = useState(() => newScreenName(screens.map((s) => s.name)));
  const [pillId, setPillId] = useState<string | null>(null);
  const [choice, setChoice] = useState(choices[0] ?? OTHER);
  const [other, setOther] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const ssid = choice === OTHER ? other.trim() : choice;
  const hubsOwn = ssid !== '' && ssid === wifi.ssid && wifi.knowsPassword;
  const only5 = ssid !== '' && nets.some((n) => n.ssid === ssid) && !nets.some((n) => n.ssid === ssid && n.band === 2.4);
  const ready = name.trim() !== '' && ssid !== '' && (hubsOwn || password !== '');

  const start = async () => {
    setBusy(true);
    try {
      onStarted(await screensApi.startSetup({ hotspot: hotspot.ssid, ssid, password, name: name.trim(), pillId, look }));
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't start setting the screen up"), body: errorText(err) });
      setBusy(false);
    }
  };

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) void start();
      }}
    >
      <button type="button" className="back link-btn" onClick={onBack}>
        <Icon name="left" size={16} /> {t('Other screens')}
      </button>
      <div className="row">
        <Icon name="screen" />
        <div>
          <strong>{hotspot.ssid}</strong>
          <div className="small muted">{hotspot.kind ? KIND_LABELS[hotspot.kind]() : t("A network RaptHooker doesn't recognise")}</div>
        </div>
      </div>

      <div className="form-grid">
        <label className="field" htmlFor={ids.name}>
          <span>{t('Name')}</span>
          <input id={ids.name} className="input" maxLength={32} value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="field" htmlFor={ids.pill}>
          <span>{t('It shows')}</span>
          <select id={ids.pill} className="select" value={pillId ?? ''} onChange={(e) => setPillId(e.target.value || null)}>
            <option value="">{t('All pills')}</option>
            {pills
              .filter((p) => !p.archived)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
        <label className="field" htmlFor={ids.ssid}>
          <span>{t('Wi-Fi for the screen')}</span>
          <select id={ids.ssid} className="select" value={choice} onChange={(e) => setChoice(e.target.value)}>
            {choices.map((c) => (
              <option key={c} value={c}>
                {c === wifi.ssid ? t("{name} (the hub's)", { name: c }) : c}
              </option>
            ))}
            <option value={OTHER}>{t('Another network…')}</option>
          </select>
        </label>
        {choice === OTHER && (
          <label className="field" htmlFor={ids.other}>
            <span>{t('Network name')}</span>
            <input id={ids.other} className="input" maxLength={32} value={other} onChange={(e) => setOther(e.target.value)} required />
          </label>
        )}
        <label className="field" htmlFor={ids.password}>
          <span>{t('Wi-Fi password')}</span>
          <input
            id={ids.password}
            className="input"
            type="password"
            autoComplete="off"
            maxLength={64}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
      </div>
      <p className="hint">
        {hubsOwn ? `${t('Leave the password empty to use the one the hub has.')} ` : ''}
        {t('Screens only use 2.4 GHz Wi-Fi. They need to reach the hub on that network.')}
      </p>

      {only5 && (
        <div className="notice warning">
          <Icon name="alert" />
          <p>{t("The hub only sees this network on 5 GHz, which the screen can't use.")}</p>
        </div>
      )}
      {hotspot.kind === 'sdpro' && (
        <div className="notice">
          <Icon name="info" />
          <p>
            {t(
              "RaptHooker puts its own firmware on the screen in place of the one it came with. Keep the screen plugged in until it's done. You can put the original back later from the screen's details.",
            )}
          </p>
        </div>
      )}
      {wifi.goesOffline && (
        <div className="notice warning">
          <Icon name="wifiOff" />
          <p>
            {t(
              "The hub's only connection is Wi-Fi, so it's off your network for a minute or two while it talks to the screen. This page reconnects by itself.",
            )}
          </p>
        </div>
      )}

      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onBack}>
          {t('Back')}
        </button>
        <button type="submit" className="btn primary" disabled={!ready || busy}>
          <Icon name="zap" size={16} /> {t('Set it up')}
        </button>
      </div>
    </form>
  );
}
