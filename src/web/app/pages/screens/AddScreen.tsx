import { useCallback, useEffect, useId, useState } from 'react';
import {
  SCREEN_MODELS,
  screenAddress,
  screenStock,
  type HotspotKind,
  type ScreenDevice,
  type ScreenSetupProgress,
  type UsbPort,
  type UsbStatus,
  type WifiNetwork,
  type WifiStatus,
} from '@rapthooker/shared';
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
import { USB_REASONS } from './strings';

const KIND_LABELS: Record<HotspotKind, () => string> = {
  sdpro: () => t('{name}, as it came', { name: screenStock('sdpro').name }),
  geekmagic: () => t('{name}, as it came', { name: screenStock('geekmagic').name }),
  rapthooker: () => t('RaptHooker screen, waiting to be set up'),
};

const WIFI_MODELS = SCREEN_MODELS.filter((m) => m.install === 'hotspot');
const USB_MODELS = SCREEN_MODELS.filter((m) => m.install === 'usb');

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

type Method = 'wifi' | 'usb';
/**
 * What's being set up: a screen's own hotspot, a GeekMagic Ultra on the hub's network (by its address), or a board on
 * one of the hub's USB ports (maybe a screen it has).
 */
type Target =
  { kind: 'hotspot'; net: WifiNetwork } | { kind: 'address'; address: string } | { kind: 'usb'; port: UsbPort; screen?: ScreenDevice };

/** The hub's screen on a port, if the board there said it's one of them. */
const screenOn = (port: UsbPort, screens: ScreenDevice[]) => (port.board ? screens.find((s) => s.id === port.board!.id) : undefined);

/**
 * Adding a screen, one of two ways. Wi-Fi screens: the hub looks for Wi-Fi networks (a new screen opens its own),
 * then joins the one picked to put RaptHooker firmware on the screen and connect it to the hub's network (a GeekMagic
 * Ultra already on the network can have RaptHooker put on it from its address instead); a hub that can't switch Wi-Fi
 * networks hands over to BrowserSetup, which does the same from this browser. USB boards: plugged into the hub, which
 * writes the firmware and the Wi-Fi details over USB.
 */
export function AddScreen({ onClose, onStarted }: { onClose: () => void; onStarted: (p: ScreenSetupProgress) => void }) {
  const { screens } = useLive();
  const [method, setMethod] = useState<Method | null>(null);
  const [wifi, setWifi] = useState<WifiStatus | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [nets, setNets] = useState<WifiNetwork[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [usb, setUsb] = useState<UsbStatus | null>(null);
  const [usbFailed, setUsbFailed] = useState<string | null>(null);
  const [lookingUsb, setLookingUsb] = useState(false);
  const [picked, setPicked] = useState<Target | null>(null);
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

  const lookUsb = useCallback(async () => {
    setLookingUsb(true);
    try {
      const status = await screensApi.usb();
      setUsb(status);
      setUsbFailed(null);
      return status;
    } catch (err) {
      setUsbFailed(errorText(err));
      return null;
    } finally {
      setLookingUsb(false);
    }
  }, []);

  useEffect(() => {
    let live = true;
    screensApi.wifi().then(
      (w) => live && setWifi(w),
      (err) => live && setFailed(errorText(err)),
    );
    // A board plugged in that isn't one of the hub's screens already: that's what's being added.
    void lookUsb().then((status) => {
      const fresh = status?.ports.some((p) => p.likely && !screenOn(p, screens));
      if (live) setMethod((m) => m ?? (fresh ? 'usb' : 'wifi'));
    });
    return () => {
      live = false;
    };
    // Only as it opens: the screens it knows then decide the tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookUsb]);

  // Wi-Fi networks only when they're wanted: a scan takes the hub's Wi-Fi a few seconds.
  useEffect(() => {
    if (method === 'wifi' && wifi?.canSetUp && nets === null && !scanning) void scan();
  }, [method, wifi, nets, scanning, scan]);

  const title = (
    <>
      <Icon name="screen" /> {t('Add a screen')}
    </>
  );

  if (picked) {
    return (
      <Modal title={title} onClose={onClose} wide className="add-screen">
        <SetupForm target={picked} wifi={wifi} nets={nets ?? []} onBack={() => setPicked(null)} onStarted={onStarted} />
      </Modal>
    );
  }

  return (
    <Modal title={title} onClose={onClose} wide className="add-screen">
      <div className="segmented add-screen-methods" role="group" aria-label={t('How the screen connects')}>
        <button type="button" className={method === 'wifi' ? 'on' : ''} aria-pressed={method === 'wifi'} onClick={() => setMethod('wifi')}>
          <Icon name="wifi" size={16} /> {t('Wi-Fi screen')}
        </button>
        <button type="button" className={method === 'usb' ? 'on' : ''} aria-pressed={method === 'usb'} onClick={() => setMethod('usb')}>
          <Icon name="cpu" size={16} /> {t('Plugged into the hub (USB)')}
        </button>
      </div>
      {method && (
        <p className="small muted add-screen-models">
          {t('For: {names}', { names: (method === 'wifi' ? WIFI_MODELS : USB_MODELS).map((m) => m.name).join(', ') })}
        </p>
      )}
      {method === null && <div className="skeleton" style={{ height: '6rem' }} />}
      {method === 'wifi' &&
        (fromBrowser || (wifi && !wifi.canSetUp) ? (
          <BrowserSetup reason={wifi && !wifi.canSetUp ? wifi.reason : null} onDone={onClose} />
        ) : (
          <>
            <ScanList
              nets={nets}
              scanning={scanning}
              failed={failed}
              onScan={() => void scan()}
              onPick={(net) => setPicked({ kind: 'hotspot', net })}
            />
            {wifi?.canSetUp && <ByAddress onPick={(address) => setPicked({ kind: 'address', address })} />}
            {wifi?.canSetUp && (
              <p className="hint">
                <button type="button" className="link-btn" onClick={() => setFromBrowser(true)}>
                  {t('Set it up from this device instead')}
                </button>{' '}
                {t("(if the screen is out of the hub's reach)")}
              </p>
            )}
          </>
        ))}
      {method === 'usb' && (
        <UsbList
          status={usb}
          failed={usbFailed}
          looking={lookingUsb}
          onLook={() => void lookUsb()}
          screens={screens}
          onPick={(port, screen) => {
            setPicked({ kind: 'usb', port, screen });
            // The networks around, for the board's Wi-Fi (the hub may be on a cable, so not on one itself).
            if (wifi?.canSetUp && nets === null && !scanning) void scan();
          }}
        />
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
          'Plug the screen in near the hub. A new one opens its own Wi-Fi network, called "Smart weather clock" ("GIFTV" on a GeekMagic Ultra): the hub joins it for a minute to put RaptHooker on the screen and connect it to your Wi-Fi.',
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

/**
 * A GeekMagic Ultra that has joined the network with its own firmware (its hotspot only opens for a minute after it
 * starts then): set up from its address instead.
 */
export function ByAddress({ onPick, busy = false, action }: { onPick: (address: string) => void; busy?: boolean; action?: string }) {
  const id = useId();
  const [text, setText] = useState('');
  const address = screenAddress(text);
  return (
    <details className="wifi-others by-address">
      <summary>{t('A GeekMagic Ultra already on your Wi-Fi?')}</summary>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (address && !busy) onPick(address);
        }}
      >
        <p className="hint">
          {t(
            "Its own firmware shows its address on the screen, like 192.168.1.50. RaptHooker checks it's a GeekMagic Ultra before changing anything.",
          )}
        </p>
        <div className="by-address-row">
          <label className="field" htmlFor={id}>
            <span>{t("The screen's address")}</span>
            <input
              id={id}
              className="input"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              maxLength={260}
              placeholder="192.168.1.50"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <button type="submit" className="btn" disabled={!address || busy}>
            {action ?? t('Set up')}
          </button>
        </div>
      </form>
    </details>
  );
}

/** The hub's serial ports: a board plugged into its USB is one of them. */
function UsbList({
  status,
  failed,
  looking,
  screens,
  onLook,
  onPick,
}: {
  status: UsbStatus | null;
  failed: string | null;
  looking: boolean;
  screens: ScreenDevice[];
  onLook: () => void;
  onPick: (p: UsbPort, screen?: ScreenDevice) => void;
}) {
  // Boards that said they're one of the hub's screens (firmware 1.1.1 and later answer over USB) are set apart.
  const likely = (status?.ports ?? []).filter((p) => p.likely);
  const boards = likely.filter((p) => !screenOn(p, screens));
  const yours = likely.filter((p) => screenOn(p, screens));
  const others = (status?.ports ?? []).filter((p) => !p.likely);
  const can = status?.canSetUp ?? false;
  return (
    <div className="stack">
      <p className="muted">
        {t(
          "Plug the board into one of the hub's USB ports, with a cable that carries data (some only charge). The hub puts RaptHooker on it and connects it to your Wi-Fi, without leaving its own network. It takes about a minute.",
        )}
      </p>
      <div className="row">
        <button type="button" className="btn" disabled={looking} onClick={onLook}>
          <Icon name="refresh" size={16} /> {looking ? t('Looking…') : t('Look again')}
        </button>
      </div>
      {failed && (
        <div className="notice danger" role="alert">
          <Icon name="alert" />
          <p>{failed}</p>
        </div>
      )}
      {status && !can && (
        <div className="notice warning" role="status">
          <Icon name="alert" />
          <p>{t(USB_REASONS[status.reason ?? ''] ?? USB_REASONS['no-esptool']!)}</p>
        </div>
      )}
      {status === null && looking && <div className="skeleton" style={{ height: '4rem' }} />}
      {status && (
        <>
          <h3 className="subhead">{t('Boards')}</h3>
          {boards.length === 0 ? (
            <div className="notice">
              <Icon name="info" />
              <p>
                {yours.length
                  ? t('Every board plugged in is one of your screens already. Plug a new one in and look again.')
                  : t(
                      "No boards plugged in. Check the cable carries data, and look again. A board's USB chip can also need a driver on some systems.",
                    )}
              </p>
            </div>
          ) : (
            <ul className="wifi-list">
              {boards.map((p) => (
                <UsbRow key={p.path} port={p} can={can} onPick={onPick} highlight />
              ))}
            </ul>
          )}
          {yours.length > 0 && (
            <>
              <h3 className="subhead">{t('Already set up')}</h3>
              <ul className="wifi-list">
                {yours.map((p) => {
                  const screen = screenOn(p, screens)!;
                  return (
                    <li key={p.path} className="wifi-row">
                      <Icon name="screen" />
                      <div className="grow">
                        <strong>{screen.name}</strong>
                        <span className="small muted num">
                          {p.path} · {t('firmware {version}', { version: p.board!.firmware })}
                        </span>
                      </div>
                      <button type="button" className="btn small ghost" disabled={!can} onClick={() => onPick(p, screen)}>
                        {t('Set up again')}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {others.length > 0 && (
            <details className="wifi-others">
              <summary>{tp(others.length, '{count} other port', '{count} other ports')}</summary>
              <p className="hint">
                {t("If your board isn't listed above, it may be one of these. RaptHooker checks the board before writing anything.")}
              </p>
              <ul className="wifi-list">
                {others.map((p) => (
                  <UsbRow key={p.path} port={p} can={can} onPick={onPick} />
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function UsbRow({
  port,
  can,
  onPick,
  highlight = false,
}: {
  port: UsbPort;
  can: boolean;
  onPick: (p: UsbPort) => void;
  highlight?: boolean;
}) {
  return (
    <li className={`wifi-row${highlight ? ' likely' : ''}`}>
      <Icon name="cpu" />
      <div className="grow">
        <strong>{port.name}</strong>
        <span className="small muted num">
          {port.path}
          {port.vid && port.pid ? ` · ${port.vid}:${port.pid}` : ''}
          {port.board ? ` · ${t('RaptHooker screen from another hub')}` : ''}
        </span>
      </div>
      <button type="button" className={`btn small${highlight ? ' primary' : ''}`} disabled={!can} onClick={() => onPick(port)}>
        {t('Set up')}
      </button>
    </li>
  );
}

const OTHER = '\u0000other';

function SetupForm({
  target,
  wifi,
  nets,
  onBack,
  onStarted,
}: {
  target: Target;
  wifi: WifiStatus | null;
  nets: WifiNetwork[];
  onBack: () => void;
  onStarted: (p: ScreenSetupProgress) => void;
}) {
  const { pills, screens, toast } = useLive();
  const look = useNewLook();
  const ids = { name: useId(), pill: useId(), ssid: useId(), other: useId(), password: useId(), model: useId() };
  const usb = target.kind === 'usb';
  // The networks the screen could join: 2.4 GHz ones that aren't screens, the hub's own first.
  const hubSsid = wifi?.ssid ?? null;
  const choices = [
    ...new Set([...(hubSsid ? [hubSsid] : []), ...nets.filter((n) => n.band === 2.4 && n.kind === null && n.ssid).map((n) => n.ssid)]),
  ];
  const again = target.kind === 'usb' ? target.screen : undefined;
  const [name, setName] = useState(() => again?.name ?? newScreenName(screens.map((s) => s.name)));
  const [pillId, setPillId] = useState<string | null>(again?.pillId ?? null);
  const [model, setModel] = useState(again?.model ?? USB_MODELS[0]?.id ?? '');
  const [choice, setChoice] = useState(choices[0] ?? OTHER);
  const [chosen, setChosen] = useState(false);
  const [other, setOther] = useState('');
  // Networks found after the form opened (a scan for a USB board): the first one, unless one was picked already.
  const first = choices[0];
  useEffect(() => {
    if (!chosen && first && choice === OTHER) setChoice(first);
  }, [chosen, first, choice]);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const ssid = choice === OTHER ? other.trim() : choice;
  const hubsOwn = ssid !== '' && ssid === hubSsid && !!wifi?.knowsPassword;
  const only5 = ssid !== '' && nets.some((n) => n.ssid === ssid) && !nets.some((n) => n.ssid === ssid && n.band === 2.4);
  const ready = name.trim() !== '' && ssid !== '' && (hubsOwn || password !== '') && (!usb || model !== '');

  const start = async () => {
    setBusy(true);
    try {
      const common = { ssid, password, name: name.trim(), pillId, look };
      onStarted(
        target.kind === 'usb'
          ? await screensApi.startUsbSetup({ port: target.port.path, model, ...common })
          : target.kind === 'address'
            ? await screensApi.startSetup({ hotspot: '', address: target.address, ...common })
            : await screensApi.startSetup({ hotspot: target.net.ssid, ...common }),
      );
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't start setting the screen up"), body: errorText(err) });
      setBusy(false);
    }
  };
  const stock =
    target.kind === 'address' || (target.kind === 'hotspot' && (target.net.kind === 'sdpro' || target.net.kind === 'geekmagic'));
  const geekmagic = target.kind === 'address' || (target.kind === 'hotspot' && target.net.kind === 'geekmagic');

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) void start();
      }}
    >
      <button type="button" className="back link-btn" onClick={onBack}>
        <Icon name="left" size={16} /> {usb ? t('Other boards') : t('Other screens')}
      </button>
      <div className="row">
        <Icon name={usb ? 'cpu' : 'screen'} />
        <div>
          <strong>{target.kind === 'usb' ? target.port.name : target.kind === 'address' ? target.address : target.net.ssid}</strong>
          <div className="small muted">
            {target.kind === 'usb'
              ? target.port.path
              : target.kind === 'address'
                ? t('A GeekMagic Ultra on your network')
                : target.net.kind
                  ? KIND_LABELS[target.net.kind]()
                  : t("A network RaptHooker doesn't recognise")}
          </div>
        </div>
      </div>

      <div className="form-grid">
        {usb && (
          <label className="field" htmlFor={ids.model}>
            <span>{t('Board')}</span>
            <select id={ids.model} className="select" value={model} onChange={(e) => setModel(e.target.value)}>
              {USB_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        )}
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
          <select
            id={ids.ssid}
            className="select"
            value={choice}
            onChange={(e) => {
              setChoice(e.target.value);
              setChosen(true);
            }}
          >
            {choices.map((c) => (
              <option key={c} value={c}>
                {c === hubSsid ? t("{name} (the hub's)", { name: c }) : c}
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
      {stock && (
        <div className="notice">
          <Icon name="info" />
          <p>
            {t(
              "RaptHooker puts its own firmware on the screen in place of the one it came with. Keep the screen plugged in until it's done. You can put the original back later from the screen's details.",
            )}
          </p>
        </div>
      )}
      {geekmagic && (
        <div className="notice warning">
          <Icon name="alert" />
          <p>
            {t(
              "Untested: RaptHooker hasn't been tried on a genuine GeekMagic Ultra yet. It's the same hardware as the Smart weather clock, and the hub checks it's an Ultra before changing anything.",
            )}
          </p>
        </div>
      )}
      {usb && (
        <div className="notice">
          <Icon name="info" />
          <p>
            {again
              ? t(
                  'This board is {name}. Setting it up again rewrites its firmware and Wi-Fi details; it keeps what it shows and its display corrections.',
                  { name: again.name },
                )
              : t(
                  'RaptHooker replaces whatever is on the board with its own firmware, then checks the screen looks right. Keep it plugged in until it says it is done.',
                )}
          </p>
        </div>
      )}
      {!usb && wifi?.goesOffline && (
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
