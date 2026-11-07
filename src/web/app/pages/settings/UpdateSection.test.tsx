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
  target: null,
  prerelease: false,
  canInstall: false,
  betas: [],
  betasCheckedAt: null,
  betasError: null,
  newerBeta: null,
  ...over,
});

const dev = { commit: 'abc1234', changes: true, builtAt: Date.now() - 3 * HOUR };

const BETA = {
  version: '0.3.0-beta.1',
  name: 'RaptHooker 0.3.0-beta.1',
  notes: '- Tilt support to try',
  url: 'https://github.com/roguecode/RaptHooker/releases/tag/v0.3.0-beta.1',
  publishedAt: Date.now() - 2 * HOUR,
};

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

  it('looks for betas when asked, and installs the one picked', async () => {
    const view = await renderWithHub(<UpdateSection />, {
      routes: {
        'GET /api/update': info({ canSelfUpdate: true, canInstall: true }),
        'POST /api/update/betas': info({ canSelfUpdate: true, canInstall: true, betas: [BETA], betasCheckedAt: Date.now() }),
        'POST /api/update/install': info({ canSelfUpdate: true, canInstall: true, state: 'updating', target: '0.3.0-beta.1' }),
      },
    });
    await screen.findByText('Beta versions');
    expect(screen.queryByText('This hub runs a beta.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Look for betas' }));
    await screen.findByText('RaptHooker 0.3.0-beta.1');
    expect(view.calls('POST /api/update/betas')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Try this beta' }));
    const dialog = screen.getByRole('dialog', { name: 'Try RaptHooker 0.3.0-beta.1?' });
    expect(dialog.textContent).toContain('you can go back to the latest release');
    expect(dialog.textContent).toContain('goes back to 0.2.1 by itself');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Install the beta' }));

    await waitFor(() => expect(screen.getByText('Updating…')).toBeTruthy());
    expect(view.calls('POST /api/update/install').map((c) => c.body)).toEqual([{ version: '0.3.0-beta.1' }]);
  });

  it('says when there are no betas, and why it couldn’t look', async () => {
    await renderWithHub(<UpdateSection />, {
      routes: {
        'GET /api/update': info({ canInstall: true }),
        'POST /api/update/betas': info({
          canInstall: true,
          betasCheckedAt: Date.now(),
          betasError: "Couldn't reach GitHub. Is the hub online? Try again later.",
        }),
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Look for betas' }));
    await screen.findByText('There are no betas to try right now.');
    await waitFor(() =>
      expect(toastTexts()).toContain("Couldn't look for betas: Couldn't reach GitHub. Is the hub online? Try again later."),
    );
    expect(screen.getByRole('button', { name: 'Look again' })).toBeTruthy();
  });

  it('on a beta, says so, points out a newer one, and goes back to the latest release', async () => {
    const onBeta = {
      current: '0.3.0-beta.1',
      latest: '0.2.1',
      prerelease: true,
      canSelfUpdate: true,
      canInstall: true,
      betas: [{ ...BETA, version: '0.3.0-beta.2' }, BETA],
      betasCheckedAt: Date.now(),
      newerBeta: '0.3.0-beta.2',
    };
    const view = await renderWithHub(<UpdateSection />, {
      routes: {
        'GET /api/update': info(onBeta),
        'POST /api/update/install': info({ ...onBeta, state: 'updating', target: '0.2.1' }),
      },
    });
    await screen.findByText('This hub runs a beta.');
    expect(screen.getByText('Beta')).toBeTruthy();
    expect(screen.getByText(/A newer beta of it is out: 0\.3\.0-beta\.2\./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Update now' })).toBeNull();
    // Its own notes come from the beta's release, and it can't be installed over itself.
    expect(screen.getByText("What's in 0.3.0-beta.1 (this version)")).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Try this beta' })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Go back to release 0.2.1' }));
    const dialog = screen.getByRole('dialog', { name: 'Go back to RaptHooker 0.2.1?' });
    expect(dialog.textContent).toContain('Everything recorded on the beta stays.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Go back to the release' }));

    await waitFor(() => expect(screen.getByText('Updating…')).toBeTruthy());
    expect(view.calls('POST /api/update/install').map((c) => c.body)).toEqual([{ version: '0.2.1' }]);
  });

  it('lets a development build with the same version number install the beta', async () => {
    await renderWithHub(<UpdateSection />, {
      routes: {
        'GET /api/update': info({
          current: '0.3.0-beta.1',
          devBuild: dev,
          canSwitchToRelease: true,
          canInstall: true,
          betas: [BETA],
          betasCheckedAt: Date.now(),
        }),
      },
    });
    await screen.findByText('RaptHooker 0.3.0-beta.1', { selector: 'strong' });
    expect(screen.queryByText('This hub', { selector: '.chip' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Try this beta' })).toBeTruthy();
  });

  it("doesn't offer betas on a hub that can't install them", async () => {
    await renderWithHub(<UpdateSection />, { routes: { 'GET /api/update': info() } });
    await screen.findByText('Updates');
    expect(screen.queryByText('Beta versions')).toBeNull();
  });
});
