import type { ReactNode } from 'react';
import { SCREEN_SETUP_STEPS, type ScreenSetupProgress, type ScreenSetupStep } from '@rapthooker/shared';
import { useLive } from '../../live';
import { duration, useNow } from '../../format';
import { t } from '../../i18n';
import { Icon } from '../../components/Icon';
import { ScreenThumb } from './ScreenCard';
import { SETUP_ERRORS, STEP_LABELS } from './strings';

type Mark = 'done' | 'on' | 'failed' | 'skipped' | 'todo';

/** How each step stands: reached ones are done, ones jumped over (a screen that already has RaptHooker) skipped. */
function marks(p: ScreenSetupProgress): { step: ScreenSetupStep; mark: Mark }[] {
  const reached = new Set(p.steps.map((s) => s.step));
  const at = SCREEN_SETUP_STEPS.indexOf(p.step);
  return SCREEN_SETUP_STEPS.filter((s) => s !== 'done').map((step, i) => {
    let mark: Mark;
    if (i < at || p.state === 'done') mark = reached.has(step) ? 'done' : 'skipped';
    else if (i === at) mark = p.state === 'failed' ? 'failed' : 'on';
    else mark = 'todo';
    return { step, mark };
  });
}

const MARK_ICON: Record<Mark, ReactNode> = {
  done: <Icon name="check" size={14} />,
  on: <span className="spinner" aria-hidden="true" />,
  failed: <Icon name="x" size={14} />,
  skipped: <Icon name="minus" size={14} />,
  todo: null,
};

/** A set-up the hub is doing (or did): its steps as they happen, and how it ended. */
export function SetupPanel({
  progress,
  onDismiss,
  onRetry,
  onEdit,
  onFind,
}: {
  progress: ScreenSetupProgress;
  onDismiss: () => void;
  onRetry: () => void;
  onEdit: (screenId: string) => void;
  /** Looks for screens on the network (one that set itself up from before turns up there). */
  onFind: () => void;
}) {
  const { screens, connection } = useLive();
  const now = useNow(1000);
  const running = progress.state === 'running';
  const screen = progress.screenId ? screens.find((s) => s.id === progress.screenId) : undefined;
  const elapsed = (running ? now : progress.updatedAt) - progress.startedAt;

  return (
    <section className={`panel setup-panel ${progress.state}`} aria-live="polite">
      <div className="panel-head">
        <div>
          <h2>
            <Icon name={progress.state === 'done' ? 'circleCheck' : progress.state === 'failed' ? 'alert' : 'screen'} />{' '}
            {progress.state === 'done'
              ? t('{name} is set up', { name: screen?.name ?? progress.hotspot })
              : progress.state === 'failed'
                ? t("Setting up the screen didn't work")
                : t('Setting up a screen')}
          </h2>
          <p>
            {progress.hotspot} · {duration(Math.max(0, elapsed))}
          </p>
        </div>
      </div>

      {running && connection !== 'open' && (
        <div className="notice warning">
          <Icon name="wifiOff" />
          <p>{t("The hub is away talking to the screen. This page reconnects by itself when it's back.")}</p>
        </div>
      )}

      <ol className="setup-steps">
        {marks(progress).map(({ step, mark }) => (
          <li key={step} className={mark} aria-current={mark === 'on' ? 'step' : undefined}>
            <span className="setup-step-mark">{MARK_ICON[mark]}</span>
            {t(STEP_LABELS[step])}
            {mark === 'skipped' && <span className="sr-only"> ({t('not needed')})</span>}
          </li>
        ))}
      </ol>

      {progress.state === 'failed' && progress.error && (
        <div className="notice danger" role="alert">
          <Icon name="alert" />
          <div className="grow">
            <p>
              <strong>
                {progress.error === 'not-supported' && progress.detail === 'claimed'
                  ? t('This screen belongs to another hub. Reset it from that hub, or add it from Found on your network.')
                  : t(SETUP_ERRORS[progress.error])}
              </strong>
            </p>
            {progress.detail && progress.detail !== 'claimed' && <p className="small">{progress.detail}</p>}
          </div>
        </div>
      )}
      {!running && !progress.hubBack && (
        <div className="notice danger" role="alert">
          <Icon name="wifiOff" />
          <p>{t("The hub had trouble getting back on its network. If it's unreachable, restart it.")}</p>
        </div>
      )}

      {progress.state === 'done' && screen && (
        <div className="setup-done">
          <ScreenThumb screen={screen} />
          <dl className="kv">
            <dt>{t('IP address')}</dt>
            <dd className="num">{screen.ip ?? '–'}</dd>
            <dt>{t('Name on the network')}</dt>
            <dd className="num">{screen.hostname}.local</dd>
            <dt>{t('MAC address')}</dt>
            <dd className="num">{screen.mac}</dd>
            <dt>{t('Firmware')}</dt>
            <dd>{screen.firmware ?? '–'}</dd>
          </dl>
        </div>
      )}

      {!running && (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          {progress.state === 'failed' && progress.error === 'on-network' && (
            <button type="button" className="btn primary" onClick={onFind}>
              <Icon name="wifi" size={16} /> {t('Find on network')}
            </button>
          )}
          {progress.state === 'failed' && progress.error !== 'on-network' && (
            <button type="button" className="btn" onClick={onRetry}>
              <Icon name="refresh" size={16} /> {t('Try again')}
            </button>
          )}
          {progress.state === 'done' && screen && (
            <button type="button" className="btn" onClick={() => onEdit(screen.id)}>
              <Icon name="pencil" size={16} /> {t('Choose what it shows')}
            </button>
          )}
          <button type="button" className={`btn${progress.state === 'done' ? ' primary' : ' ghost'}`} onClick={onDismiss}>
            {progress.state === 'done' ? t('Done') : t('Dismiss')}
          </button>
        </div>
      )}
    </section>
  );
}
