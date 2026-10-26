import { useCallback, useEffect, useState } from 'react';
import type { Brew } from '@rapthooker/shared';
import { api, errorText } from '../../api';
import { useLive, useLiveMessages } from '../../live';
import { useUnits } from '../../units';
import { href } from '../../router';
import { dateOnly, fixed, useNow } from '../../format';
import { Icon } from '../../components/Icon';
import { FermentBar } from '../../components/Ferment';
import { t, tp } from '../../i18n';
import { StartBrewModal } from '../pill';
import { ComparePanel, MAX_COMPARE } from './Compare';
import { abvOf, StageChip } from './Prediction';
import './brews.css';

function useBrews() {
  const [brews, setBrews] = useState<Brew[] | null>(null);
  const { toast } = useLive();
  const load = useCallback(async () => {
    try {
      setBrews(await api.brews());
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't load brews"), body: errorText(err) });
    }
  }, [toast]);
  useEffect(() => {
    void load();
  }, [load]);
  useLiveMessages((msg) => {
    if (msg.type === 'brew')
      setBrews((cur) =>
        cur ? (cur.some((b) => b.id === msg.brew.id) ? cur.map((b) => (b.id === msg.brew.id ? msg.brew : b)) : [msg.brew, ...cur]) : cur,
      );
    if (msg.type === 'brew-removed') setBrews((cur) => cur?.filter((b) => b.id !== msg.brewId) ?? cur);
  });
  return brews;
}

/** Brews picked for comparing, kept in the address (#/brews?compare=a,b) so a comparison can be bookmarked. */
function useCompareSelection() {
  const [ids, setIds] = useState<string[]>(() => {
    const query = window.location.hash.split('?')[1] ?? '';
    return (new URLSearchParams(query).get('compare') ?? '').split(',').filter(Boolean).slice(0, MAX_COMPARE);
  });
  useEffect(() => {
    const hash = ids.length > 0 ? `#/brews?compare=${ids.map(encodeURIComponent).join(',')}` : '#/brews';
    if (window.location.hash !== hash) window.history.replaceState(null, '', hash);
  }, [ids]);
  return [ids, setIds] as const;
}

export function BrewsPage() {
  const brews = useBrews();
  const { pills, isOwner, toast } = useLive();
  const u = useUnits();
  const now = useNow(60_000);
  const [startFor, setStartFor] = useState<string | null>(null);
  const [selected, setSelected] = useCompareSelection();
  const [picking, setPicking] = useState(selected.length > 0);
  const pillOf = (id: string) => pills.find((p) => p.id === id);
  const active = brews?.filter((b) => b.endedAt === null) ?? [];
  const past = brews?.filter((b) => b.endedAt !== null) ?? [];
  const free = pills.filter((p) => !p.archived && !p.brew && p.kind === 'pill');
  const known = brews ? selected.filter((id) => brews.some((b) => b.id === id)) : selected;

  const toggle = (id: string) => {
    if (selected.includes(id)) setSelected(selected.filter((x) => x !== id));
    else if (selected.length >= MAX_COMPARE)
      toast({ tone: 'info', title: tp(MAX_COMPARE, 'Up to {count} brew at a time', 'Up to {count} brews at a time') });
    else setSelected([...selected, id]);
  };
  /** In compare mode a click picks the brew instead of opening it. */
  const pick = (id: string) => (e: React.MouseEvent) => {
    if (!picking) return;
    e.preventDefault();
    toggle(id);
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('Brews')}</h1>
          <p>{t('Every batch, from pitch to packaging. Pills record all the time; a brew just marks out a batch.')}</p>
        </div>
        <div className="row">
          {(brews?.length ?? 0) >= 2 && (
            <button
              type="button"
              className={`btn${picking ? ' primary' : ''}`}
              aria-pressed={picking}
              onClick={() => {
                if (picking) setSelected([]);
                setPicking(!picking);
              }}
            >
              <Icon name="layers" size={16} /> {picking ? t('Stop comparing') : t('Compare')}
            </button>
          )}
          {isOwner && free.length > 0 && !picking && (
            <select
              className="select"
              style={{ width: 'auto' }}
              value=""
              onChange={(e) => setStartFor(e.target.value || null)}
              aria-label={t('Start a brew on')}
            >
              <option value="">{t('Start a brew on…')}</option>
              {free.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {picking && (
        <div className="notice compare-bar">
          <Icon name="layers" />
          <p className="grow">
            {known.length < 2
              ? known.length === 0
                ? t('Pick two to eight brews below to overlay their curves.')
                : t('Pick at least one more brew below to overlay their curves.')
              : tp(
                  known.length,
                  '{count} of up to {max} brews picked. Tap a brew to add or remove it.',
                  '{count} of up to {max} brews picked. Tap a brew to add or remove it.',
                  { max: MAX_COMPARE },
                )}
          </p>
          {known.length > 0 && (
            <button type="button" className="btn small ghost" onClick={() => setSelected([])}>
              {t('Clear')}
            </button>
          )}
        </div>
      )}

      {brews && known.length >= 2 && <ComparePanel ids={known} brews={brews} onClear={() => setSelected([])} />}

      {brews === null ? (
        <div className="skeleton" style={{ height: '12rem' }} />
      ) : (
        <>
          <section className="stack">
            <h2 style={{ margin: 0, fontSize: '1.1rem' }}>{t('On the go')}</h2>
            {active.length === 0 ? (
              <div className="panel muted">
                {isOwner && free.length
                  ? t("No brews running. Start one from a pill's page or with the menu above.")
                  : t("No brews running. Start one from a pill's page.")}
              </div>
            ) : (
              <div className="grid cards">
                {active.map((b) => {
                  const pill = pillOf(b.pillId);
                  const abv = abvOf(b);
                  return (
                    <a
                      key={b.id}
                      className={`panel pill-card${picking ? ' picking' : ''}${selected.includes(b.id) ? ' picked' : ''}`}
                      href={href.brew(b.id)}
                      onClick={pick(b.id)}
                      role={picking ? 'checkbox' : undefined}
                      aria-checked={picking ? selected.includes(b.id) : undefined}
                      style={{ '--pill': pill?.color ?? 'var(--violet-2)' } as React.CSSProperties}
                    >
                      <div className="pill-card-head">
                        {picking && <CompareCheck on={selected.includes(b.id)} />}
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <h3>{b.name}</h3>
                          <div className="sub">
                            {b.style || t('No style')} · {pill?.name ?? t('Removed pill')}
                          </div>
                        </div>
                        <div className="chips" style={{ justifyContent: 'flex-end' }}>
                          <span className="chip brew">{t('Day {day}', { day: Math.floor((now - b.startedAt) / 86_400_000) + 1 })}</span>
                          {b.stats.prediction && <StageChip brew={b} />}
                        </div>
                      </div>
                      <div className="big-readings">
                        <div>
                          <div className="reading-label">{t('Now')}</div>
                          <div className="gravity-value">{u.gravityText(b.stats.gravity)}</div>
                        </div>
                        <div>
                          <div className="reading-label" style={{ textAlign: 'right' }}>
                            {abv.final ? t('ABV') : t('ABV so far')}
                          </div>
                          <div className="temp-value">{abv.value === null ? '–' : `${fixed(abv.value, 1)}%`}</div>
                        </div>
                      </div>
                      <FermentBar brew={b} />
                    </a>
                  );
                })}
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>
                <Icon name="archive" /> {t('Finished')}
              </h2>
              <span className="chip">{past.length}</span>
            </div>
            {past.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                {t('Finished brews will be kept here with their charts and stats.')}
              </p>
            ) : (
              <div className="list">
                {past.map((b) => {
                  const abv = abvOf(b);
                  return (
                    <a
                      key={b.id}
                      className={`list-item${picking ? ' picking' : ''}${selected.includes(b.id) ? ' picked' : ''}`}
                      href={href.brew(b.id)}
                      onClick={pick(b.id)}
                      role={picking ? 'checkbox' : undefined}
                      aria-checked={picking ? selected.includes(b.id) : undefined}
                    >
                      {picking ? (
                        <CompareCheck on={selected.includes(b.id)} />
                      ) : (
                        <span className="status-dot" style={{ background: pillOf(b.pillId)?.color }} />
                      )}
                      <div className="grow">
                        <h4>{b.name}</h4>
                        <p>
                          {b.style ? `${b.style} · ` : ''}
                          {dateOnly(b.startedAt)} – {dateOnly(b.endedAt)} · {pillOf(b.pillId)?.name ?? t('removed pill')}
                        </p>
                      </div>
                      <div className="num small muted" style={{ textAlign: 'right' }}>
                        {u.gravityText(b.stats.og)} → {u.gravityText(b.stats.gravity)}
                        <br />
                        <strong style={{ color: 'var(--text)' }}>
                          {abv.value === null ? '–' : t('{abv} ABV', { abv: `${fixed(abv.value, 1)}%` })}
                        </strong>
                      </div>
                      {!picking && <Icon name="right" />}
                    </a>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
      {startFor && pillOf(startFor) && <StartBrewModal pill={pillOf(startFor)!} onClose={() => setStartFor(null)} />}
    </div>
  );
}

function CompareCheck({ on }: { on: boolean }) {
  return (
    <span className={`compare-check${on ? ' on' : ''}`} aria-hidden="true">
      <Icon name="check" size={14} strokeWidth={3} />
    </span>
  );
}
