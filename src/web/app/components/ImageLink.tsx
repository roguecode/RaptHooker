import { useEffect, useId, useState } from 'react';
import {
  SCREEN_FORMATS,
  SCREEN_MAX_SIZE,
  SCREEN_MIN_SIZE,
  SCREEN_MODELS,
  screenPath,
  screenQuery,
  type HubAddress,
  type Pill,
  type ScreenDevice,
  type ScreenOptions,
} from '@rapthooker/shared';
import { errorText, http } from '../api';
import { useLive } from '../live';
import { useUnits } from '../units';
import { useTheme } from '../theme';
import { useStored } from '../storage';
import { intlLocale } from '../format';
import { t } from '../i18n';
import { copyText } from '../pages/settings/copy';
import { screensApi } from '../pages/screens/screensApi';
import { Icon } from './Icon';
import { Modal } from './ui';
import { NumberInput } from './NumberInput';
import { ImagePreview, PictureFields, type PictureDesign } from './PictureDesigner';
import {
  browserTimeZone,
  CUSTOM,
  FORMAT_LABELS,
  IMAGE_LINK_KEY,
  parseImageLinkSettings,
  serializeImageLinkSettings,
  SIZE_PRESETS,
  sizePreset,
  type ImageLinkSettings,
} from './imageLinkOptions';
import './ImageLink.css';

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
  const [look, setLook] = useState<Pick<PictureDesign, 'theme' | 'palette' | 'gravity' | 'temperature'>>({
    theme: theme.theme,
    palette: theme.palette,
    gravity: units.gravity,
    temperature: units.temperature,
  });
  const { hosts, best } = useHosts();
  const ids = { size: useId(), w: useId(), h: useId(), link: useId(), host: useId(), fields: useId() };

  const update = (patch: Partial<ImageLinkSettings>) => save({ ...saved, ...patch });
  const host = saved.host && hosts.some((h) => h.origin === saved.host) ? saved.host : best;
  const all = pill === null;
  const design: PictureDesign = { show: saved.show, range: saved.range, brewing: saved.brewing, ...look };
  const changeDesign = (patch: Partial<PictureDesign>) => {
    const { show, range, brewing, ...rest } = patch;
    const stored: Partial<ImageLinkSettings> = {};
    if (show) stored.show = show;
    if (range) stored.range = range;
    if (brewing !== undefined) stored.brewing = brewing;
    if (Object.keys(stored).length) update(stored);
    if (Object.keys(rest).length) setLook((cur) => ({ ...cur, ...rest }));
  };
  const options: ScreenOptions = {
    width: saved.width,
    height: saved.height,
    ...design,
    lang: intlLocale(),
    tz: browserTimeZone(),
  };
  const path = `${screenPath(saved.format, pill?.id)}?${screenQuery(options, { allDevices: all })}`;
  const url = `${host}${path}`;

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

          <PictureFields value={design} onChange={changeDesign} all={all} idPrefix={ids.fields} />

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
      <ShowOnScreen pill={pill} design={design} />
    </Modal>
  );
}

/**
 * The same picture on one of the hub's own screens (pages/screens), which fetch it by themselves: no link to copy.
 * A screen keeps its own size and file type.
 */
function ShowOnScreen({ pill, design }: { pill: Pill | null; design: PictureDesign }) {
  const { isOwner, screens, upsertScreen, toast } = useLive();
  const id = useId();
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!isOwner) return null;
  if (screens.length === 0) {
    return (
      <p className="hint image-link-screens">
        <Icon name="screen" size={14} />{' '}
        {t('Got a screen RaptHooker supports ({names})? It can set it up to show this by itself.', {
          names: SCREEN_MODELS.map((m) => m.name).join(', '),
        })}{' '}
        <a href="#/screens">{t('Set up a screen')}</a>
      </p>
    );
  }
  const target = screens.find((s) => s.id === chosen) ?? screens.find((s) => s.pillId !== (pill?.id ?? null)) ?? screens[0]!;
  const send = async (screen: ScreenDevice) => {
    setBusy(true);
    try {
      const updated = await screensApi.patch(screen.id, {
        pillId: pill?.id ?? null,
        look: { ...design, lang: intlLocale(), tz: browserTimeZone() },
      });
      upsertScreen(updated);
      toast({ tone: 'success', title: t('{name} shows this now', { name: updated.name }) });
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't change the screen"), body: errorText(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="image-link-screens">
      {screens.length > 1 ? (
        <label className="label" htmlFor={id}>
          <Icon name="screen" size={16} /> {t('Show this on a screen')}
        </label>
      ) : (
        <span className="label">
          <Icon name="screen" size={16} /> {t('Show this on a screen')}
        </span>
      )}
      <div className="image-link-url">
        {screens.length > 1 && (
          <select id={id} className="select" value={target.id} onChange={(e) => setChosen(e.target.value)}>
            {screens.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="btn" disabled={busy} onClick={() => void send(target)}>
          <Icon name="send" size={16} /> {screens.length > 1 ? t('Show it there') : t('Show it on {name}', { name: target.name })}
        </button>
      </div>
      <p className="hint">{t('The screen keeps its own size, and changes to the new picture straight away.')}</p>
    </div>
  );
}
