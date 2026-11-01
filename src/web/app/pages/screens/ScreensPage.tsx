import { useEffect, useState } from 'react';
import { SCREEN_MODELS, type FoundScreen, type ScreenSetupProgress } from '@rapthooker/shared';
import { errorText } from '../../api';
import { useLive, useLiveMessages } from '../../live';
import { useNow } from '../../format';
import { t, tp } from '../../i18n';
import { Icon } from '../../components/Icon';
import { OwnerOnly } from '../../components/ui';
import { screensApi } from './screensApi';
import { AddScreen } from './AddScreen';
import { FoundScreens } from './FoundScreens';
import { ScreenCard } from './ScreenCard';
import { ScreenEditor } from './ScreenEditor';
import { SetupPanel } from './SetupPanel';
import './screens.css';

/** A finished set-up stays on the page this long, unless dismissed. */
const SHOW_FINISHED_MS = 30 * 60_000;
const DISMISSED_KEY = 'rapthooker.screenSetupDismissed';

export function ScreensPage() {
  const { screens, isOwner, loaded, connection, toast } = useLive();
  const now = useNow(60_000);
  const [adding, setAdding] = useState(false);
  const [setup, setSetup] = useState<ScreenSetupProgress | null>(null);
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem(DISMISSED_KEY));
  const [found, setFound] = useState<FoundScreen[]>([]);
  const [looking, setLooking] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [updatingAll, setUpdatingAll] = useState(false);

  // What the hub is doing, again whenever the connection comes back (setting a screen up can take the hub away).
  useEffect(() => {
    if (!isOwner || connection !== 'open') return;
    let live = true;
    screensApi.setup().then(
      (p) => live && setSetup(p),
      () => undefined,
    );
    screensApi.found().then(
      (f) => live && setFound(f),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [isOwner, connection]);

  useLiveMessages((msg) => {
    if (msg.type === 'screen-setup') setSetup(msg.setup);
    if (msg.type === 'screens-found') setFound(msg.found);
  });

  const dismiss = () => {
    if (!setup) return;
    sessionStorage.setItem(DISMISSED_KEY, setup.id);
    setDismissed(setup.id);
  };
  const showSetup = setup && setup.id !== dismissed && (setup.state === 'running' || now - setup.updatedAt < SHOW_FINISHED_MS);
  const settingUp = setup?.state === 'running';

  const lookAround = async () => {
    setLooking(true);
    try {
      const list = await screensApi.discover();
      setFound(list);
      if (list.length === 0) toast({ tone: 'info', title: t('No other RaptHooker screens on your network') });
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't look for screens"), body: errorText(err) });
    } finally {
      setLooking(false);
    }
  };

  const outdated = screens.filter((s) => s.status.update);
  const updateAll = async () => {
    setUpdatingAll(true);
    try {
      const { updated, failed } = await screensApi.updateAll();
      const names = (ids: string[]) => ids.map((id) => screens.find((s) => s.id === id)?.name ?? id).join(', ');
      if (failed.length)
        toast({
          tone: 'error',
          title: t("Couldn't update {names}", { names: names(failed) }),
          body: t('They keep the firmware they had.'),
        });
      if (updated.length) toast({ tone: 'success', title: tp(updated.length, 'Updated {count} screen', 'Updated {count} screens') });
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't update the screens"), body: errorText(err) });
    } finally {
      setUpdatingAll(false);
    }
  };

  const editingScreen = screens.find((s) => s.id === editing);

  return (
    <div className="page screens-page">
      <div className="page-head">
        <div>
          <h1>{t('Screens')}</h1>
          <p>{t('Little Wi-Fi screens that show your pills. The hub sets them up, sends them pictures and keeps them up to date.')}</p>
        </div>
        {isOwner && (
          <div className="page-actions">
            <button type="button" className="btn" disabled={looking} onClick={() => void lookAround()}>
              <Icon name="wifi" size={16} /> {looking ? t('Looking…') : t('Find on network')}
            </button>
            <button type="button" className="btn primary" disabled={settingUp} onClick={() => setAdding(true)}>
              <Icon name="plus" /> {t('Add a screen')}
            </button>
          </div>
        )}
      </div>

      {showSetup && (
        <SetupPanel
          progress={setup}
          onDismiss={dismiss}
          onRetry={() => {
            dismiss();
            setAdding(true);
          }}
          onEdit={(id) => {
            dismiss();
            setEditing(id);
          }}
          onFind={() => {
            dismiss();
            void lookAround();
          }}
        />
      )}

      {isOwner && outdated.length > 0 && (
        <div className="notice screens-update" role="status">
          <Icon name="sparkles" />
          <p className="grow">
            <strong>{t('New screen firmware: {version}', { version: outdated[0]!.status.update! })}</strong>{' '}
            {tp(outdated.length, '{count} screen can be updated.', '{count} screens can be updated.')}{' '}
            {t('Each restarts once, for about half a minute, and keeps its settings.')}
          </p>
          <button
            type="button"
            className="btn primary"
            disabled={updatingAll || outdated.every((s) => s.status.updating)}
            onClick={() => void updateAll()}
          >
            <Icon name="download" size={16} /> {updatingAll ? t('Updating…') : outdated.length > 1 ? t('Update all') : t('Update')}
          </button>
        </div>
      )}

      {isOwner && <FoundScreens found={found} looking={looking} onLookAgain={() => void lookAround()} />}

      {!loaded ? (
        <div className="grid cards" aria-busy="true">
          <div className="skeleton" style={{ height: '12rem' }} />
        </div>
      ) : screens.length === 0 ? (
        <div className="panel empty">
          <span className="screens-art" aria-hidden="true">
            <Icon name="screen" size={64} strokeWidth={1.4} />
          </span>
          <h2>{t('No screens yet')}</h2>
          <p>
            {t(
              'RaptHooker can turn a {name}, a little 240 × 240 Wi-Fi screen, into a display for your pills. Plug one in and add it here: the hub does the rest, including its updates.',
              { name: SCREEN_MODELS[0]!.name },
            )}
          </p>
          {isOwner ? (
            <button type="button" className="btn primary" disabled={settingUp} onClick={() => setAdding(true)}>
              <Icon name="plus" /> {t('Add a screen')}
            </button>
          ) : (
            <OwnerOnly isOwner={false}>{null}</OwnerOnly>
          )}
          <p className="small muted">{t('Supported Screens: {names}', { names: SCREEN_MODELS.map((m) => m.name).join(', ') })}</p>
        </div>
      ) : (
        <div className="grid cards screens-grid">
          {screens.map((s) => (
            <ScreenCard key={s.id} screen={s} />
          ))}
        </div>
      )}

      {adding && (
        <AddScreen
          onClose={() => setAdding(false)}
          onStarted={(p) => {
            setSetup(p);
            setAdding(false);
          }}
        />
      )}
      {editingScreen && <ScreenEditor screen={editingScreen} onClose={() => setEditing(null)} />}
    </div>
  );
}
