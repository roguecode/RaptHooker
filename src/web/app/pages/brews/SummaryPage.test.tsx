// @vitest-environment happy-dom
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_HUB_SETTINGS } from '@rapthooker/shared';
import { makeBle, makeBrew, makePill, renderWithHub } from '../../test/render';
import { BrewSummaryPage } from './SummaryPage';

const pill = makePill();
const brew = makeBrew({ name: 'Hazy IPA #4' });

describe('BrewSummaryPage', () => {
  it("tries again when the hub is back, rather than saying the brew doesn't exist", async () => {
    let up = false;
    const view = await renderWithHub(<BrewSummaryPage id="brew-1" />, {
      pills: [pill],
      routes: {
        'GET /api/brews/*': () => (up ? brew : new Response('{"error":"The hub is restarting"}', { status: 503 })),
        'GET /api/brews/compare': [],
      },
    });
    await screen.findByRole('heading', { name: 'The hub is restarting' });
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByText('Brew not found')).toBeNull();

    up = true;
    await view.push({ type: 'hello', pills: [pill], nearby: [], ble: makeBle(), clockSynced: true, hub: DEFAULT_HUB_SETTINGS });
    await screen.findByRole('heading', { name: 'Hazy IPA #4' });
  });

  it("says when the brew doesn't exist", async () => {
    await renderWithHub(<BrewSummaryPage id="brew-9" />, {
      routes: {
        'GET /api/brews/*': () => new Response('{"error":"Unknown brew"}', { status: 404 }),
        'GET /api/brews/compare': [],
      },
    });
    await screen.findByRole('heading', { name: 'Brew not found' });
  });
});
