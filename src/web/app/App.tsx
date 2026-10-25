import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { LiveProvider, useLive, type Connection } from './live';
import { UnitsProvider, UnitToggles } from './units';
import { useRoute, type Route } from './router';
import { dateTime, timeAgo, useNow } from './format';
import { Icon, type IconName } from './components/Icon';
import { Dashboard } from './pages/Dashboard';
import { PillPage } from './pages/pill';
import { BrewPage, BrewsPage, BrewSummaryPage } from './pages/brews';
import { WebhookEditor, WebhooksPage } from './pages/webhooks';
import { AlertsPage } from './pages/alerts';
import { SettingsPage } from './pages/settings';
import { PinNotice } from './pages/settings/OwnerSection';
import { Kiosk } from './pages/kiosk/Kiosk';
import { DevBuildBadge, UpdateBanner } from './components/UpdateBanner';
import { WhatsNew } from './components/WhatsNew';
import { DisplayMenu } from './components/DisplayMenu';
import { HubWarnings } from './components/HubWarnings';
import { I18nProvider, t, tk } from './i18n';
import { Trans } from './i18n/Trans';

export function App() {
  // Units follow the hub's defaults, so they sit inside the live state. A change of language re-renders everything
  // inside I18nProvider, so it sits inside LiveProvider: the live connection stays open.
  return (
    <LiveProvider>
      <I18nProvider>
        <UnitsProvider>
          <Shell />
        </UnitsProvider>
      </I18nProvider>
    </LiveProvider>
  );
}

const NAV: { id: string; href: string; label: string; icon: IconName; match: Route['name'][] }[] = [
  { id: 'dashboard', href: '#/', label: tk('Pills'), icon: 'gauge', match: ['dashboard', 'pill'] },
  { id: 'brews', href: '#/brews', label: tk('Brews'), icon: 'beer', match: ['brews', 'brew', 'brew-summary'] },
  { id: 'webhooks', href: '#/webhooks', label: tk('Webhooks'), icon: 'webhook', match: ['webhooks', 'webhook'] },
  { id: 'alerts', href: '#/alerts', label: tk('Alerts'), icon: 'bell', match: ['alerts'] },
  { id: 'settings', href: '#/settings', label: tk('Settings'), icon: 'sliders', match: ['settings'] },
];

/** Browser tab titles; the dashboard is just the hub's name. */
const TITLES: Partial<Record<Route['name'], string>> = {
  brews: tk('Brews'),
  // i18n: a single brew (noun)
  brew: tk('Brew'),
  'brew-summary': tk('Brew summary'),
  webhooks: tk('Webhooks'),
  webhook: tk('Webhook'),
  alerts: tk('Alerts'),
  settings: tk('Settings'),
  kiosk: tk('TV mode'),
};

/** True once the connection has dropped, until it's back (so a reconnect attempt doesn't make notices flicker). */
function useOffline(connection: Connection): boolean {
  const [down, setDown] = useState(false);
  useEffect(() => {
    if (connection === 'closed') setDown(true);
    else if (connection === 'open') setDown(false);
  }, [connection]);
  return down;
}

function OfflineNotice({ cachedAt }: { cachedAt: number | null }) {
  const now = useNow(30_000);
  return (
    <div className="notice warning" role="status">
      <Icon name="wifiOff" />
      <p className="grow">
        {cachedAt ? (
          <>
            <Trans
              text={t('{offline} ({ago}), saved in this browser.', { ago: timeAgo(cachedAt, now) })}
              values={{ offline: <strong>{t('Offline: showing data from {date}', { date: dateTime(cachedAt) })}</strong> }}
            />{' '}
          </>
        ) : (
          <>{t("Can't reach the hub right now.")} </>
        )}
        {t('Recording carries on at the hub; this page reconnects by itself.')}
      </p>
    </div>
  );
}

function Shell() {
  const route = useRoute();
  const { connection, toasts, dismiss, session, hub, pills, cachedAt } = useLive();
  const key = 'id' in route ? `${route.name}:${route.id}` : route.name;
  const offline = useOffline(connection);
  const main = useRef<HTMLElement | null>(null);

  const pillName = route.name === 'pill' ? pills.find((p) => p.id === route.id)?.name : undefined;
  const title = TITLES[route.name];
  const page = pillName ?? (title && t(title));
  useEffect(() => {
    document.title = page ? `${page} · ${hub.name}` : hub.name;
  }, [page, hub.name]);

  // After moving to another page, start keyboard and screen reader users at its content.
  const firstRoute = useRef(true);
  useEffect(() => {
    if (firstRoute.current) {
      firstRoute.current = false;
      return;
    }
    main.current?.focus({ preventScroll: true });
  }, [key]);

  // In <body> like dialogs (components/ui.tsx), so a message about a dialog's action shows above its backdrop.
  const toastList = createPortal(
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <button key={toast.id} type="button" className={`toast ${toast.tone}`} title={t('Dismiss')} onClick={() => dismiss(toast.id)}>
          <Icon name={toast.tone === 'success' ? 'check' : toast.tone === 'info' ? 'info' : 'alert'} />
          <span>
            <strong>{toast.title}</strong>
            {toast.body && <span>{toast.body}</span>}
          </span>
        </button>
      ))}
    </div>,
    document.body,
  );

  if (route.name === 'kiosk') {
    return (
      <>
        <ErrorBoundary key={key}>
          <Kiosk offline={offline} />
        </ErrorBoundary>
        {toastList}
      </>
    );
  }

  return (
    <div className="app">
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          main.current?.focus();
        }}
      >
        {t('Skip to content')}
      </a>
      <div className="ambient" aria-hidden="true" />
      <header className="topbar">
        <a className="brand" href="#/" aria-label={t('{name}: home', { name: hub.name })}>
          <img src="/icons/icon.svg" alt="" />
          <span className="brand-name">{hub.name}</span>
        </a>
        {/* i18n: "Main" names the main navigation for screen readers */}
        <nav className="nav" aria-label={t('Main')}>
          {NAV.map((n) => {
            const active = n.match.includes(route.name);
            return (
              <a key={n.id} href={n.href} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}>
                <Icon name={n.icon} size={19} />
                <span>{t(n.label)}</span>
              </a>
            );
          })}
        </nav>
        <div className="topbar-end">
          <DevBuildBadge />
          <div className="hide-mobile">
            <UnitToggles />
          </div>
          <DisplayMenu />
          <span
            className={`live-dot ${connection}`}
            title={
              connection === 'open'
                ? t('Live updates: open')
                : connection === 'connecting'
                  ? t('Live updates: connecting')
                  : t('Live updates: closed')
            }
          >
            <span className="dot" aria-hidden="true" />
            <span className="label">
              {connection === 'open' ? t('Live') : connection === 'connecting' ? t('Connecting') : t('Offline')}
            </span>
          </span>
        </div>
      </header>
      <HubWarnings />

      <main id="main" ref={main} tabIndex={-1}>
        <UpdateBanner />
        <WhatsNew />
        {offline && <OfflineNotice cachedAt={cachedAt} />}
        {session && !session.pinSet && route.name !== 'settings' && route.name !== 'dashboard' && <PinNotice />}
        <ErrorBoundary key={key}>
          {route.name === 'dashboard' && <Dashboard />}
          {route.name === 'pill' && <PillPage id={route.id} />}
          {route.name === 'brews' && <BrewsPage />}
          {route.name === 'brew' && <BrewPage id={route.id} />}
          {route.name === 'brew-summary' && <BrewSummaryPage id={route.id} />}
          {route.name === 'webhooks' && <WebhooksPage />}
          {route.name === 'webhook' && <WebhookEditor id={route.id} />}
          {route.name === 'alerts' && <AlertsPage />}
          {route.name === 'settings' && <SettingsPage />}
        </ErrorBoundary>
      </main>

      {toastList}
    </div>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="panel empty">
          <h2>{t('Something went wrong on this page')}</h2>
          <p className="muted">{this.state.error.message}</p>
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            <Icon name="refresh" /> {t('Reload')}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
