import { useId, useState } from 'react';
import type { Session } from '@rapthooker/shared';
import { api, errorText } from '../../api';
import { useLive } from '../../live';
import { t } from '../../i18n';
import { Icon } from '../../components/Icon';

/** The box for a hub's first owner PIN (used here and in the dashboard's first-run guide). */
export function CreatePinForm() {
  const { setSession, toast } = useLive();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const id = useId();
  return (
    <form
      className="row"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          setSession(await api.setPin(pin));
          toast({ tone: 'success', title: t('PIN created: you are signed in') });
          setPin('');
        } catch (err) {
          toast({ tone: 'error', title: t('Not this time'), body: errorText(err) });
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="sr-only" htmlFor={id}>
        {t('New owner PIN')}
      </label>
      <input
        id={id}
        className="input"
        style={{ maxWidth: '14rem' }}
        type="password"
        inputMode="numeric"
        autoComplete="new-password"
        placeholder={t('Choose a PIN (4+ characters)')}
        value={pin}
        onChange={(e) => setPin(e.target.value)}
      />
      <button type="submit" className="btn primary" disabled={busy || pin.length < 4}>
        {t('Create PIN')}
      </button>
    </form>
  );
}

/** A reminder to create the owner PIN, for pages other than Settings. */
export function PinNotice() {
  return (
    <div className="notice">
      <Icon name="lock" />
      <p className="grow">
        <strong>{t('Welcome to RaptHooker!')}</strong> {t('Create an owner PIN so only you can add pills, brews and webhooks.')}
      </p>
      <a className="btn primary small" href="#/settings">
        {t('Create PIN')}
      </a>
    </div>
  );
}

export function OwnerSection() {
  const { session, setSession, toast } = useLive();
  const [pin, setPin] = useState('');
  const [current, setCurrent] = useState('');
  const [busy, setBusy] = useState(false);
  const [changing, setChanging] = useState(false);
  const id = useId();
  if (!session) return null;

  const run = async (fn: () => Promise<Session>, message: string) => {
    setBusy(true);
    try {
      setSession(await fn());
      toast({ tone: 'success', title: message });
      setPin('');
      setCurrent('');
      setChanging(false);
    } catch (err) {
      toast({ tone: 'error', title: t('Not this time'), body: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const owner = session.role === 'owner';
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>
            <Icon name="lock" /> {t('Owner access')}
          </h2>
          <p>
            {t('Anyone who can reach this hub can look.')}{' '}
            {session.via === 'tailscale'
              ? t('Adding pills, brews, webhooks and alerts needs the owner (you, through Tailscale).')
              : t('Adding pills, brews, webhooks and alerts needs the owner.')}
          </p>
        </div>
        {owner ? <span className="chip success">{t("You're the owner")}</span> : <span className="chip">{t('Viewing')}</span>}
      </div>

      {!session.pinSet ? (
        <CreatePinForm />
      ) : !owner ? (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.login(pin), t('Signed in'));
          }}
        >
          <label className="sr-only" htmlFor={`${id}-pin`}>
            {t('Owner PIN')}
          </label>
          <input
            id={`${id}-pin`}
            className="input"
            style={{ maxWidth: '14rem' }}
            type="password"
            inputMode="numeric"
            autoComplete="current-password"
            placeholder={t('Owner PIN')}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
          <button type="submit" className="btn primary" disabled={busy || !pin}>
            {t('Sign in')}
          </button>
        </form>
      ) : changing ? (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.setPin(pin, current || undefined), t('PIN changed'));
          }}
        >
          {session.via !== 'tailscale' && session.via !== 'localhost' && (
            <>
              <label className="sr-only" htmlFor={`${id}-current`}>
                {t('Current PIN')}
              </label>
              <input
                id={`${id}-current`}
                className="input"
                style={{ maxWidth: '12rem' }}
                type="password"
                autoComplete="current-password"
                placeholder={t('Current PIN')}
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </>
          )}
          <label className="sr-only" htmlFor={`${id}-new`}>
            {t('New PIN')}
          </label>
          <input
            id={`${id}-new`}
            className="input"
            style={{ maxWidth: '12rem' }}
            type="password"
            autoComplete="new-password"
            placeholder={t('New PIN')}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
          <button type="submit" className="btn primary" disabled={busy || pin.length < 4}>
            {t('Change PIN')}
          </button>
          <button type="button" className="btn ghost" onClick={() => setChanging(false)}>
            {t('Cancel')}
          </button>
        </form>
      ) : (
        <div className="row">
          <button type="button" className="btn" onClick={() => setChanging(true)}>
            {t('Change PIN')}
          </button>
          {session.via === 'pin' && (
            <button type="button" className="btn ghost" onClick={() => void run(() => api.logout(), t('Signed out'))}>
              <Icon name="logout" size={16} /> {t('Sign out')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
