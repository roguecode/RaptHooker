import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  gravityDecimals,
  SCREEN_ITEMS,
  SCREEN_RANGES,
  type GravityUnit,
  type ScreenFormat,
  type ScreenItem,
  type ScreenPalette,
  type ScreenRange,
  type ScreenTheme,
  type TemperatureUnit,
} from '@rapthooker/shared';
import { bytes } from '../format';
import { t } from '../i18n';
import { decimalsExample, decimalsOptions, useUnits } from '../units';
import { Icon } from './Icon';
import { PalettePicker } from './PalettePicker';
import { CONTENT_PRESETS, contentPreset, FORMAT_LABELS, ITEM_LABELS, RANGE_LABELS } from './imageLinkOptions';
import './ImageLink.css';

/**
 * The parts of a screen picture's design that image links (components/ImageLink.tsx) and RaptHooker screens
 * (pages/screens) share: what's on it and how it looks, and a preview of it as the hub draws it.
 */

export interface PictureDesign {
  show: ScreenItem[];
  range: ScreenRange;
  /** With every pill: only the ones with a brew running. */
  brewing: boolean;
  /** A warning sign on a device with an alert waiting to be acknowledged. */
  alerts: boolean;
  theme: ScreenTheme;
  palette: ScreenPalette;
  gravity: GravityUnit;
  temperature: TemperatureUnit;
  /** Decimals for the gravity (in `gravity`'s unit) and temperatures; null for the hub's. */
  gravityDecimals: number | null;
  temperatureDecimals: number | null;
}

const n2 = (v: number) => Math.round(v * 100) / 100;

/** "What to show" and "Look". `all`: the picture has every pill, so it can be limited to the brewing ones. */
export function PictureFields({
  value,
  onChange,
  all,
  idPrefix,
}: {
  value: PictureDesign;
  onChange: (patch: Partial<PictureDesign>) => void;
  all: boolean;
  idPrefix: string;
}) {
  const preset = contentPreset(value.show);
  const rangeId = `${idPrefix}-range`;
  // Decimals left to the hub follow its setting.
  const hub = useUnits().decimals;
  const gravityExample = (d: number) => (value.gravity === 'plato' ? `${decimalsExample('plato', d)} °P` : decimalsExample('sg', d));
  const tempExample = (d: number) => `${decimalsExample('temperature', d)} °${value.temperature}`;
  const toggle = (item: ScreenItem) => {
    const on = value.show.includes(item);
    onChange({ show: SCREEN_ITEMS.filter((i) => (i === item ? !on : value.show.includes(i))) });
  };
  return (
    <>
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
              onClick={() => onChange({ show: [...p.items] })}
            >
              {t(p.label)}
            </button>
          ))}
          {!preset && <span className="chip on">{t('Custom')}</span>}
        </div>
        <div className="image-link-items">
          {SCREEN_ITEMS.map((item) => (
            <label key={item} className="check">
              <input type="checkbox" checked={value.show.includes(item)} onChange={() => toggle(item)} />
              <span>{t(ITEM_LABELS[item])}</span>
            </label>
          ))}
        </div>
        {value.show.includes('chart') && (
          <label className="field" htmlFor={rangeId}>
            <span>{t('The graph shows')}</span>
            <select
              id={rangeId}
              className="select"
              value={value.range}
              onChange={(e) => onChange({ range: SCREEN_RANGES.find((r) => r === e.target.value) ?? 'brew' })}
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
            <input type="checkbox" checked={value.brewing} onChange={(e) => onChange({ brewing: e.target.checked })} />
            <span>{t('Only pills with a brew running')}</span>
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={value.alerts} onChange={(e) => onChange({ alerts: e.target.checked })} />
          <span>
            <Icon name="alert" size={14} /> {t('Alert sign')}
            <span className="small muted"> · {t('in the corner while an alert waits to be acknowledged')}</span>
          </span>
        </label>
        <p className="hint">{t("What doesn't fit at a readable size is left out, so check the preview.")}</p>
      </fieldset>

      <fieldset className="fieldset">
        <legend>{t('Look')}</legend>
        <div className="row">
          <div className="segmented" role="group" aria-label={t('Theme')}>
            {(['dark', 'light'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={value.theme === m ? 'on' : ''}
                aria-pressed={value.theme === m}
                onClick={() => onChange({ theme: m })}
              >
                <Icon name={m === 'dark' ? 'moon' : 'sun'} size={14} /> {m === 'dark' ? t('Dark') : t('Light')}
              </button>
            ))}
          </div>
          <PalettePicker compact value={value.palette} onChange={(palette) => onChange({ palette })} />
        </div>
        <div className="row">
          <div className="segmented" role="group" aria-label={t('Gravity unit')}>
            {(['sg', 'plato'] as const).map((g) => (
              <button
                key={g}
                type="button"
                className={value.gravity === g ? 'on' : ''}
                aria-pressed={value.gravity === g}
                onClick={() =>
                  // Decimals picked for the other unit don't suit this one.
                  onChange({ gravity: g, ...(g !== value.gravity && value.gravityDecimals !== null ? { gravityDecimals: null } : {}) })
                }
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
                className={value.temperature === u ? 'on' : ''}
                aria-pressed={value.temperature === u}
                onClick={() => onChange({ temperature: u })}
              >
                °{u}
              </button>
            ))}
          </div>
        </div>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <label className="field" htmlFor={`${idPrefix}-gdec`}>
            <span>{t('Gravity decimals')}</span>
            <select
              id={`${idPrefix}-gdec`}
              className="select"
              value={value.gravityDecimals ?? ''}
              onChange={(e) => onChange({ gravityDecimals: e.target.value === '' ? null : Number(e.target.value) })}
            >
              <option value="">{t('Like the hub ({example})', { example: gravityExample(gravityDecimals(hub, value.gravity)) })}</option>
              {decimalsOptions(value.gravity, value.gravityDecimals).map((d) => (
                <option key={d} value={d}>
                  {gravityExample(d)}
                </option>
              ))}
            </select>
          </label>
          <label className="field" htmlFor={`${idPrefix}-tdec`}>
            <span>{t('Temperature decimals')}</span>
            <select
              id={`${idPrefix}-tdec`}
              className="select"
              value={value.temperatureDecimals ?? ''}
              onChange={(e) => onChange({ temperatureDecimals: e.target.value === '' ? null : Number(e.target.value) })}
            >
              <option value="">{t('Like the hub ({example})', { example: tempExample(hub.temperature) })}</option>
              {decimalsOptions('temperature', value.temperatureDecimals).map((d) => (
                <option key={d} value={d}>
                  {tempExample(d)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </fieldset>
    </>
  );
}

/** The picture as the hub draws it, fetched again (after a short pause) whenever the link changes. */
export function ImagePreview({ path, width, height, format }: { path: string; width: number; height: number; format: ScreenFormat }) {
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
