// @vitest-environment happy-dom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { UpdateInfo } from '@rapthooker/shared';
import { renderWithHub, toastTexts } from '../../test/render';
import { UpdateSection } from './UpdateSection';

const HOUR = 3_600_000;

const info = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({
  current: '0.2.1',
  latest: '0.2.1',
  available: false,
  notes: null,
  url: null,
  checkedAt: Date.now(),
  error: null,
  canSelfUpdate: false,
  devBuild: null,
  canSwitchToRelease: false,
  state: 'idle',
  ...over,
});

const dev = { commit: 'abc1234', changes: true, builtAt: Date.now() - 3 * HOUR };

describe('Settings: Updates', () => {
  it('says the hub runs a development build, and switches it to the latest release', async () => {
    const view = await renderWithHub(<UpdateSection />, {
      routes: {
        'GET /api/update': info({ devBuild: dev, canSwitchToRelease: true }),
        'POST /api/update/switch': info({ devBuild: dev, canSwitchToRelease: true, state: 'updating' }),
      },
    });
    await screen.findByText('This hub runs a development build.');
    expect(screen.getByText('Development build')).toBeTruthy();
    expect(screen.getByText(/^Commit abc1234 with uncommitted changes, built .+ ago$/)).toBeTruthy();
    expect(screen.queryByText(/wasn't set up with the one-line installer/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Switch to release 0.2.1' }));
    const dialog = screen.getByRole('dialog', { name: 'Switch to RaptHooker 0.2.1?' });
    expect(dialog.textContent).toContain('goes back to this build by itself');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Switch to the release' }));

    await waitFor(() => expect(screen.getByText('Updating…')).toBeTruthy());
    expect(view.calls('POST /api/update/switch')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Switch to release/ })).toBeNull();
  });

  it('says why when switching fails', async () => {
    await renderWithHub(<UpdateSection />, {
      routes: {
        'GET /api/update': info({ devBuild: dev, canSwitchToRelease: true }),
        'POST /api/update/switch': new Response(JSON.stringify({ error: 'No release has been published yet.' }), { status: 409 }),
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Switch to release 0.2.1' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Switch to the release' }));
    await waitFor(() => expect(toastTexts()).toContain("Couldn't switch to the release: No release has been published yet."));
  });

  it('checks for releases on a development build without calling it the latest version', async () => {
    const view = await renderWithHub(<UpdateSection />, {
      routes: {
        'GET /api/update': info({ latest: null, checkedAt: null, devBuild: dev, canSwitchToRelease: true }),
        'POST /api/update/check': info({ latest: '0.3.0', devBuild: dev, canSwitchToRelease: true }),
      },
    });
    await screen.findByText('This hub runs a development build.');
    expect(screen.queryByRole('button', { name: /Switch to release/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await screen.findByRole('button', { name: 'Switch to release 0.3.0' });
    expect(view.calls('POST /api/update/check')).toHaveLength(1);
    expect(toastTexts()).not.toContain("You're on the latest version");
  });

  it("points a development build that can't switch by itself to the installer", async () => {
    await renderWithHub(<UpdateSection />, {
      routes: { 'GET /api/update': info({ devBuild: { commit: null, changes: false, builtAt: null } }) },
    });
    await screen.findByText('This hub runs a development build.');
    expect(screen.queryByRole('button', { name: /Switch to release/ })).toBeNull();
    expect(screen.getByText(/To go back to releases, run the one-line installer on the hub\./)).toBeTruthy();
    expect(screen.queryByText('Build')).toBeNull();
  });

  it('shows a release as before', async () => {
    await renderWithHub(<UpdateSection />, {
      routes: { 'GET /api/update': info({ latest: '0.3.0', available: true, canSelfUpdate: true }) },
    });
    await screen.findByText('Update available');
    expect(screen.queryByText('Development build')).toBeNull();
    expect(screen.queryByText('This hub runs a development build.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Update now' })).toBeTruthy();
  });
});
