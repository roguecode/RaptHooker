import { useState } from 'react';
import type { Brew, Pill } from '@rapthooker/shared';
import { api, errorText } from '../../api';
import { useLive } from '../../live';
import { useUnits } from '../../units';
import { href } from '../../router';
import { dateTime, days, fixed, useNow } from '../../format';
import { Icon } from '../../components/Icon';
import { CollapsiblePanel, usePanelOpen } from '../../components/CollapsiblePanel';
import { FermentBar } from '../../components/Ferment';
import { Confirm } from '../../components/ui';
import { t } from '../../i18n';
import { EventsSection } from '../brews/events';
import { abvOf, PredictionStats, StageChip, useAbvFormula } from '../brews/Prediction';
import { StartBrewModal } from './StartBrewModal';

export function BrewPanel({ pill }: { pill: Pill }) {
  const { isOwner, toast } = useLive();
  const u = useUnits();
  const now = useNow(60_000);
  const [starting, setStarting] = useState(false);
  const [ending, setEnding] = useState<Brew | null>(null);
  const formula = useAbvFormula();
  const [open, toggle] = usePanelOpen('pill.brew', true);
  const brew = pill.brew;
  const abv = brew ? abvOf(brew) : null;

  return (
    <>
      {brew && abv ? (
        <CollapsiblePanel
          open={open}
          onToggle={toggle}
          title={
            <>
              <Icon name="beer" /> {brew.name}
            </>
          }
          badges={brew.stats.prediction && <StageChip brew={brew} />}
          lead={`${brew.style ? `${brew.style} · ` : ''}${t('started {date} ({days} ago)', { date: dateTime(brew.startedAt), days: days(now - brew.startedAt) })}`}
          actions={
            <>
              <a className="btn small" href={href.brew(brew.id)}>
                {t('Details')} <Icon name="right" size={16} />
              </a>
              {isOwner && !pill.archived && (
                <button type="button" className="btn small danger" onClick={() => setEnding(brew)}>
                  <Icon name="stop" size={14} /> {t('End brew')}
                </button>
              )}
            </>
          }
        >
          <div className="stack">
            <FermentBar brew={brew} />
            <div className="stat-row">
              {/* i18n: OG = original gravity */}
              <Stat k={t('OG')} v={u.gravityText(brew.stats.og)} s={brew.stats.ogAuto ? t('auto') : undefined} />
              <Stat k={t('Now')} v={u.gravityText(brew.stats.gravity)} />
              <Stat k={t('Target FG')} v={u.gravityText(brew.targetFg)} />
              <Stat
                k={abv.final ? t('Final ABV') : t('ABV so far')}
                v={abv.value === null ? '–' : fixed(abv.value, 2)}
                s="%"
                title={`${t(formula.label)}: ${formula.formula}`}
              />
              <Stat k={t('Attenuation')} v={brew.stats.attenuation === null ? '–' : fixed(brew.stats.attenuation, 0)} s="%" />
              <Stat
                k={t('Temp range')}
                v={
                  brew.stats.tempMin === null
                    ? '–'
                    : `${fixed(u.tempValue(brew.stats.tempMin), 1)}–${fixed(u.tempValue(brew.stats.tempMax!), 1)}`
                }
                s={u.tempLabel}
              />
              <PredictionStats brew={brew} now={now} />
            </div>
            <EventsSection brew={brew} limit={4} />
          </div>
        </CollapsiblePanel>
      ) : (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>
                {/* i18n: "Brew" is a noun here (a batch of beer) */}
                <Icon name="beer" /> {t('Brew')}
              </h2>
              <p>{t('This pill is recording, but no brew is running. Start one to track a batch from pitch to packaging.')}</p>
            </div>
            {isOwner && !pill.archived && (
              <div className="row">
                <button type="button" className="btn primary" onClick={() => setStarting(true)}>
                  <Icon name="play" size={16} /> {t('Start a brew')}
                </button>
              </div>
            )}
          </div>
        </section>
      )}
      {starting && <StartBrewModal pill={pill} onClose={() => setStarting(false)} />}
      {ending && (
        <Confirm
          title={t('End "{name}"?', { name: ending.name })}
          body={<p>{t('The brew is saved with its final stats. The pill carries on recording either way.')}</p>}
          confirm={t('End brew')}
          danger
          onClose={() => setEnding(null)}
          onConfirm={async () => {
            try {
              await api.endBrew(ending.id);
              toast({ tone: 'success', title: t('Brew ended'), body: t('{name} has been saved.', { name: ending.name }) });
            } catch (err) {
              toast({ tone: 'error', title: t("Couldn't end the brew"), body: errorText(err) });
            }
          }}
        />
      )}
    </>
  );
}

function Stat({ k, v, s, title }: { k: string; v: string; s?: string; title?: string }) {
  return (
    <div className="stat" title={title}>
      <div className="k">{k}</div>
      <div className="v">
        {v}
        {s && <small>{s}</small>}
      </div>
    </div>
  );
}
