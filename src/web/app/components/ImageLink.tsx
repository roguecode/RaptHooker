import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import {
  SCREEN_FORMATS,
  SCREEN_ITEMS,
  SCREEN_MAX_SIZE,
  SCREEN_MIN_SIZE,
  SCREEN_RANGES,
  screenPath,
  screenQuery,
  type HubAddress,
  type Pill,
  type ScreenFormat,
  type ScreenItem,
  type ScreenOptions,
  type ScreenTheme,
} from '@rapthooker/shared';
import { http } from '../api';
import { useLive } from '../live';
import { useUnits } from '../units';
import { useTheme, type Palette } from '../theme';
import { useStored } from '../storage';
import { bytes, intlLocale } from '../format';
import { t } from '../i18n';
import { copyText } from '../pages/settings/copy';
import { Icon } from './Icon';
import { Modal } from './ui';
import { NumberInput } from './NumberInput';
import { PalettePicker } from './PalettePicker';
import {
  browserTimeZone,
  CONTENT_PRESETS,
  contentPreset,
  CUSTOM,
  FORMAT_LABELS,
  IMAGE_LINK_KEY,
  ITEM_LABELS,
  parseImageLinkSettings,
  RANGE_LABELS,
  serializeImageLinkSettings,
  SIZE_PRESETS,
  sizePreset,
  type ImageLinkSettings,
} from './imageLinkOptions';
import './ImageLink.css';

const n2 = (v: number) => Math.round(v * 100) / 100;

/**
 * "Image link": a web address for a picture of every pill (or of `pill`) that a small screen can load, with what's on
 * it, its size and its look chosen here and kept in the address. The picture is previewed as the choices change.
 */
export function ImageLinkButton({ pill, className = 'btn small' }: { pill?: Pill; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} title={t('A picture of the readings for a small screen')}>
        <Icon name="image" size={16} /> {t('Image link')}
      </button>
      {open && <ImageLinkDialog pill={pill ?? null} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Where the hub can be reached: a screen on the network usually needs its IP address rather than a .local name. */
function useHosts(): { hosts: { origin: string; label: string }[]; best: string } {
  const [addresses, setAddresses] = useState<HubAddress[] | null>(null);
  useEffect(() => {
    let live = true;
    http.get<HubAddress[]>('/api/system/addresses').then(
      (list) => live && setAddresses(list),
      () => live && setAddresses([]),
    );
    return () => {
      live = false;
    };
  }, []);
  const here = window.location.origin;
  const hosts: { origin: string; label: string }[] = [];
  for (const a of addresses ?? []) {
    let origin: string;
    try {
      origin = new URL(a.url).origin;
    } catch {
      continue;
    }
    if (hosts.some((h) => h.origin === origin)) continue;
    const kind = a.kind === 'lan' ? t('IP address') : a.kind === 'mdns' ? t('Name') : 'Tailscale';
    hosts.push({ origin, label: `${origin} (${kind})` });
  }
  if (!hosts.some((h) => h.origin === here)) hosts.push({ origin: here, label: `${here} (${t('this page')})` });
  const lan = (addresses ?? []).find((a) => a.kind === 'lan');
  return { hosts, best: lan ? new URL(lan.url).origin : here };
}

function ImageLinkDialog({ pill, onClose }: { pill: Pill | null; onClose: () => void }) {
  const { toast } = useLive();
  const theme = useTheme();
  const units = useUnits();
  const [saved, save] = useStored(IMAGE_LINK_KEY, parseImageLinkSettings, serializeImageLinkSettings);
  // The look and units start as this browser's, each time.
  const [mode, setMode] = useState<ScreenTheme>(theme.theme);
  const [palette, setPalette] = useState<Palette>(theme.palette);
  const [gravity, setGravity] = useState(units.gravity);
  const [temperature, setTemperature] = useState(units.temperature);
  const { hosts, best } = useHosts();
  const ids = { size: useId(), w: useId(), h: useId(), link: useId(), host: useId(), range: useId() };

  const update = (patch: Partial<ImageLinkSettings>) => save({ ...saved, ...patch });
  const host = saved.host && hosts.some((h) => h.origin === saved.host) ? saved.host : best;
  const all = pill === null;
  const options: ScreenOptions = {
    width: saved.width,
    height: saved.height,
    theme: mode,
    palette,
    show: saved.show,
    range: saved.range,
    gravity,
    temperature,
    lang: intlLocale(),
    tz: browserTimeZone(),
    brewing: saved.brewing,
  };
  const path = `${screenPath(saved.format, pill?.id)}?${screenQuery(options, { allDevices: all })}`;
  const url = `${host}${path}`;
  const preset = contentPreset(saved.show);

  const setSize = (id: string) => {
    const p = SIZE_PRESETS.find((s) => s.id === id);
    if (!p) return update({ size: CUSTOM });
    update({ size: p.id, width: p.width, height: p.height, ...(p.format ? { format: p.format } : {}) });
  };
  const setDimension = (which: 'width' | 'height', v: number) => {
    if (!Number.isFinite(v) || v < SCREEN_MIN_SIZE || v > SCREEN_MAX_SIZE) return;
    const width = which === 'width' ? Math.round(v) : saved.width;
    const height = which === 'height' ? Math.round(v) : saved.height;
    update({ width, height, size: sizePreset(width, height, saved.size)?.id ?? CUSTOM });
  };
  const toggle = (item: ScreenItem) => {
    const on = saved.show.includes(item);
    update({ show: SCREEN_ITEMS.filter((i) => (i === item ? !on : saved.show.includes(i))) });
  };
  const copy = async () => {
    const ok = await copyText(url);
    toast(ok ? { tone: 'success', title: t('Image link copied') } : { tone: 'error', title: t("Couldn't copy"), body: url });
  };

  return (
    <Modal
      title={
        <>
          <Icon name="image" /> {pill ? t('Image link for {name}', { name: pill.name }) : t('Image link for all pills')}
        </>
      }
      onClose={onClose}
      className="image-link-modal"
    >
      <p className="muted image-link-intro">
        {t(
          'A picture of the latest readings for a small screen (a GeekMagic, an ESPHome display, an e-paper frame) to load from the hub. Each time it loads the link it gets a fresh picture.',
        )}
      </p>
      <div className="image-link">
        <div className="image-link-preview">
          <ImagePreview path={path} width={saved.width} height={saved.height} format={saved.format} />
        </div>

        <div className="image-link-options">
          <fieldset className="fieldset">
            <legend>{t('Screen')}</legend>
            <select
              id={ids.size}
              className="select"
              aria-label={t('Screen size')}
              value={saved.size}
              onChange={(e) => setSize(e.target.value)}
            >
              {SIZE_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {t('{name} ({width} × {height})', { name: t(p.label), width: p.width, height: p.height })}
                </option>
              ))}
              <option value={CUSTOM}>{t('Custom size')}</option>
            </select>
            <div className="image-link-size">
              <label className="field" htmlFor={ids.w}>
                <span>{t('Width (px)')}</span>
                <NumberInput
                  id={ids.w}
                  className="input"
                  value={saved.width}
                  min={SCREEN_MIN_SIZE}
                  max={SCREEN_MAX_SIZE}
                  fallback={saved.width}
                  onValue={(v) => setDimension('width', v)}
                />
              </label>
              <button
                type="button"
                className="btn icon ghost"
                aria-label={t('Swap width and height')}
                title={t('Swap width and height')}
                onClick={() =>
                  update({
                    width: saved.height,
                    height: saved.width,
                    size: sizePreset(saved.height, saved.width, saved.size)?.id ?? CUSTOM,
                  })
                }
              >
                <Icon name="swap" size={16} />
              </button>
              <label className="field" htmlFor={ids.h}>
                <span>{t('Height (px)')}</span>
                <NumberInput
                  id={ids.h}
                  className="input"
                  value={saved.height}
                  min={SCREEN_MIN_SIZE}
                  max={SCREEN_MAX_SIZE}
                  fallback={saved.height}
                  onValue={(v) => setDimension('height', v)}
                />
              </label>
            </div>
          </fieldset>

          <fieldset className="fieldset">
            <legend>{t('What to show')}</legend>
            <div className="chips" role="group" aria-label={t('Presets')}>
              {CONTENT_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`chip toggle${preset?.id === p.id ? ' on' : ''}`}
                  aria-pressed={preset?.id === p.id}
                  title={t(p.hint)}
                  onClick={() => update({ show: [...p.items] })}
                >
                  {t(p.label)}
                </button>
              ))}
              {!preset && <span className="chip on">{t('Custom')}</span>}
            </div>
            <div className="image-link-items">
              {SCREEN_ITEMS.map((item) => (
                <label key={item} className="check">
                  <input type="checkbox" checked={saved.show.includes(item)} onChange={() => toggle(item)} />
                  <span>{t(ITEM_LABELS[item])}</span>
                </label>
              ))}
            </div>
            {saved.show.includes('chart') && (
              <label className="field" htmlFor={ids.range}>
                <span>{t('The graph shows')}</span>
                <select
                  id={ids.range}
                  className="select"
                  value={saved.range}
                  onChange={(e) => update({ range: SCREEN_RANGES.find((r) => r === e.target.value) ?? 'brew' })}
                >
                  {SCREEN_RANGES.map((r) => (
                    <option key={r} value={r}>
                      {t(RANGE_LABELS[r])}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {all && (
              <label className="check">
                <input type="checkbox" checked={saved.brewing} onChange={(e) => update({ brewing: e.target.checked })} />
                <span>{t('Only pills with a brew running')}</span>
              </label>
            )}
            <p className="hint">{t("What doesn't fit at a readable size is left out, so check the preview.")}</p>
          </fieldset>

          <fieldset className="fieldset">
            <legend>{t('Look')}</legend>
            <div className="row">
              <div className="segmented" role="group" aria-label={t('Theme')}>
                {(['dark', 'light'] as const).map((m) => (
                  <button key={m} type="button" className={mode === m ? 'on' : ''} aria-pressed={mode === m} onClick={() => setMode(m)}>
                    <Icon name={m === 'dark' ? 'moon' : 'sun'} size={14} /> {m === 'dark' ? t('Dark') : t('Light')}
                  </button>
                ))}
              </div>
              <PalettePicker compact value={palette} onChange={setPalette} />
            </div>
            <div className="row">
              <div className="segmented" role="group" aria-label={t('Gravity unit')}>
                {(['sg', 'plato'] as const).map((g) => (
                  <button
                    key={g}
                    type="button"
                    className={gravity === g ? 'on' : ''}
                    aria-pressed={gravity === g}
                    onClick={() => setGravity(g)}
                  >
                    {g === 'sg' ? 'SG' : '°P'}
                  </button>
                ))}
              </div>
              <div className="segmented" role="group" aria-label={t('Temperature unit')}>
                {(['C', 'F'] as const).map((u) => (
                  <button
                    key={u}
                    type="button"
                    className={temperature === u ? 'on' : ''}
                    aria-pressed={temperature === u}
                    onClick={() => setTemperature(u)}
                  >
                    °{u}
                  </button>
                ))}
              </div>
            </div>
          </fieldset>

          <fieldset className="fieldset">
            <legend>{t('File type')}</legend>
            <div className="segmented" role="group" aria-label={t('File type')}>
              {SCREEN_FORMATS.map((f) => (
                <button
                  key={f}
                  type="button"
                  className={saved.format === f ? 'on' : ''}
                  aria-pressed={saved.format === f}
                  onClick={() => update({ format: f })}
                >
                  {FORMAT_LABELS[f]}
                </button>
              ))}
            </div>
            <p className="hint">{t('GeekMagic screens and other ESP8266 boards need JPEG. ESPHome displays take any of these.')}</p>
          </fieldset>
        </div>
      </div>

      <div className="image-link-address">
        <div className="field">
          <label className="label" htmlFor={ids.link}>
            {t('Link for the screen')}
          </label>
          <div className="image-link-url">
            <input id={ids.link} className="input" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className="btn primary" onClick={() => void copy()}>
              <Icon name="copy" size={16} /> {t('Copy')}
            </button>
            <a className="btn" href={url} target="_blank" rel="noreferrer">
              <Icon name="external" size={16} /> {t('Open')}
            </a>
          </div>
        </div>
        {hosts.length > 1 && (
          <label className="field" htmlFor={ids.host}>
            <span>{t('Hub address in the link')}</span>
            <select
              id={ids.host}
              className="select"
              value={host}
              onChange={(e) => update({ host: e.target.value === best ? null : e.target.value })}
            >
              {hosts.map((h) => (
                <option key={h.origin} value={h.origin}>
                  {h.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="hint">
          {t(
            "Small screens often can't look up .local names, so the link uses the hub's IP address. Everything about the picture is in the link: change it there or make a new one here.",
          )}
        </p>
      </div>
    </Modal>
  );
}

/** The picture as the hub draws it, fetched again (after a short pause) whenever the link changes. */
function ImagePreview({ path, width, height, format }: { path: string; width: number; height: number; format: ScreenFormat }) {
  const [shown, setShown] = useState<{ src: string; size: number; width: number; height: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const current = useRef<string | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => {
      fetch(path, { signal: ctl.signal, credentials: 'same-origin' })
        .then(async (res) => {
          if (!res.ok && res.status !== 404) throw new Error(String(res.status));
          const blob = await res.blob();
          if (ctl.signal.aborted) return;
          const src = URL.createObjectURL(blob);
          if (current.current) URL.revokeObjectURL(current.current);
          current.current = src;
          setShown({ src, size: blob.size, width, height });
          setFailed(false);
          setLoading(false);
        })
        .catch(() => {
          if (ctl.signal.aborted) return;
          setFailed(true);
          setLoading(false);
        });
    }, 350);
    return () => {
      window.clearTimeout(timer);
      ctl.abort();
    };
  }, [path, width, height]);

  useEffect(
    () => () => {
      if (current.current) URL.revokeObjectURL(current.current);
    },
    [],
  );

  // Small screens are shown bigger than life, so there's something to see; big ones fit the space.
  const w = shown?.width ?? width;
  const h = shown?.height ?? height;
  const scale = w <= 320 && h <= 320 ? 1.5 : 1;
  const box: CSSProperties = { width: `min(100%, ${w * scale}px, ${n2((24 * w) / h)}rem)`, aspectRatio: `${w} / ${h}` };
  return (
    <figure className={`image-link-frame${loading ? ' loading' : ''}`} aria-busy={loading}>
      <div className="image-link-screen">
        {shown ? (
          <img src={shown.src} alt={t('Preview of the picture')} width={shown.width} height={shown.height} style={box} />
        ) : (
          <div className="skeleton" style={box} />
        )}
      </div>
      <figcaption className="small muted">
        {failed ? (
          <span className="image-link-error">
            <Icon name="alert" size={14} /> {t("Couldn't load the preview")}
          </span>
        ) : (
          <>
            {t('{width} × {height} px', { width, height })} · {FORMAT_LABELS[format]}
            {shown && !loading ? ` · ${bytes(shown.size)}` : ''}
            {loading && <span className="image-link-busy"> · {t('Updating…')}</span>}
          </>
        )}
      </figcaption>
    </figure>
  );
}
