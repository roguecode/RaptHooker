import { useCallback, useEffect, useState } from 'react';
import type { Brew, BrewCurve } from '@rapthooker/shared';
import { ApiError, api, errorText } from '../../api';
import { useLive, useLiveMessages } from '../../live';
import { useUnits } from '../../units';
import { href } from '../../router';
import { dateOnly, dateTime, days, fixed } from '../../format';
import { Icon } from '../../components/Icon';
import { t, tp } from '../../i18n';
import { brewApi } from './api';
import { EventIcon } from './events';
import { abvOf, brewDay, eventKind, finishText, formulaOf, formulaWords, summaryText } from './brewText';
import { SummaryChart } from './SummaryChart';
import { LoadFailed } from './BrewPage';
import './summary.css';

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Plain http (e.g. http://rapthooker.local) has no clipboard API: fall back to a hidden text box.
  const box = document.createElement('textarea');
  box.value = text;
  box.setAttribute('readonly', '');
  box.style.position = 'fixed';
  box.style.opacity = '0';
  document.body.appendChild(box);
  box.select();
  const ok = document.execCommand('copy');
  box.remove();
  if (!ok) throw new Error(t("The browser wouldn't copy it"));
}

/** A printable, shareable one-page summary of a brew. */
export function BrewSummaryPage({ id }: { id: string }) {
  const { pills, hub, toast } = useLive();
  const u = useUnits();
  const [brew, setBrew] = useState<Brew | null | undefined>(undefined);
  const [curve, setCurve] = useState<BrewCurve | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const formula = formulaOf(hub.abvFormula);

  const load = useCallback(() => {
    api.brew(id).then(
      (b) => {
        setBrew(b);
        setLoadError(null);
      },
      (err: unknown) => (err instanceof ApiError && err.status === 404 ? setBrew(null) : setLoadError(errorText(err))),
    );
    brewApi.compare([id]).then(
      (c) => setCurve(c[0] ?? null),
      () => setCurve(null),
    );
  }, [id]);
  useEffect(load, [load]);
  useLiveMessages((msg) => {
    if (msg.type === 'hello' && loadError !== null) load();
    if (msg.type === 'brew' && msg.brew.id === id) setBrew(msg.brew);
  });

  if (brew === undefined)
    return loadError ? <LoadFailed error={loadError} onRetry={load} /> : <div className="skeleton" style={{ height: '20rem' }} />;
  if (brew === null) {
    return (
      <div className="panel empty">
        <h2>{t('Brew not found')}</h2>
        <a className="btn" href="#/brews">
          {t('All brews')}
        </a>
      </div>
    );
  }
  const pill = pills.find((p) => p.id === brew.pillId);
  const s = brew.stats;
  const abv = abvOf(brew);
  const running = brew.endedAt === null;
  const p = s.prediction;

  const copy = async () => {
    try {
      await copyText(summaryText(brew, pill?.name ?? null, u, formula));
      toast({ tone: 'success', title: t('Summary copied'), body: t('Paste it wherever you like.') });
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't copy the summary"), body: errorText(err) });
    }
  };

  return (
    <div className="page brew-summary">
      <div className="row summary-actions">
        <a className="back spacer" href={href.brew(brew.id)}>
          <Icon name="left" size={16} /> {t('Back to the brew')}
        </a>
        <button type="button" className="btn small" onClick={() => void copy()}>
          <Icon name="copy" size={15} /> {t('Copy summary')}
        </button>
        <button type="button" className="btn small primary" onClick={() => window.print()}>
          <Icon name="printer" size={15} /> {t('Print / Save as PDF')}
        </button>
      </div>

      <article className="panel summary-sheet">
        <header className="summary-head">
          <div>
            <h1>{brew.name}</h1>
            <p className="summary-sub">
              {brew.style || t('No style given')}
              {pill && <> · {t('recorded by {name}', { name: pill.name })}</>}
            </p>
          </div>
          <div className="summary-dates">
            <div>
              {dateOnly(brew.startedAt)} – {running ? t('still fermenting') : dateOnly(brew.endedAt)}
            </div>
            <div className="muted">
              {running
                ? t('{days} so far', { days: days(Date.now() - brew.startedAt) })
                : days((brew.endedAt ?? Date.now()) - brew.startedAt)}
            </div>
          </div>
        </header>

        <dl className="summary-figures">
          <div>
            <dt>{t('OG')}</dt>
            <dd>
              {u.gravityText(s.og)}
              {s.ogAuto && s.og !== null && <small>{t('from the pill')}</small>}
            </dd>
          </div>
          <div>
            <dt>{running ? t('Gravity now') : t('FG')}</dt>
            <dd>
              {u.gravityText(s.gravity)}
              {brew.targetFg !== null && <small>{t('target {gravity}', { gravity: u.gravityText(brew.targetFg) })}</small>}
            </dd>
          </div>
          <div>
            <dt>{abv.final ? t('ABV') : t('ABV so far')}</dt>
            <dd>
              {abv.value === null ? '–' : `${fixed(abv.value, 2)}%`}
              <small>{formulaWords(formula)}</small>
            </dd>
          </div>
          <div>
            <dt>{t('Attenuation')}</dt>
            <dd>
              {s.attenuation === null ? '–' : `${fixed(s.attenuation, 1)}%`}
              {/* i18n: apparent attenuation */}
              <small>{t('apparent')}</small>
            </dd>
          </div>
          <div>
            <dt>{t('Temperature')}</dt>
            <dd>
              {s.tempAvg === null ? '–' : u.tempText(s.tempAvg)}
              {s.tempMin !== null && <small>{t('{min} to {max}', { min: u.tempText(s.tempMin), max: u.tempText(s.tempMax) })}</small>}
            </dd>
          </div>
          {running && p && p.stage !== 'lag' && (
            <div>
              <dt>{p.stage === 'done' ? t('Finished') : t('Predicted FG')}</dt>
              <dd>
                {u.gravityText(p.fg)}
                <small>{finishText(p, Date.now())}</small>
              </dd>
            </div>
          )}
        </dl>

        {curve ? (
          <SummaryChart curve={curve} events={brew.events} targetFg={brew.targetFg} color={pill?.color} />
        ) : (
          <div className="skeleton summary-chart-skeleton" />
        )}

        {brew.events.length > 0 && (
          <section className="summary-section">
            <h2>{t('Timeline')}</h2>
            <ol className="summary-events">
              {brew.events.map((e, i) => (
                <li key={e.id}>
                  <span className="summary-event-no">{i + 1}</span>
                  <EventIcon kind={e.kind} size={13} />
                  <span className="grow">
                    <strong>{e.kind === 'note' ? t('Note') : t(eventKind(e.kind).label)}</strong>
                    {e.text && <> {e.text}</>}
                  </span>
                  <span className="muted small num">
                    {brewDay(brew.startedAt, e.at)} · {dateTime(e.at)}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {brew.notes.trim() && (
          <section className="summary-section">
            <h2>{t('Notes')}</h2>
            <p className="summary-notes">{brew.notes.trim()}</p>
          </section>
        )}

        <footer className="summary-foot">
          {t('ABV by the {formula}: {math}.', { formula: formulaWords(formula), math: formula.formula })}{' '}
          {tp(s.readings, '{count} reading.', '{count} readings.')} {t('Recorded with RaptHooker.')}
        </footer>
      </article>
    </div>
  );
}
