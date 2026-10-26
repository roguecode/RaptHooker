import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { api } from '../../api';
import { useLive } from '../../live';
import { href } from '../../router';
import { sortByOrder } from '../../order';
import { parseFlag, serializeFlag, useStored } from '../../storage';
import { guideNeeded, guideSteps, guideVisible, parseGuideMemory, type GuideMemory, type GuideStepId } from '../../guide';
import { Icon } from '../../components/Icon';
import { CreatePinForm } from '../settings/OwnerSection';
import { t, tp } from '../../i18n';
import { Trans } from '../../i18n/Trans';

const MEMORY_KEY = 'rapthooker.guide';
const HIDDEN_KEY = 'rapthooker.guide-hidden';
const serializeMemory = (m: GuideMemory): string => m ?? '';

/** Whether the first-run guide is on the dashboard, and how to hide it. */
export function useGuide() {
  const { pills, session, loaded } = useLive();
  const [memory, setMemory] = useStored(MEMORY_KEY, parseGuideMemory, serializeMemory);
  const [hidden, setHidden] = useStored(HIDDEN_KEY, parseFlag, serializeFlag, 'session');
  const ready = loaded && session !== null;
  const needed = ready && guideNeeded({ pinSet: session.pinSet, pills: pills.length });
  const visible = ready && guideVisible({ needed, pills: pills.length, memory, hiddenThisVisit: hidden });
  const count = pills.length;

  const hide = useCallback(() => {
    if (count > 0) setMemory('dismissed');
    else setHidden(true);
  }, [count, setMemory, setHidden]);

  // Remember that this browser is setting the hub up, so it can show the finishing touches once that's done.
  useEffect(() => {
    if (visible && needed && memory !== 'seen') setMemory('seen');
  }, [visible, needed, memory, setMemory]);

  return { visible, hide };
}

function Step({ n, done, current, title, children }: { n: number; done: boolean; current: boolean; title: string; children: ReactNode }) {
  return (
    <li className={`guide-step${done ? ' done' : ''}${current ? ' current' : ''}`} aria-current={current ? 'step' : undefined}>
      <span className="guide-mark" aria-hidden="true">
        {done ? <Icon name="check" size={16} strokeWidth={3} /> : n}
      </span>
      <div className="guide-body">
        <h3>
          {title}
          {done && <span className="sr-only"> {t('(done)')}</span>}
        </h3>
        {children}
      </div>
    </li>
  );
}

/** A step-by-step guide for a new hub that ticks itself off as things happen. */
export function FirstRunGuide({ onHide }: { onHide: () => void }) {
  const { session, pills, nearby, ble, isOwner } = useLive();
  const [counts, setCounts] = useState<{ webhooks: number | null; alerts: number | null }>({ webhooks: null, alerts: null });
  const titleId = useId();
  const added = pills.length > 0;

  useEffect(() => {
    if (!added) return;
    let stopped = false;
    void Promise.allSettled([api.webhooks(), api.alertRules()]).then(([w, a]) => {
      if (stopped) return;
      setCounts({
        webhooks: w.status === 'fulfilled' ? w.value.length : null,
        alerts: a.status === 'fulfilled' ? a.value.length : null,
      });
    });
    return () => {
      stopped = true;
    };
  }, [added]);

  const brewing = pills.some((p) => p.brew);
  const steps = guideSteps({ pinSet: Boolean(session?.pinSet), pills: pills.length, nearby: nearby.length, brewing, ...counts });
  const done = (id: GuideStepId) => steps.find((s) => s.id === id)?.done ?? false;
  const essentials = steps.filter((s) => !s.optional);
  const doneCount = essentials.filter((s) => s.done).length;
  const allDone = doneCount === essentials.length;
  const current = essentials.find((s) => !s.done)?.id ?? 'extras';
  const firstPill = sortByOrder(pills.filter((p) => !p.archived && p.kind === 'pill'))[0] ?? pills.find((p) => p.kind === 'pill');
  const listening = ble?.state === 'scanning' || ble?.state === 'mock';

  return (
    <section className="panel guide" aria-labelledby={titleId}>
      <div className="panel-head">
        <div>
          <h2 id={titleId}>
            <Icon name="sparkles" /> {allDone ? t("You're all set") : t("Let's get your first pill recording")}
          </h2>
          <p>
            {allDone
              ? t('Your pill is recording around the clock. A few extras you might like:')
              : t('{done} of {total} done. Each step ticks itself off.', { done: doneCount, total: essentials.length })}
          </p>
        </div>
        <button type="button" className="btn small ghost guide-hide" aria-label={allDone ? t('Done') : t('Hide guide')} onClick={onHide}>
          <Icon name="x" size={14} /> <span className="hide-mobile">{allDone ? t('Done') : t('Hide guide')}</span>
        </button>
      </div>
      {essentials.length > 0 && (
        <div
          className="bar guide-progress"
          role="progressbar"
          aria-label={t('Setup progress')}
          aria-valuemin={0}
          aria-valuemax={essentials.length}
          aria-valuenow={doneCount}
        >
          <i style={{ width: `${(doneCount / essentials.length) * 100}%` }} />
        </div>
      )}
      <ol className="guide-steps">
        <Step n={1} done={done('pin')} current={current === 'pin'} title={t('Create your owner PIN')}>
          {done('pin') ? (
            <p>{t('Done. Anyone on your network can look, but only you can change things.')}</p>
          ) : (
            <>
              <p>
                {session?.role === 'owner' && session.via !== 'pin'
                  ? t(
                      'Anyone on your network can look at your readings. The PIN keeps adding pills, brews and webhooks to you when you use another device.',
                    )
                  : t('Anyone on your network can look at your readings. The PIN keeps adding pills, brews and webhooks to you.')}
              </p>
              <CreatePinForm />
            </>
          )}
        </Step>
        <Step n={2} done={done('bluetooth')} current={current === 'bluetooth'} title={t('Put your pill in Bluetooth mode')}>
          {done('bluetooth') ? (
            <p>{added ? t('Done: the hub can hear your pill.') : t('Done: the hub can hear a pill.')}</p>
          ) : (
            <>
              <p>
                <Trans
                  text={t(
                    'In the RAPT app (or the RAPT portal), open your pill and choose {path}. The interval you set there is how often it sends a reading: every few minutes is plenty.',
                  )}
                  values={{ path: <strong>{t('Connect → Setup → Telemetry via Bluetooth')}</strong> }}
                />
              </p>
              <p>
                {t(
                  'Keep the pill within Bluetooth range of this hub. The same room is best; thick walls and steel fermenters cut the range.',
                )}
              </p>
              {ble && (
                <p className={`small ${listening ? 'guide-ok' : 'guide-warn'}`}>
                  <Icon name="bluetooth" size={14} />{' '}
                  {listening ? (
                    t('The hub is listening now.')
                  ) : ble.state === 'starting' ? (
                    t('Bluetooth is starting…')
                  ) : (
                    <Trans
                      text={t("Bluetooth isn't working on the hub yet: see {settings}.")}
                      values={{ settings: <a href="#/settings">{t('Settings')}</a> }}
                    />
                  )}
                </p>
              )}
            </>
          )}
        </Step>
        <Step n={3} done={done('add')} current={current === 'add'} title={t('Add it when it appears under “Nearby”')}>
          {done('add') ? (
            <p>
              <Trans
                text={t('Done: {pill} is recording.')}
                values={{ pill: <a href={firstPill ? href.pill(firstPill.id) : '#/'}>{firstPill?.name ?? t('your pill')}</a> }}
              />
            </p>
          ) : nearby.length > 0 ? (
            <p>
              <Trans
                text={
                  isOwner
                    ? t('{found}: give it a name and press {button} below.', { button: t('Add pill') })
                    : t('{found}: sign in with the owner PIN to add it.')
                }
                values={{ found: <strong>{tp(nearby.length, 'Found a pill nearby', 'Found {count} pills nearby')}</strong> }}
              />
            </p>
          ) : (
            <p>
              {t('It shows up below as “{heading}” after its next reading. Pills only send every few minutes, so give it a little while.', {
                heading: t('Found a RAPT Pill nearby'),
              })}
            </p>
          )}
        </Step>
        <Step n={4} done={done('extras')} current={current === 'extras'} title={t('Optional: brews, webhooks and alerts')}>
          <ul className="guide-extras">
            <li className={brewing ? 'done' : ''}>
              <Icon name={brewing ? 'circleCheck' : 'beer'} size={16} />
              <span>
                <Trans
                  text={t("{start} to follow its gravity, ABV and when it's finished.")}
                  values={{ start: firstPill ? <a href={href.pill(firstPill.id)}>{t('Start a brew')}</a> : t('Start a brew') }}
                />
              </span>
            </li>
            <li className={(counts.webhooks ?? 0) > 0 ? 'done' : ''}>
              <Icon name={(counts.webhooks ?? 0) > 0 ? 'circleCheck' : 'webhook'} size={16} />
              <span>
                <Trans
                  text={t('{add} to send readings to Brewfather, Grainfather, Home Assistant and more.')}
                  values={{ add: <a href={href.webhook(null)}>{t('Add a webhook')}</a> }}
                />
              </span>
            </li>
            <li className={(counts.alerts ?? 0) > 0 ? 'done' : ''}>
              <Icon name={(counts.alerts ?? 0) > 0 ? 'circleCheck' : 'bell'} size={16} />
              <span>
                <Trans
                  text={t('{setUp} for a warm brew, a finished fermentation or a flat battery.')}
                  values={{ setUp: <a href="#/alerts">{t('Set up alerts')}</a> }}
                />
              </span>
            </li>
          </ul>
        </Step>
      </ol>
    </section>
  );
}
