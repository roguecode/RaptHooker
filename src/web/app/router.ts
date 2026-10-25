import { useEffect, useState } from 'react';

export type Route =
  | { name: 'dashboard' }
  | { name: 'pill'; id: string }
  | { name: 'brews' }
  | { name: 'brew'; id: string }
  | { name: 'brew-summary'; id: string }
  | { name: 'webhooks' }
  | { name: 'webhook'; id: string | null }
  | { name: 'alerts' }
  | { name: 'settings' }
  | { name: 'kiosk' };

function parse(): Route {
  const path = (window.location.hash || '#/').slice(1).split('?')[0]!;
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  switch (parts[0]) {
    case 'pill':
      return parts[1] ? { name: 'pill', id: parts[1] } : { name: 'dashboard' };
    case 'brews':
      return { name: 'brews' };
    case 'brew':
      if (parts[1] && parts[2] === 'summary') return { name: 'brew-summary', id: parts[1] };
      return parts[1] ? { name: 'brew', id: parts[1] } : { name: 'brews' };
    case 'webhooks':
      return parts[1] ? { name: 'webhook', id: parts[1] === 'new' ? null : parts[1] } : { name: 'webhooks' };
    case 'alerts':
      return { name: 'alerts' };
    case 'settings':
      return { name: 'settings' };
    case 'kiosk':
    case 'tv':
      return { name: 'kiosk' };
    default:
      return { name: 'dashboard' };
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => {
      setRoute(parse());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const navigate = (hash: string) => {
  window.location.hash = hash;
};

export const href = {
  pill: (id: string) => `#/pill/${encodeURIComponent(id)}`,
  brew: (id: string) => `#/brew/${encodeURIComponent(id)}`,
  brewSummary: (id: string) => `#/brew/${encodeURIComponent(id)}/summary`,
  webhook: (id: string | null) => `#/webhooks/${id ? encodeURIComponent(id) : 'new'}`,
};
