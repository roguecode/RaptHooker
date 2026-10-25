import { describe, expect, it } from 'vitest';
import { servesApp } from './swRoutes';

describe('service worker page loads', () => {
  it('answers the app itself', () => {
    expect(servesApp('/')).toBe(true);
    expect(servesApp('/?source=pwa')).toBe(true);
    expect(servesApp('/kiosk')).toBe(true);
    expect(servesApp('/apiary')).toBe(true);
    expect(servesApp('/v1.2/page')).toBe(true);
  });

  it('leaves the API and files to the hub', () => {
    expect(servesApp('/api')).toBe(false);
    expect(servesApp('/api/pills/p1/export.csv')).toBe(false);
    expect(servesApp('/api?x=1')).toBe(false);
    expect(servesApp('/LICENSE-lucide.txt')).toBe(false);
    expect(servesApp('/LICENSE-lucide.txt?download=1')).toBe(false);
    expect(servesApp('/icons/icon.SVG')).toBe(false);
  });
});
