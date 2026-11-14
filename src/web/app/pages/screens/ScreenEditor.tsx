import { useId, useRef, useState } from 'react';
import { screenModel, screenPath, screenQuery, type ScreenDevice, type ScreenLook } from '@rapthooker/shared';
import { errorText } from '../../api';
import { useLive } from '../../live';
import { dateTime, duration, intlLocale, num, timeAgo, useNow } from '../../format';
import { t } from '../../i18n';
import { Icon } from '../../components/Icon';
import { Confirm, Modal, SignalBars } from '../../components/ui';
import { ImagePreview, PictureFields, type PictureDesign } from '../../components/PictureDesigner';
import { browserTimeZone } from '../../components/imageLinkOptions';
import { PanelFix } from './PanelFix';
import { screensApi } from './screensApi';
import { STATE_LABELS } from './strings';
import './screens.css';

/** Seconds between pictures that the editor offers (the screen's own value is added if it's another). */
const INTERVALS = [30, 60, 120, 300, 600, 900, 1800, 3600];

/** Where GeekMagic publishes the Ultra's own firmware, for putting it back. */
const GEEKMAGIC_FIRMWARE = 'https://github.com/GeekMagicClock/smalltv-ultra';

export const everyText = (sec: number): string =>
  sec < 60
    ? t('{n} s', { n: num(sec) })
    : sec < 3600
      ? t('{n} min', { n: num(Math.round(sec / 60)) })
      : t('{n} h', { n: num(sec / 3600, 1, 0) });

const designOf = (look: ScreenLook): PictureDesign => ({
  show: look.show,
  range: look.range,
  brewing: look.brewing,
  alerts: look.alerts ?? false,
  theme: look.theme,
  palette: look.palette,
  gravity: look.gravity,
  temperature: look.temperature,
  gravityDecimals: look.gravityDecimals ?? null,
  temperatureDecimals: look.temperatureDecimals ?? null,
});

/**
 * A screen's settings: what it shows (any pill or all of them, designed like an image link), how often it fetches a
 * new picture, how bright it is, and the screen itself (details, log, restart, original firmware, forgetting it).
 */
export function ScreenEditor({ screen, onClose }: { screen: ScreenDevice; onClose: () => void }) {
  const { pills, upsertScreen, toast } = useLive();
  const ids = { name: useId(), pill: useId(), interval: useId(), brightness: useId(), fields: useId() };
  const [name, setName] = useState(screen.name);
  const [pillId, setPillId] = useState<string | null>(screen.pillId);
  const [design, setDesign] = useState<PictureDesign>(() => designOf(screen.look));
  const [interval, setEvery] = useState(screen.interval);
  const [brightness, setBrightness] = useState(screen.brightness);
  const [busy, setBusy] = useState(false);

  const model = screenModel(screen.model);
  const width = model?.width ?? 240;
  const height = model?.height ?? 240;
  const lang = intlLocale();
  const tz = browserTimeZone();
  const path = `${screenPath('jpg', pillId)}?${screenQuery({ width, height, ...design, lang, tz }, { allDevices: pillId === null })}`;
  const intervals = INTERVALS.includes(screen.interval) ? INTERVALS : [...INTERVALS, screen.interval].sort((a, b) => a - b);
  const known = pillId === null || pills.some((p) => p.id === pillId);

  const save = async () => {
    setBusy(true);
    try {
      const updated = await screensApi.patch(screen.id, {
        name: name.trim() || screen.name,
        pillId,
        look: { ...design, lang, tz },
        interval,
        brightness,
      });
      upsertScreen(updated);
      toast({ tone: 'success', title: t('{name} saved', { name: updated.name }) });
      onClose();
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't save the screen"), body: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={
        <>
          <Icon name="screen" /> {screen.name}
        </>
      }
      onClose={onClose}
      className="image-link-modal screen-editor"
    >
      <div className="image-link">
        <div className="image-link-preview">
          <ImagePreview path={path} width={width} height={height} format="jpg" />
        </div>
        <div className="image-link-options">
          <fieldset className="fieldset">
            <legend>{t('Screen')}</legend>
            <label className="field" htmlFor={ids.name}>
              <span>{t('Name')}</span>
              <input id={ids.name} className="input" maxLength={32} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field" htmlFor={ids.pill}>
              <span>{t('It shows')}</span>
              <select
                id={ids.pill}
                className="select"
                value={pillId ?? ''}
                onChange={(e) => setPillId(e.target.value === '' ? null : e.target.value)}
              >
                <option value="">{t('All pills')}</option>
                {pills.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.archived ? t('{name} (archived)', { name: p.name }) : p.name}
                  </option>
                ))}
                {!known && <option value={pillId ?? ''}>{t('A removed pill')}</option>}
              </select>
            </label>
            <div className="screen-editor-pair">
              <label className="field" htmlFor={ids.interval}>
                <span>{t('New picture every')}</span>
                <select id={ids.interval} className="select" value={interval} onChange={(e) => setEvery(Number(e.target.value))}>
                  {intervals.map((s) => (
                    <option key={s} value={s}>
                      {everyText(s)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field" htmlFor={ids.brightness}>
                <span>{t('Brightness: {percent}%', { percent: brightness })}</span>
                <input
                  id={ids.brightness}
                  type="range"
                  min={1}
                  max={100}
                  value={brightness}
                  onChange={(e) => setBrightness(Number(e.target.value))}
                />
              </label>
            </div>
          </fieldset>
          <PictureFields
            value={design}
            onChange={(patch) => setDesign((cur) => ({ ...cur, ...patch }))}
            all={pillId === null}
            idPrefix={ids.fields}
          />
        </div>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          {t('Cancel')}
        </button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>
          <Icon name="check" size={16} /> {t('Save')}
        </button>
      </div>
      {screen.panel !== null && <PanelFix screen={screen} />}
      <ScreenDetails screen={screen} onGone={onClose} />
    </Modal>
  );
}

/** What the hub knows about the screen, and looking after it. */
function ScreenDetails({ screen, onGone }: { screen: ScreenDevice; onGone: () => void }) {
  const { toast, upsertScreen } = useLive();
  const now = useNow(10_000);
  const [log, setLog] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const s = screen.status;

  const act = async (what: 'identify' | 'refresh' | 'reboot') => {
    setBusy(what);
    try {
      await screensApi.action(screen.id, what);
      if (what === 'identify') toast({ tone: 'info', title: t('{name} is showing its name', { name: screen.name }) });
      if (what === 'reboot') toast({ tone: 'info', title: t('{name} is restarting', { name: screen.name }) });
    } catch (err) {
      toast({ tone: 'error', title: t("The screen didn't answer"), body: errorText(err) });
    } finally {
      setBusy(null);
    }
  };
  const showLog = async () => {
    setBusy('log');
    try {
      setLog(await screensApi.log(screen.id));
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't get the screen's log"), body: errorText(err) });
    } finally {
      setBusy(null);
    }
  };
  const update = async () => {
    setBusy('update');
    try {
      upsertScreen(await screensApi.update(screen.id));
      toast({ tone: 'success', title: t('{name} is up to date', { name: screen.name }) });
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't update the screen"), body: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <details className="screen-details">
      <summary>
        <Icon name="info" size={16} /> {t('Screen details')}
      </summary>
      <dl className="kv">
        <dt>{t('Status')}</dt>
        <dd>
          {t(STATE_LABELS[s.state])}
          {s.lastSeenAt ? ` · ${t('last picture {ago}', { ago: timeAgo(s.lastSeenAt, now) })}` : ''}
        </dd>
        <dt>{t('Model')}</dt>
        <dd>{screenModel(screen.model)?.name ?? screen.model}</dd>
        <dt>{t('Firmware')}</dt>
        <dd>
          {screen.firmware ?? '–'}
          {s.update && ` · ${t('{version} available', { version: s.update })}`}
        </dd>
        <dt>{t('IP address')}</dt>
        <dd className="num">{screen.ip ?? '–'}</dd>
        <dt>{t('Name on the network')}</dt>
        <dd className="num">{screen.hostname ? `${screen.hostname}.local` : '–'}</dd>
        <dt>{t('MAC address')}</dt>
        <dd className="num">{screen.mac}</dd>
        <dt>{t('Wi-Fi signal')}</dt>
        <dd className="row" style={{ gap: '0.4rem' }}>
          <SignalBars rssi={s.rssi} /> {s.rssi !== null ? `${s.rssi} dBm` : '–'}
        </dd>
        <dt>{t('Running for')}</dt>
        <dd>{s.uptime !== null ? duration(s.uptime * 1000) : '–'}</dd>
        {s.failures ? (
          <>
            <dt>{t('Missed pictures')}</dt>
            <dd>{num(s.failures)}</dd>
          </>
        ) : null}
        {s.error && (
          <>
            <dt>{t('Problem')}</dt>
            <dd>{s.error === 'not-allowed' ? t('The screen no longer accepts this hub (it was reset or set up again).') : s.error}</dd>
          </>
        )}
        <dt>{t('Added')}</dt>
        <dd>{dateTime(screen.createdAt)}</dd>
      </dl>
      <div className="row screen-details-actions">
        <button type="button" className="btn small" disabled={busy !== null} onClick={() => void act('identify')}>
          <Icon name="screen" size={14} /> {t('Show its name')}
        </button>
        <button type="button" className="btn small" disabled={busy !== null} onClick={() => void act('refresh')}>
          <Icon name="refresh" size={14} /> {t('New picture now')}
        </button>
        <button type="button" className="btn small" disabled={busy !== null} onClick={() => void act('reboot')}>
          <Icon name="undo" size={14} /> {t('Restart')}
        </button>
        <button type="button" className="btn small" disabled={busy !== null} onClick={() => void showLog()}>
          <Icon name="list" size={14} /> {t('Log')}
        </button>
        {s.update && (
          <button type="button" className="btn small primary" disabled={busy !== null || s.updating} onClick={() => void update()}>
            <Icon name="download" size={14} /> {t('Update to {version}', { version: s.update })}
          </button>
        )}
      </div>
      <div className="row screen-details-actions">
        {screenModel(screen.model)?.install !== 'usb' && (
          <button type="button" className="btn small ghost" onClick={() => setRestoring(true)}>
            <Icon name="upload" size={14} /> {t('Put the original firmware back')}
          </button>
        )}
        <button type="button" className="btn small ghost danger" onClick={() => setForgetting(true)}>
          <Icon name="trash" size={14} /> {t('Forget')}
        </button>
      </div>
      {log !== null && (
        <Modal title={t('Log from {name}', { name: screen.name })} onClose={() => setLog(null)} wide>
          <pre className="code-block screen-log">{log || t('The log is empty.')}</pre>
        </Modal>
      )}
      {forgetting && <ForgetScreen screen={screen} onClose={() => setForgetting(false)} onGone={onGone} />}
      {restoring && <RestoreStock screen={screen} onClose={() => setRestoring(false)} onGone={onGone} />}
    </details>
  );
}

function ForgetScreen({ screen, onClose, onGone }: { screen: ScreenDevice; onClose: () => void; onGone: () => void }) {
  const { toast } = useLive();
  const [reset, setReset] = useState(true);
  return (
    <Confirm
      title={t('Forget {name}?', { name: screen.name })}
      body={
        <>
          <p>{t('The hub stops looking after it and it goes from the list.')}</p>
          <label className="check">
            <input type="checkbox" checked={reset} onChange={(e) => setReset(e.target.checked)} />
            <span>{t('Also reset the screen, so it opens its own Wi-Fi for setting up again')}</span>
          </label>
        </>
      }
      confirm={t('Forget')}
      danger
      onClose={onClose}
      onConfirm={async () => {
        try {
          await screensApi.remove(screen.id, reset);
          onGone();
        } catch (err) {
          toast({ tone: 'error', title: t("Couldn't forget the screen"), body: errorText(err) });
        }
      }}
    />
  );
}

/** Sends the maker's firmware file (which the hub checks) to put the screen back as it came. */
function RestoreStock({ screen, onClose, onGone }: { screen: ScreenDevice; onClose: () => void; onGone: () => void }) {
  const { toast } = useLive();
  const file = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!picked) return;
    setBusy(true);
    try {
      await screensApi.restore(screen.id, picked);
      toast({
        tone: 'success',
        title: t('{name} is going back to its original firmware', { name: screen.name }),
        body: t('Keep it plugged in while it restarts. It opens its own Wi-Fi again once done.'),
      });
      onClose();
      onGone();
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't put the original firmware back"), body: errorText(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Put the original firmware back')} onClose={onClose}>
      <div className="stack">
        <p className="muted">
          {t(
            "This puts the firmware the screen came with back on it, and the hub forgets it. You need the firmware file from the screen's maker: for a Smart weather clock, a file like SDPro_V1.0.6.bin; for a GeekMagic Ultra, one like FW-Smalltv-Ultra-V9.0.50.bin from GeekMagic's GitHub (unzipped).",
          )}{' '}
          <a href={GEEKMAGIC_FIRMWARE} target="_blank" rel="noreferrer noopener">
            {t("GeekMagic's firmware")}
          </a>
        </p>
        <p className="muted small">
          {t("The hub checks the file is firmware for this screen before sending it. Keep the screen plugged in until it's back.")}
        </p>
        <div className="row">
          <button type="button" className="btn" onClick={() => file.current?.click()}>
            <Icon name="file" size={16} /> {picked ? picked.name : t('Choose the file')}
          </button>
          <input
            ref={file}
            type="file"
            accept=".bin,application/octet-stream"
            hidden
            onChange={(e) => {
              setPicked(e.target.files?.[0] ?? null);
              e.target.value = '';
            }}
          />
        </div>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          {t('Cancel')}
        </button>
        <button type="button" className="btn danger" disabled={!picked || busy} onClick={() => void send()}>
          <Icon name="upload" size={16} /> {busy ? t('Sending…') : t('Put it back')}
        </button>
      </div>
    </Modal>
  );
}
