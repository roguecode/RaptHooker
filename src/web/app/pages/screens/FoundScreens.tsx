import { useId, useState } from 'react';
import type { FoundScreen } from '@rapthooker/shared';
import { errorText } from '../../api';
import { useLive } from '../../live';
import { t } from '../../i18n';
import { Icon } from '../../components/Icon';
import { screensApi } from './screensApi';
import { newScreenName, useNewLook } from './AddScreen';

/**
 * RaptHooker screens heard on the network that this hub doesn't have (set up by another hub, or before its data was
 * lost). Adding one takes the code it shows, so only someone who can see the screen can add it.
 */
export function FoundScreens({ found, onLookAgain, looking }: { found: FoundScreen[]; onLookAgain: () => void; looking: boolean }) {
  if (found.length === 0) return null;
  return (
    <section className="panel nearby found-screens" aria-label={t('Screens found on your network')}>
      <div className="radar" aria-hidden="true">
        <Icon name="screen" size={20} />
      </div>
      <div className="info">
        <h2>{t('Found on your network')}</h2>
        <p className="small muted">{t("These RaptHooker screens aren't this hub's yet.")}</p>
        <ul className="found-list">
          {found.map((f) => (
            <FoundRow key={f.id} found={f} />
          ))}
        </ul>
      </div>
      <button type="button" className="btn small ghost" disabled={looking} onClick={onLookAgain}>
        <Icon name="refresh" size={14} /> {t('Look again')}
      </button>
    </section>
  );
}

function FoundRow({ found }: { found: FoundScreen }) {
  const { toast, screens, upsertScreen } = useLive();
  const look = useNewLook();
  const id = useId();
  const [asking, setAsking] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const name = newScreenName(screens.map((s) => s.name));

  const ask = async () => {
    setBusy(true);
    try {
      await screensApi.adopt({ id: found.id });
      setAsking(true);
    } catch (err) {
      toast({ tone: 'error', title: t("The screen didn't answer"), body: errorText(err) });
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    setBusy(true);
    try {
      const res = await screensApi.adopt({ id: found.id, code, name, look });
      if (res.screen) {
        upsertScreen(res.screen);
        toast({ tone: 'success', title: t('{name} added', { name: res.screen.name }) });
      }
    } catch (err) {
      const wrong = errorText(err) === 'wrong-code';
      toast({
        tone: 'error',
        title: wrong ? t("That code isn't the one on the screen") : t("Couldn't add the screen"),
        body: wrong ? undefined : errorText(err),
      });
      if (wrong) setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="found-row">
      <div className="grow">
        <strong>{found.hostname}</strong>
        <span className="small muted">
          {' '}
          · {found.ip} · {t('firmware {version}', { version: found.firmware })}
          {found.claimed && ` · ${t('set up by another hub')}`}
        </span>
      </div>
      {asking ? (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <label className="sr-only" htmlFor={id}>
            {t('The code on the screen')}
          </label>
          <input
            id={id}
            className="input num found-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            placeholder={t('Code on the screen')}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            autoFocus
          />
          <button type="submit" className="btn small primary" disabled={busy || code.length !== 6}>
            {t('Add')}
          </button>
        </form>
      ) : (
        <button type="button" className="btn small primary" disabled={busy} onClick={() => void ask()}>
          <Icon name="plus" size={14} /> {t('Add')}
        </button>
      )}
    </li>
  );
}
