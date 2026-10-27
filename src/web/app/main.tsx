import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './palettes.css';
import { App } from './App';
import { startTheme } from './theme';
import { initI18n } from './i18n';

startTheme();

// The language loads first, so the page doesn't flash English before it's translated.
const render = () =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
initI18n().then(render, (err: unknown) => {
  console.warn('translations', err);
  render();
});

// The service worker (offline shell + push notifications) only works over HTTPS or on localhost.
if ('serviceWorker' in navigator && window.isSecureContext && import.meta.env.PROD) {
  // After an update the new worker takes over straight away; reload once so the page runs the new version too.
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(
      (reg) => {
        const check = () => void reg.update().catch(() => undefined);
        window.setInterval(check, 30 * 60_000);
        document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
      },
      (err: unknown) => console.warn('service worker', err),
    );
  });
}
