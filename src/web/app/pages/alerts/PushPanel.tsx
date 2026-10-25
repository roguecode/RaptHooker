import { useEffect, useState } from 'react';
import { api, errorText } from '../../api';
import { useLive } from '../../live';
import { Icon } from '../../components/Icon';
import { OwnerOnly } from '../../components/ui';
import { t } from '../../i18n';
import { Trans } from '../../i18n/Trans';

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Browser (web push) notifications on this device. */
export function PushPanel() {
  const { isOwner, toast } = useLive();
  const [sub, setSub] = useState<PushSubscription | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && window.isSecureContext;

  useEffect(() => {
    if (!supported) return;
    navigator.serviceWorker.ready.then((reg) => reg.pushManager.getSubscription()).then(setSub, () => setSub(null));
  }, [supported]);

  const enable = async () => {
    setBusy(true);
    try {
      if ((await Notification.requestPermission()) !== 'granted')
        throw new Error(t('Notifications are blocked for this site in your browser settings'));
      const { publicKey } = await api.pushKey();
      const reg = await navigator.serviceWorker.ready;
      const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      await api.pushSubscribe(s.toJSON());
      setSub(s);
      toast({ tone: 'success', title: t('Notifications on'), body: t('This device will get alerts.') });
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't turn on notifications"), body: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (!sub) return;
    setBusy(true);
    try {
      await api.pushUnsubscribe(sub.endpoint).catch(() => undefined);
      await sub.unsubscribe();
      setSub(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>
            <Icon name="bell" /> {t('Notifications on this device')}
          </h2>
          <p>{t('Alerts are pushed to phones and computers where you switch this on, even when the app is closed.')}</p>
        </div>
        {supported && isOwner && (
          <div className="row">
            {sub ? (
              <>
                <button
                  type="button"
                  className="btn small"
                  onClick={() =>
                    api.pushTest().then(
                      () => toast({ tone: 'info', title: t('Test sent') }),
                      (e) => toast({ tone: 'error', title: t('Test failed'), body: errorText(e) }),
                    )
                  }
                >
                  <Icon name="send" size={14} /> {t('Send test')}
                </button>
                <button type="button" className="btn small ghost" disabled={busy} onClick={() => void disable()}>
                  {t('Turn off')}
                </button>
              </>
            ) : (
              <button type="button" className="btn primary" disabled={busy || sub === undefined} onClick={() => void enable()}>
                <Icon name="bell" size={16} /> {t('Turn on')}
              </button>
            )}
          </div>
        )}
      </div>
      {!supported && (
        <div className="notice">
          <Icon name="info" />
          <p className="grow small">
            <Trans
              text={t(
                'Push notifications need the app opened over {https} (for example through Tailscale), and on iPhone it must be added to the Home Screen first. Alerts still show here while the app is open, and the services under "Where alerts go" work without it.',
              )}
              values={{ https: <strong>HTTPS</strong> }}
            />
          </p>
        </div>
      )}
      {supported && !isOwner && <OwnerOnly isOwner={false}>{null}</OwnerOnly>}
    </section>
  );
}
