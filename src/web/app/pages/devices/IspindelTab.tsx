import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  ISPINDEL_INTERVALS,
  ISPINDEL_SETUP_STEPS,
  type IspindelHotspot,
  type IspindelInfo,
  type IspindelSetupProgress,
  type IspindelSetupStep,
} from '@rapthooker/shared';
import { errorText } from '../../api';
import { useLive, useLiveMessages } from '../../live';
import { duration, timeAgo, useNow } from '../../format';
import { href } from '../../router';
import { t } from '../../i18n';
import { Trans } from '../../i18n/Trans';
import { Icon } from '../../components/Icon';
import { NearbyCard } from '../dashboard/NearbyCard';
import { copyText } from '../settings/copy';
import { DeviceIntro } from './DeviceArt';
import { ISPINDEL_INTERVAL_LABELS, ISPINDEL_SETUP_ERRORS, ISPINDEL_STEP_LABELS, ispindelApi } from './ispindelApi';

/** The address of every iSpindel's setup page, on its own hotspot. */
const PORTAL_URL = 'http://192.168.4.1';
/** While the tab is open, the hub is asked to keep looking this often. */
const WATCH_EVERY_MS = 30_000;

/**
 * Adding an iSpindel: ones already sending to the hub, and setting one up, by the hub (from its setup hotspot) or by
 * hand (with every value to type, and the token made already).
 */
export function IspindelPanel({ onAdded }: { onAdded: () => void }) {
  const { nearby, isOwner, connection, toast } = useLive();
  const found = nearby.filter((n) => n.kind === 'ispindel');
  const [info, setInfo] = useState<IspindelInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hotspots, setHotspots] = useState<IspindelHotspot[]>([]);
  const [scannedAt, setScannedAt] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  const [setup, setSetup] = useState<IspindelSetupProgress | null>(null);
  const [how, setHow] = useState<'auto' | 'manual'>('auto');

  const load = useCallback(async () => {
    try {
      const i = await ispindelApi.info();
      setInfo(i);
      setHotspots(i.hotspots);
      setScannedAt(i.scannedAt);
      setSetup((cur) => (i.setup && (!cur || i.setup.updatedAt >= cur.updatedAt) ? i.setup : cur));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, []);

  // Again whenever the connection comes back: the hub may have been away setting an iSpindel up.
  useEffect(() => {
    if (connection === 'open') void load();
  }, [connection, load]);

  const canScan = isOwner && !!info?.wifi.canSetUp;
  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const r = await ispindelApi.scan();
      setHotspots(r.hotspots);
      setScannedAt(r.scannedAt);
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't look for iSpindels"), body: errorText(err) });
    } finally {
      setScanning(false);
    }
  }, [toast]);

  // Looks now, and keeps the hub looking every few seconds while this is open.
  const running = setup?.state === 'running';
  useEffect(() => {
    if (!canScan || running) return;
    void ispindelApi.scan().then(
      (r) => {
        setHotspots(r.hotspots);
        setScannedAt(r.scannedAt);
      },
      () => undefined,
    );
    const timer = window.setInterval(() => void ispindelApi.scan().catch(() => undefined), WATCH_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [canScan, running]);

  useLiveMessages((msg) => {
    if (msg.type === 'ispindel-hotspots') {
      setHotspots(msg.hotspots);
      setScannedAt(msg.scannedAt);
    } else if (msg.type === 'ispindel-setup') {
      setSetup(msg.setup);
    }
  });

  // Once this shows how a set-up ended, the hub needn't keep it: next time, the tab is ready to set up another.
  const ended = setup && setup.state !== 'running' ? setup.id : null;
  useEffect(() => {
    if (ended && isOwner) void ispindelApi.forget(ended).catch(() => undefined);
  }, [ended, isOwner]);

  return (
    <div className="stack">
      <DeviceIntro icon="wifi" name="iSpindel" badge={<span className="chip warning">{t('Experimental')}</span>}>
        {t('A DIY Wi-Fi hydrometer. It wakes up every so often and sends its reading to this hub over your Wi-Fi.')}
      </DeviceIntro>

      {found.length > 0 && (
        <section className="stack" aria-label={t('iSpindels sending to this hub')}>
          {found.map((n) => (
            <NearbyCard key={n.address} pill={n} onAdded={onAdded} />
          ))}
        </section>
      )}

      {loadError && (
        <div className="notice danger">
          <Icon name="alert" />
          <p>{loadError}</p>
        </div>
      )}

      <div className="segmented device-how" role="group" aria-label={t('How to set it up')}>
        <button type="button" className={how === 'auto' ? 'on' : ''} aria-pressed={how === 'auto'} onClick={() => setHow('auto')}>
          <Icon name="sparkles" size={14} /> {t('Set it up for me')}
        </button>
        <button type="button" className={how === 'manual' ? 'on' : ''} aria-pressed={how === 'manual'} onClick={() => setHow('manual')}>
          <Icon name="list" size={14} /> {t('Set it up by hand')}
        </button>
      </div>

      {how === 'auto' ? (
        <AutoSetup
          info={info}
          hotspots={hotspots}
          scannedAt={scannedAt}
          scanning={scanning}
          onScan={scan}
          setup={setup}
          onStarted={setSetup}
          onDismiss={() => setSetup(null)}
          onManual={() => setHow('manual')}
          onAdded={onAdded}
        />
      ) : (
        <ManualSetup info={info} />
      )}
    </div>
  );
}

const SetupModeHint = () => (
  <Trans
    text={t(
      'Put the iSpindel in setup mode: press its reset button (twice quickly, on some). For about 5 minutes it opens its own Wi-Fi network, whose name starts with {name}.',
    )}
    values={{ name: <strong>iSpindel</strong> }}
  />
);

function AutoSetup({
  info,
  hotspots,
  scannedAt,
  scanning,
  onScan,
  setup,
  onStarted,
  onDismiss,
  onManual,
  onAdded,
}: {
  info: IspindelInfo | null;
  hotspots: IspindelHotspot[];
  scannedAt: number | null;
  scanning: boolean;
  onScan: () => void;
  setup: IspindelSetupProgress | null;
  onStarted: (p: IspindelSetupProgress) => void;
  onDismiss: () => void;
  onManual: () => void;
  onAdded: () => void;
}) {
  const { isOwner } = useLive();
  const now = useNow(5000);
  const [picked, setPicked] = useState<string | null>(null);
  const target = hotspots.find((h) => h.ssid === picked) ?? (hotspots.length === 1 ? hotspots[0]! : null);

  if (!info) return <div className="skeleton" style={{ height: '10rem' }} aria-busy="true" />;
  if (setup) return <SetupProgress progress={setup} onDismiss={onDismiss} onAdded={onAdded} />;
  if (!info.wifi.canSetUp) {
    return (
      <div className="notice">
        <Icon name="wifiOff" />
        <div className="grow">
          <p>{t("This hub can't switch Wi-Fi networks, so it can't set an iSpindel up itself or look for ones in setup mode.")}</p>
          <button type="button" className="btn small" onClick={onManual}>
            {t('Set it up by hand')}
          </button>
        </div>
      </div>
    );
  }
  const where = info.server.host ? `${info.server.host}:${info.server.port}` : t('this hub');

  return (
    <div className="stack">
      <details className="device-explain" open>
        <summary>{t('What the hub does')}</summary>
        <ol>
          <li>
            {t("It joins the iSpindel's own Wi-Fi hotspot for about a minute, as your phone would to set it up.")}{' '}
            {info.wifi.goesOffline && (
              <strong>{t("The hub is off your network meanwhile: this page reconnects by itself when it's back.")}</strong>
            )}
          </li>
          <li>
            {t(
              "It reads the iSpindel's settings and changes only these: the Wi-Fi it joins, Service Type (HTTP), where it sends to (this hub, {where}), the token, and how often it sends. Its name (unless you give it a new one), its gravity formula and everything else stay as they are.",
              { where },
            )}
          </li>
          <li>{t('It saves them. The iSpindel leaves setup mode, restarts and joins your Wi-Fi.')}</li>
          <li>{t('The hub goes back to its own network, and adds the iSpindel as soon as its first reading arrives.')}</li>
        </ol>
      </details>

      <ol className="device-steps">
        <li>
          <SetupModeHint />
        </li>
        <li>{t('Pick it below when it shows up (the hub keeps looking), choose its settings and start.')}</li>
      </ol>

      <section className="device-hotspots" aria-label={t('iSpindels in setup mode')}>
        <div className="row">
          <h4 className="grow">{t('In setup mode nearby')}</h4>
          <span className="small muted">{scannedAt ? t('Looked {ago}', { ago: timeAgo(scannedAt, now) }) : t('Looking…')}</span>
          {isOwner && (
            <button type="button" className="btn small" onClick={onScan} disabled={scanning}>
              {scanning ? <span className="spinner" aria-hidden="true" /> : <Icon name="refresh" size={14} />} {t('Check again')}
            </button>
          )}
        </div>
        {hotspots.length === 0 ? (
          <p className="device-listening small">
            <span className="radar-dot" aria-hidden="true" /> {t('None yet. Put one in setup mode and it shows up here.')}
          </p>
        ) : (
          <ul className="hotspot-list">
            {hotspots.map((h) => (
              <li key={h.bssid}>
                <label className={`hotspot${target?.ssid === h.ssid ? ' on' : ''}`}>
                  <input type="radio" name="ispindel-hotspot" checked={target?.ssid === h.ssid} onChange={() => setPicked(h.ssid)} />
                  <Icon name="wifi" size={16} />
                  <span className="grow">
                    <strong>{h.ssid}</strong>
                    {h.chipId && <span className="small muted num"> · {t('chip {id}', { id: h.chipId })}</span>}
                  </span>
                  <span className="small muted num">{h.signal}%</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </section>

      {!isOwner ? (
        <a className="btn" href="#/settings">
          <Icon name="lock" /> {t('Sign in to set it up')}
        </a>
      ) : (
        target && <SetupForm key={target.bssid} info={info} target={target} onStarted={onStarted} />
      )}
    </div>
  );
}

const KEEP = '\u0000keep';
const OTHER = '\u0000other';

function SetupForm({
  info,
  target,
  onStarted,
}: {
  info: IspindelInfo;
  target: IspindelHotspot;
  onStarted: (p: IspindelSetupProgress) => void;
}) {
  const { toast } = useLive();
  const ids = { wifi: useId(), other: useId(), password: useId(), name: useId(), interval: useId() };
  const hubSsid = info.wifi.ssid;
  const [choice, setChoice] = useState(hubSsid ?? KEEP);
  const [other, setOther] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [every, setEvery] = useState(900);
  const [busy, setBusy] = useState(false);
  const ssid = choice === KEEP ? '' : choice === OTHER ? other.trim() : choice;
  const hubsOwn = ssid !== '' && ssid === hubSsid;
  const ready = choice !== OTHER || ssid !== '';

  const start = async () => {
    setBusy(true);
    try {
      onStarted(await ispindelApi.setup({ hotspot: target.ssid, ssid, password, name: name.trim(), interval: every }));
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't start setting the iSpindel up"), body: errorText(err) });
      setBusy(false);
    }
  };

  return (
    <form
      className="stack device-setup-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) void start();
      }}
    >
      <div className="form-grid">
        <label className="field" htmlFor={ids.wifi}>
          <span>{t('Wi-Fi for the iSpindel')}</span>
          <select id={ids.wifi} className="select" value={choice} onChange={(e) => setChoice(e.target.value)}>
            {hubSsid && <option value={hubSsid}>{t("{name} (the hub's)", { name: hubSsid })}</option>}
            <option value={KEEP}>{t('The one it uses now')}</option>
            <option value={OTHER}>{t('Another network…')}</option>
          </select>
        </label>
        {choice === OTHER && (
          <label className="field" htmlFor={ids.other}>
            <span>{t('Network name')}</span>
            <input id={ids.other} className="input" maxLength={32} value={other} onChange={(e) => setOther(e.target.value)} required />
          </label>
        )}
        {choice !== KEEP && (
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
        )}
        <label className="field" htmlFor={ids.name}>
          <span>{t('Name (optional)')}</span>
          <input
            id={ids.name}
            className="input"
            maxLength={32}
            placeholder={t('Keep its own')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="field" htmlFor={ids.interval}>
          <span>{t('Sends a reading')}</span>
          <select id={ids.interval} className="select" value={every} onChange={(e) => setEvery(Number(e.target.value))}>
            {ISPINDEL_INTERVALS.map((s) => (
              <option key={s} value={s}>
                {t(ISPINDEL_INTERVAL_LABELS[s]!)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="hint">
        {hubsOwn && info.wifi.knowsPassword ? `${t('Leave the password empty to use the one the hub has.')} ` : ''}
        {choice !== KEEP && !hubsOwn ? `${t('Leave the password empty if the iSpindel already uses this network.')} ` : ''}
        {t("iSpindels only use 2.4 GHz Wi-Fi, and the network has to reach this hub: guest and IoT networks often can't.")}
      </p>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="submit" className="btn primary" disabled={!ready || busy}>
          {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="zap" size={16} />}{' '}
          {t('Set up {name}', { name: target.ssid })}
        </button>
      </div>
    </form>
  );
}

type Mark = 'done' | 'on' | 'failed' | 'todo';

function marks(p: IspindelSetupProgress): { step: IspindelSetupStep; mark: Mark }[] {
  const at = ISPINDEL_SETUP_STEPS.indexOf(p.step);
  return ISPINDEL_SETUP_STEPS.filter((s) => s !== 'done').map((step, i) => ({
    step,
    mark: i < at || p.state === 'done' ? 'done' : i === at ? (p.state === 'failed' ? 'failed' : 'on') : 'todo',
  }));
}

function SetupProgress({ progress, onDismiss, onAdded }: { progress: IspindelSetupProgress; onDismiss: () => void; onAdded: () => void }) {
  const { pills, connection } = useLive();
  const now = useNow(1000);
  const running = progress.state === 'running';
  const device = progress.deviceId ? pills.find((p) => p.id === progress.deviceId) : undefined;
  const elapsed = (running ? now : progress.updatedAt) - progress.startedAt;
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (!running) heading.current?.focus();
  }, [running]);

  return (
    <section className={`panel device-progress ${progress.state}`} aria-live="polite">
      <h4 ref={heading} tabIndex={-1}>
        <Icon name={progress.state === 'done' ? 'circleCheck' : progress.state === 'failed' ? 'alert' : 'wifi'} />{' '}
        {progress.state === 'failed'
          ? t("Setting up the iSpindel didn't work")
          : progress.state === 'done'
            ? progress.waiting
              ? t('The iSpindel is set up')
              : t('{name} is added', { name: device?.name ?? progress.written?.name ?? 'iSpindel' })
            : t('Setting up {name}', { name: progress.hotspot })}
        <span className="small muted num"> · {duration(Math.max(0, elapsed))}</span>
      </h4>

      {running && connection !== 'open' && (
        <div className="notice warning">
          <Icon name="wifiOff" />
          <p>{t("The hub is away talking to the iSpindel. This page reconnects by itself when it's back.")}</p>
        </div>
      )}

      <ol className="device-progress-steps">
        {marks(progress).map(({ step, mark }) => (
          <li key={step} className={mark} aria-current={mark === 'on' ? 'step' : undefined}>
            <span className="mark">
              {mark === 'done' ? (
                <Icon name="check" size={14} />
              ) : mark === 'failed' ? (
                <Icon name="x" size={14} />
              ) : mark === 'on' ? (
                <span className="spinner" aria-hidden="true" />
              ) : null}
            </span>
            {t(ISPINDEL_STEP_LABELS[step])}
          </li>
        ))}
      </ol>

      {progress.written && (
        <dl className="kv small">
          <dt>{t('Wi-Fi')}</dt>
          <dd>{progress.written.ssid}</dd>
          <dt>{t('Sends to')}</dt>
          <dd className="num">
            http://{progress.written.server}:{progress.written.port}
            {progress.written.path}
          </dd>
          <dt>{t('Every')}</dt>
          <dd>{duration(progress.written.interval * 1000)}</dd>
        </dl>
      )}

      {progress.state === 'failed' && progress.error && (
        <div className="notice danger" role="alert">
          <Icon name="alert" />
          <div className="grow">
            <p>
              <strong>{t(ISPINDEL_SETUP_ERRORS[progress.error])}</strong>
            </p>
            {progress.detail && <p className="small">{progress.detail}</p>}
          </div>
        </div>
      )}
      {progress.state === 'done' && progress.waiting && (
        <div className="notice warning">
          <Icon name="clock" />
          <div className="grow">
            <p>
              {t(
                "It hasn't sent a reading yet. It's added as soon as one arrives (for the next 2 hours), or it shows up here to add. If nothing comes:",
              )}
            </p>
            <ul className="small">
              <li>{t('Check the Wi-Fi password: put it in setup mode and set it up again.')}</li>
              <li>{t("Check the network can reach this hub: guest and IoT networks often can't.")}</li>
              <li>{t('If the hub was offline for the setup, the first reading can take one interval to arrive.')}</li>
            </ul>
          </div>
        </div>
      )}
      {!running && !progress.hubBack && (
        <div className="notice danger" role="alert">
          <Icon name="wifiOff" />
          <p>{t("The hub had trouble getting back on its network. If it's unreachable, restart it.")}</p>
        </div>
      )}

      {!running && (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          {progress.state === 'failed' && (
            <button type="button" className="btn" onClick={onDismiss}>
              <Icon name="refresh" size={16} /> {t('Try again')}
            </button>
          )}
          {device ? (
            <>
              <button type="button" className="btn ghost" onClick={onDismiss}>
                <Icon name="plus" size={16} /> {t('Set up another')}
              </button>
              <a className="btn primary" href={href.pill(device.id)} onClick={onAdded}>
                {t('Open {name}', { name: device.name })}
              </a>
            </>
          ) : (
            <button type="button" className={`btn${progress.state === 'done' ? ' primary' : ' ghost'}`} onClick={onDismiss}>
              {progress.state === 'done' ? t('Done') : t('Dismiss')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** A value to type into the iSpindel's setup page, with a button to copy it. */
function Value({ label, value }: { label: string; value: string }) {
  const { toast } = useLive();
  return (
    <>
      <dt>{label}</dt>
      <dd className="device-value">
        <code>{value}</code>
        <button
          type="button"
          className="icon-btn"
          aria-label={t('Copy {what}', { what: label })}
          title={t('Copy')}
          onClick={() =>
            void copyText(value).then((ok) =>
              toast(ok ? { tone: 'success', title: t('Copied'), body: label } : { tone: 'error', title: t("Couldn't copy"), body: value }),
            )
          }
        >
          <Icon name="copy" size={14} />
        </button>
      </dd>
    </>
  );
}

function ManualSetup({ info }: { info: IspindelInfo | null }) {
  const { isOwner } = useLive();
  if (!info) return <div className="skeleton" style={{ height: '10rem' }} aria-busy="true" />;
  const { server } = info;
  return (
    <div className="stack">
      <ol className="device-steps">
        <li>
          <SetupModeHint />
        </li>
        <li>
          <Trans
            text={t('On your phone, join that network and open {url}, then choose {page}.')}
            values={{ url: <code>{PORTAL_URL}</code>, page: <strong>Configuration</strong> }}
          />
        </li>
        <li>
          {t(
            "Choose your Wi-Fi network and type its password. It has to be a network that can reach this hub (guest and IoT networks often can't), on 2.4 GHz.",
          )}
        </li>
        <li>
          {t('Set these, and leave everything else as it is:')}
          <dl className="kv device-values">
            <dt>Service Type</dt>
            <dd>
              <code>HTTP</code>
            </dd>
            {info.token ? (
              <Value label="Token" value={info.token} />
            ) : (
              <>
                <dt>Token</dt>
                <dd>{isOwner ? '–' : t('Sign in as the owner to see it.')}</dd>
              </>
            )}
            {server.host ? (
              <Value label="Server Address" value={server.host} />
            ) : (
              <>
                <dt>Server Address</dt>
                <dd>{t("This hub's IP address (your router lists it).")}</dd>
              </>
            )}
            <Value label="Server Port" value={String(server.port)} />
            <Value label="Path / URI" value={server.path} />
            <dt>Update Interval (s)</dt>
            <dd>{t('{seconds} is a good start (every 15 minutes).', { seconds: 900 })}</dd>
          </dl>
          {server.hosts.length > 1 && (
            <p className="hint">
              {t('The hub has more than one address: {list}. Use the one on the network the iSpindel joins.', {
                list: server.hosts.join(', '),
              })}
            </p>
          )}
        </li>
        <li>
          {t(
            'Save. It restarts, joins your Wi-Fi and sends its first reading within a minute: it shows up at the top of this tab, to add.',
          )}
        </li>
      </ol>
      <div className="notice">
        <Icon name="info" />
        <p>
          {t(
            "Type the hub's IP address, not a name like rapthooker.local: iSpindels can't look those up. Give the hub a fixed address in your router (a DHCP reservation) so it doesn't change.",
          )}
        </p>
      </div>
    </div>
  );
}
