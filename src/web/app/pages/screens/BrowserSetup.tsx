import { useEffect, useId, useRef, useState } from 'react';
import {
  GEEKMAGIC_ULTRA,
  screenHotspot,
  screenStock,
  screenTrialError,
  type HubAddress,
  type ScreenFirmware,
  type ScreenManualStart,
  type StockKind,
} from '@rapthooker/shared';
import { errorText, http } from '../../api';
import { useLive } from '../../live';
import { t } from '../../i18n';
import { Icon } from '../../components/Icon';
import { screensApi } from './screensApi';
import { ByAddress, newScreenName, useNewLook } from './AddScreen';
import { SETUP_ERRORS, USB_INSTALL_DOCS, WIFI_REASONS } from './strings';

/**
 * Setting a screen up from this browser, for a hub that can't switch Wi-Fi networks (in Docker, say). The page
 * fetches what it needs from the hub first, then this device joins the screen's own Wi-Fi and the page talks to the
 * screen at 192.168.4.1 directly: it puts RaptHooker firmware on a stock screen through the stock firmware's update
 * page, gives the screen the Wi-Fi details and its key, and once this device is back on the hub's network, tells the
 * hub about the new screen.
 *
 * The Smart weather clock's stock firmware doesn't allow other pages to read its answers (no CORS), so the page
 * recognises it by its stylesheet (which any page may use) and sends the firmware without seeing the reply. A
 * GeekMagic Ultra's own firmware lets other pages read its update page's answers, but perhaps not what model it is:
 * then this asks. A GeekMagic already on the hub's network can have the hub put RaptHooker on it instead, and this
 * finishes on RaptHooker's hotspot. RaptHooker's firmware, once running, says which firmware it has.
 */

const SCREEN = 'http://192.168.4.1';
/** What the stock firmware's update page can take: it cuts anything bigger short (and the screen won't start). */
const STOCK_LIMIT = 0x7c000;
/** Both stock firmwares get the same image: they're the same hardware. */
const STOCK_MODEL = 'sdpro-240';

interface Info {
  firmware: string;
  version: string;
  model: string;
  id: string;
  mac: string;
  claimed: boolean;
  system?: { sketchMd5?: string; store?: boolean };
}

type Phase = 'details' | 'join' | 'checking' | 'confirm' | 'installing' | 'restarting' | 'wifi' | 'back' | 'done' | 'failed';

/** Where "Try again" goes after a failure. */
type Retry = 'details' | 'join' | 'wifi' | 'back';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await run(ctl.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** RaptHooker firmware on the screen at 192.168.4.1, or null. */
async function ourScreen(): Promise<Info | null> {
  try {
    return await withTimeout(4000, async (signal) => {
      const res = await fetch(`${SCREEN}/api/info`, { signal, cache: 'no-store' });
      const info = (await res.json()) as Info;
      return res.ok && info.firmware === 'rapthooker-screen' ? info : null;
    });
  } catch {
    return null;
  }
}

/** Whether the screen at 192.168.4.1 is a stock Smart Weather Clock, going by what its stylesheet does. */
function stockScreen(timeoutMs = 10_000): Promise<boolean> {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
    frame.srcdoc = `<!doctype html><link rel="stylesheet" href="${SCREEN}/style.css"><div class="WiFi-settings"></div><div class="progress-track"></div>`;
    let settled = false;
    const finish = (yes: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      frame.remove();
      resolve(yes);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    frame.addEventListener('load', () => {
      try {
        const doc = frame.contentDocument;
        const win = frame.contentWindow;
        const card = doc?.querySelector('.WiFi-settings');
        const track = doc?.querySelector('.progress-track');
        if (!doc || !win || !card || !track) return finish(false);
        const c = win.getComputedStyle(card);
        finish(c.borderTopLeftRadius === '12px' && c.backgroundColor === 'rgb(28, 28, 30)' && win.getComputedStyle(track).height === '8px');
      } catch {
        finish(false);
      }
    });
    document.body.append(frame);
  });
}

/**
 * A GeekMagic on its own firmware at 192.168.4.1: what it says it is at /v.json; 'unreadable' when something answers
 * there but doesn't let this page read it (GeekMagic's firmware may not); null when it isn't one, or nothing answers.
 */
export async function geekmagicScreen(): Promise<{ model: string } | 'unreadable' | null> {
  let res: Response;
  try {
    res = await withTimeout(6000, (signal) => fetch(`${SCREEN}/v.json`, { signal, cache: 'no-store' }));
  } catch {
    try {
      await withTimeout(6000, (signal) => fetch(`${SCREEN}/v.json`, { signal, mode: 'no-cors', cache: 'no-store' }));
      return 'unreadable';
    } catch {
      return null;
    }
  }
  try {
    const v = (await res.json()) as { m?: unknown };
    return res.ok && typeof v.m === 'string' && v.m ? { model: v.m } : null;
  } catch {
    return null;
  }
}

export function BrowserSetup({ reason, onDone }: { reason: string | null; onDone: () => void }) {
  const { pills, screens, upsertScreen } = useLive();
  const look = useNewLook();
  const ids = { name: useId(), pill: useId(), ssid: useId(), password: useId() };
  const [name, setName] = useState(() => newScreenName(screens.map((s) => s.name)));
  const [pillId, setPillId] = useState<string | null>(null);
  const [ssid, setSsid] = useState('');
  const [password, setPassword] = useState('');
  const [phase, setPhase] = useState<Phase>('details');
  const [note, setNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ message: string; detail?: string; retry: Retry; help?: string } | null>(null);
  const [lan, setLan] = useState<string[]>([]);
  const prepared = useRef<{ start: ScreenManualStart; firmware: ArrayBuffer } | null>(null);
  const screen = useRef<Info | null>(null);
  const joinedIp = useRef<string | null>(null);
  const alive = useRef(true);
  const https = window.location.protocol === 'https:';

  useEffect(() => {
    alive.current = true;
    if (https)
      http.get<HubAddress[]>('/api/system/addresses').then(
        (list) => alive.current && setLan(list.filter((a) => a.kind === 'lan').map((a) => a.url)),
        () => undefined,
      );
    return () => {
      alive.current = false;
    };
  }, [https]);

  const fail = (message: string, retry: Retry, detail?: string, help?: string) => {
    if (!alive.current) return;
    setNote(null);
    setFailure({ message, detail, retry, help });
    setPhase('failed');
  };

  /** Everything from the hub, while this device is still on its network. */
  const prepare = async () => {
    setNote(null);
    try {
      const start = await screensApi.manual({ name: name.trim(), pillId, look });
      const fw = start.firmware.find((f) => f.model === STOCK_MODEL);
      if (!fw) throw new Error(t('The hub has no firmware for this screen.'));
      const res = await fetch(screensApi.firmwareUrl(fw.model), { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const firmware = await res.arrayBuffer();
      if (firmware.byteLength !== fw.size || firmware.byteLength > STOCK_LIMIT || new Uint8Array(firmware)[0] !== 0xe9)
        throw new Error(t("The firmware from the hub didn't arrive whole. Try again."));
      prepared.current = { start, firmware };
      setPhase('join');
    } catch (err) {
      fail(t("Couldn't get ready"), 'details', errorText(err));
    }
  };

  /** This device is on the screen's network: see what's there. */
  const check = async () => {
    setPhase('checking');
    const ours = await ourScreen();
    if (ours) {
      // Before the rest: such a board says it's claimed after a set-up it couldn't save.
      if (ours.system?.store === false) return fail(t(SETUP_ERRORS['no-store']), 'join', undefined, USB_INSTALL_DOCS);
      if (ours.claimed)
        return fail(t('This screen belongs to another hub.'), 'join', t('Reset it from that hub, or add it from Found on your network.'));
      screen.current = ours;
      return void connect();
    }
    if (await stockScreen()) return void install('sdpro');
    const gm = await geekmagicScreen();
    if (gm === 'unreadable') return setPhase('confirm');
    if (gm?.model === GEEKMAGIC_ULTRA) return void install('geekmagic');
    if (gm)
      return fail(
        t("This is a GeekMagic {model}, which RaptHooker can't set up: only the Ultra has the hardware its firmware is for.", {
          model: gm.model,
        }),
        'join',
      );
    fail(
      t("This device can't see a screen RaptHooker knows."),
      'join',
      t('Check this device is on the screen\'s Wi-Fi ("Smart weather clock", or "GIFTV" on a GeekMagic Ultra), then try again.'),
    );
  };

  const install = async (kind: StockKind) => {
    const p = prepared.current!;
    const fw = p.start.firmware.find((f) => f.model === STOCK_MODEL)!;
    setPhase('installing');
    const form = new FormData();
    const file = new Blob([p.firmware], { type: 'application/octet-stream' });
    let sent = true;
    if (kind === 'sdpro') {
      // The stock update page only sends files whose name starts SDP.
      form.append('update', file, `SDP-rapthooker-screen-${fw.model}-${fw.version}.bin`);
      try {
        await withTimeout(180_000, (signal) => fetch(`${SCREEN}/update_ota`, { method: 'POST', mode: 'no-cors', body: form, signal }));
      } catch {
        sent = false;
      }
    } else {
      // GeekMagic's update page lets this page read what it says: "Update Success! Rebooting..." or "Update error: …".
      form.append('firmware', file, `rapthooker-screen-${fw.model}-${fw.version}.bin`);
      try {
        const text = await withTimeout(180_000, async (signal) =>
          (await fetch(`${SCREEN}/update`, { method: 'POST', body: form, signal })).text(),
        );
        if (!/Update Success/i.test(text)) {
          const error = /Update error:\s*([^<\r\n]*)/i.exec(text)?.[1]?.trim();
          return fail(t(SETUP_ERRORS['install-failed']), 'join', error || text.trim().slice(0, 80));
        }
      } catch {
        sent = false;
      }
    }
    if (!alive.current) return;
    setNote(
      sent
        ? null
        : t('The screen may not have got the whole firmware. If its network is still called "{name}", try again.', {
            name: screenStock(kind).hotspot,
          }),
    );
    await restarted(fw);
  };

  /** A GeekMagic Ultra on the hub's network: the hub puts RaptHooker on it, then this finishes on its hotspot. */
  const installFromHub = async (address: string) => {
    setNote(null);
    setPhase('installing');
    try {
      const r = await screensApi.install(address);
      if (!alive.current) return;
      await restarted(r.firmware);
    } catch (err) {
      fail(t("Couldn't put RaptHooker on the screen"), 'join', errorText(err));
    }
  };

  /** It restarts, copies the firmware into place and opens RaptHooker's network: this device has to join it. */
  const restarted = async (fw: ScreenFirmware) => {
    setPhase('restarting');
    await sleep(8000);
    const until = Date.now() + 5 * 60_000;
    while (alive.current) {
      const info = await ourScreen();
      if (info) {
        if (info.version === fw.version && info.system?.sketchMd5 && info.system.sketchMd5 !== fw.md5)
          return fail(t(SETUP_ERRORS['install-failed']), 'join', t("The firmware on the screen isn't the one sent."));
        screen.current = info;
        return void connect();
      }
      if (Date.now() > until) return fail(t(SETUP_ERRORS['no-restart']), 'join');
      await sleep(2500);
    }
  };

  /** Gives the screen the Wi-Fi details and its key, and waits for it to join. */
  const connect = async () => {
    const p = prepared.current!;
    const info = screen.current!;
    setPhase('wifi');
    setNote(null);
    try {
      // The screen moves its own network to the channel of the one it joins: tell it which, so that happens first.
      let channel = 0;
      try {
        const scan = await withTimeout(15_000, async (signal) => (await fetch(`${SCREEN}/api/scan`, { signal })).json());
        const nets = (scan as { networks?: { ssid: string; channel: number; rssi: number }[] }).networks ?? [];
        channel = nets.filter((n) => n.ssid === ssid.trim()).sort((a, b) => b.rssi - a.rssi)[0]?.channel ?? 0;
      } catch {}
      const res = await withTimeout(10_000, (signal) =>
        fetch(`${SCREEN}/api/setup`, {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ssid: ssid.trim(),
            password,
            token: p.start.token,
            hub: p.start.hub,
            name: name.trim(),
            imageUrl: p.start.imageBase ? `${p.start.imageBase}${info.id}/image.jpg` : '',
            interval: 60,
            brightness: 80,
            channel,
          }),
        }),
      );
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? String(res.status));
    } catch (err) {
      return fail(t(SETUP_ERRORS['screen-unreachable']), 'join', errorText(err));
    }
    const until = Date.now() + 90_000;
    for (;;) {
      await sleep(1500);
      if (!alive.current) return;
      const s = await withTimeout(4000, async (signal) => {
        const res = await fetch(`${SCREEN}/api/setup`, { signal, cache: 'no-store' });
        return (await res.json()) as { trial: string; error: string; ip?: string; saved: boolean };
      }).catch(() => null);
      if (!s) setNote(t('If this device left the screen\'s network, join "{name}" again.', { name: screenHotspot(info.mac) }));
      else if (s.trial === 'connected' && s.saved) {
        joinedIp.current = s.ip ?? null;
        break;
      } else if (s.trial === 'failed') return fail(t(SETUP_ERRORS[screenTrialError(s.error)]), 'wifi', s.error);
      if (Date.now() > until) return fail(t(SETUP_ERRORS['wifi-failed']), 'wifi');
    }
    await withTimeout(5000, (signal) =>
      fetch(`${SCREEN}/api/setup/finish`, { method: 'POST', signal, headers: { Authorization: `Bearer ${p.start.token}` } }),
    ).catch(() => undefined);
    void tellHub();
  };

  /** Back on the hub's network: tell the hub about the screen. */
  const tellHub = async () => {
    const p = prepared.current!;
    const info = screen.current!;
    if (!alive.current) return;
    setNote(null);
    setPhase('back');
    for (;;) {
      await sleep(2500);
      if (!alive.current) return;
      try {
        const added = await screensApi.manualDone({ pending: p.start.pending, id: info.id, model: info.model, ip: joinedIp.current });
        upsertScreen(added);
        setPhase('done');
        return;
      } catch (err) {
        // Not back on the hub's network yet; anything else is final.
        if ((err as { status?: number }).status) return fail(t("Couldn't add the screen to the hub"), 'back', errorText(err));
      }
    }
  };

  const retry = () => {
    if (!failure) return;
    if (failure.retry === 'wifi' && screen.current) void connect();
    else if (failure.retry === 'back' && screen.current) void tellHub();
    else setPhase(failure.retry === 'join' && prepared.current ? 'join' : 'details');
  };

  const ours = screen.current ? screenHotspot(screen.current.mac) : 'RaptHooker-Screen-…';
  const home = ssid.trim() || t('your Wi-Fi');
  const STEP: Record<Exclude<Phase, 'failed'>, number> = {
    details: 1,
    join: 2,
    checking: 2,
    confirm: 2,
    installing: 3,
    restarting: 3,
    wifi: 3,
    back: 4,
    done: 5,
  };
  const lastStep = useRef(1);
  if (phase !== 'failed') lastStep.current = STEP[phase];
  const current = lastStep.current;

  return (
    <div className="stack browser-setup">
      {reason ? (
        <div className="notice">
          <Icon name="info" />
          <p>
            {t(WIFI_REASONS[reason] ?? reason)}{' '}
            {t('You can set the screen up from this device instead: it needs Wi-Fi and to stay on this page.')}
          </p>
        </div>
      ) : (
        <p className="muted">
          {t(
            "This device does the setting up: it joins the screen's Wi-Fi itself for a few minutes, so it needs Wi-Fi, and this page has to stay open until the end.",
          )}
        </p>
      )}
      {https && (
        <div className="notice danger" role="alert">
          <Icon name="lock" />
          <p>
            {t(
              "This page is on https, and browsers won't let it talk to the screen, which only has http. Open the hub at its address on your network instead:",
            )}{' '}
            {lan.map((u) => (
              <a key={u} href={`${u}/#/screens`}>
                {u}
              </a>
            ))}
          </p>
        </div>
      )}

      <ol className="setup-steps browser">
        {[
          t('Tell the hub about the screen'),
          t("Join the screen's Wi-Fi on this device"),
          t('Set the screen up'),
          t('Back to your Wi-Fi'),
        ].map((title, i) => (
          <BrowserStep
            key={title}
            n={i + 1}
            on={current === i + 1}
            done={current > i + 1}
            failed={phase === 'failed' && current === i + 1}
            title={title}
          />
        ))}
      </ol>

      {phase === 'details' && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void prepare();
          }}
        >
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
              <input id={ids.ssid} className="input" maxLength={32} value={ssid} onChange={(e) => setSsid(e.target.value)} required />
            </label>
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
          <p className="hint">{t('Screens only use 2.4 GHz Wi-Fi. They need to reach the hub on that network.')}</p>
          <div className="modal-actions">
            <button type="submit" className="btn primary" disabled={https || !name.trim() || !ssid.trim()}>
              {t('Next')}
            </button>
          </div>
        </form>
      )}

      {phase === 'join' && (
        <div className="stack">
          <p>
            {t(
              'On this device, join the screen\'s Wi-Fi network: "Smart weather clock", "GIFTV" on a GeekMagic Ultra, or "RaptHooker-Screen-…" for a screen that already has RaptHooker. Then come back to this page.',
            )}
          </p>
          <p className="hint">{t("If the device says the network has no internet, choose to stay connected. Don't reload this page.")}</p>
          <div className="modal-actions">
            <button type="button" className="btn primary" onClick={() => void check()}>
              <Icon name="check" size={16} /> {t("I've joined it")}
            </button>
          </div>
          <ByAddress action={t('Install RaptHooker')} onPick={(address) => void installFromHub(address)} />
        </div>
      )}

      {phase === 'checking' && <Waiting text={t('Checking the screen…')} />}
      {phase === 'confirm' && (
        <div className="stack">
          <div className="notice warning">
            <Icon name="alert" />
            <p>
              {t(
                "The screen doesn't let this page check which GeekMagic it is. Only go on if it's a GeekMagic Ultra (a new one shows GIFTV and http://192.168.4.1): other models can't take RaptHooker.",
              )}
            </p>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={() => setPhase('join')}>
              {t('Back')}
            </button>
            <button type="button" className="btn primary" onClick={() => void install('geekmagic')}>
              {t("It's a GeekMagic Ultra")}
            </button>
          </div>
        </div>
      )}
      {phase === 'installing' && <Waiting text={t('Installing RaptHooker firmware. Keep the screen plugged in and this page open…')} />}
      {phase === 'restarting' && (
        <Waiting
          text={t('The screen is restarting with RaptHooker. When the network "{name}" appears, join it on this device.', { name: ours })}
        />
      )}
      {phase === 'wifi' && <Waiting text={t('Connecting the screen to {name}…', { name: home })} />}
      {phase === 'back' && <Waiting text={t('The screen is on {name}. Now switch this device back to {name}.', { name: home })} />}
      {note && <p className="hint">{note}</p>}

      {phase === 'done' && (
        <div className="notice success">
          <Icon name="circleCheck" />
          <p className="grow">
            <strong>{t('{name} is set up', { name: name.trim() })}</strong> {t('It shows its first picture in a moment.')}
          </p>
          <button type="button" className="btn primary" onClick={onDone}>
            {t('Done')}
          </button>
        </div>
      )}

      {phase === 'failed' && failure && (
        <div className="notice danger" role="alert">
          <Icon name="alert" />
          <div className="grow stack">
            <p>
              <strong>{failure.message}</strong>
            </p>
            {failure.detail && <p className="small">{failure.detail}</p>}
            {failure.help && (
              <p className="small">
                <a href={failure.help} target="_blank" rel="noreferrer">
                  {t('How to install it over USB')}
                </a>
              </p>
            )}
            {failure.retry === 'wifi' && (
              <div className="form-grid">
                <label className="field" htmlFor={`${ids.ssid}-again`}>
                  <span>{t('Wi-Fi for the screen')}</span>
                  <input id={`${ids.ssid}-again`} className="input" maxLength={32} value={ssid} onChange={(e) => setSsid(e.target.value)} />
                </label>
                <label className="field" htmlFor={`${ids.password}-again`}>
                  <span>{t('Wi-Fi password')}</span>
                  <input
                    id={`${ids.password}-again`}
                    className="input"
                    type="password"
                    autoComplete="off"
                    maxLength={64}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
              </div>
            )}
          </div>
          <button type="button" className="btn" disabled={failure.retry === 'wifi' && !ssid.trim()} onClick={retry}>
            {t('Try again')}
          </button>
        </div>
      )}
    </div>
  );
}

function BrowserStep({ n, on, done, failed, title }: { n: number; on: boolean; done: boolean; failed: boolean; title: string }) {
  return (
    <li className={failed ? 'failed' : on ? 'on' : done ? 'done' : ''} aria-current={on ? 'step' : undefined}>
      <span className="setup-step-mark">{failed ? <Icon name="x" size={14} /> : done ? <Icon name="check" size={14} /> : n}</span>
      {title}
    </li>
  );
}

function Waiting({ text }: { text: string }) {
  return (
    <p className="setup-waiting" role="status">
      <span className="spinner" aria-hidden="true" /> {text}
    </p>
  );
}
