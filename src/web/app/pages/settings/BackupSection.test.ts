// @vitest-environment happy-dom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BACKUP_SETTINGS, type BackupOverview, type BackupSettings } from '@rapthooker/shared';

const live = vi.hoisted(() => ({ isOwner: true, toast: vi.fn() }));
vi.mock('../../live', () => ({ useLive: () => live }));

import { BackupSection } from './BackupSection';

const overview: BackupOverview = {
  dir: '/var/lib/rapthooker/backups',
  time: '03:15',
  keep: 7,
  files: [
    { name: 'rapthooker-2026-10-24.db', bytes: 2_000_000, at: Date.UTC(2026, 9, 24, 3, 15), kind: 'daily' },
    { name: 'pre-restore-2026-10-20T10-00-00.db', bytes: 1_000_000, at: Date.UTC(2026, 9, 20, 10), kind: 'pre-restore' },
  ],
  targets: [
    { target: 'local', at: Date.now() - 3_600_000, ok: true, error: null, file: '/var/lib/rapthooker/backups/rapthooker-2026-10-24.db' },
    { target: 'usb', at: null, ok: null, error: null, file: null, note: 'No USB stick plugged in' },
    { target: 's3', at: null, ok: false, error: "There's no bucket with that name at this address (NoSuchBucket)", file: null },
  ],
  usbPresent: false,
  csv: { at: null, folder: null, error: null },
  lastRestore: null,
  running: false,
};

const settings: BackupSettings = {
  ...DEFAULT_BACKUP_SETTINGS,
  usb: true,
  s3: { ...DEFAULT_BACKUP_SETTINGS.s3, enabled: true, bucket: 'brew-backups', accessKeyId: 'AKID', secretAccessKey: '••••••' },
};

beforeEach(() => {
  live.isOwner = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body =
        url === '/api/backups' ? overview : url === '/api/settings/backups' ? settings : { backups: overview.targets.slice(0, 1) };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('BackupSection', () => {
  it('shows each place, the saved backups and the settings to the owner', async () => {
    render(createElement(BackupSection));
    await screen.findByText('Saved on the hub');
    expect(screen.getByText('On the hub')).toBeTruthy();
    expect(screen.getByText('Not plugged in')).toBeTruthy();
    expect(screen.getByText(/NoSuchBucket/)).toBeTruthy();
    expect(screen.getByText('From before a restore')).toBeTruthy();
    const downloads = screen.getAllByText('Download').map((el) => el.closest('a')!.getAttribute('href'));
    expect(downloads).toContain('/api/backups/download?file=rapthooker-2026-10-24.db');
    expect(screen.getByText('Download a copy now').closest('a')!.getAttribute('href')).toBe('/api/backups/now.db');
    await screen.findByText('Copy to a USB stick');
    expect((screen.getByDisplayValue('brew-backups') as HTMLInputElement).value).toBe('brew-backups');
    expect(screen.getByText('Weekly CSV export')).toBeTruthy();
  });

  it('asks for a clear yes before restoring', async () => {
    render(createElement(BackupSection));
    fireEvent.click(await screen.findByText('Restore…'));
    expect(screen.getByText('This replaces everything on the hub with the backup.')).toBeTruthy();
    const go = screen.getByText('Replace and restart').closest('button')!;
    expect(go.disabled).toBe(true);
    fireEvent.click(screen.getByText('A backup on the hub'));
    fireEvent.click(screen.getByText("I understand the hub's current data will be replaced"));
    await waitFor(() => expect(go.disabled).toBe(false));
  });

  it('shows viewers the status only', async () => {
    live.isOwner = false;
    render(createElement(BackupSection));
    await screen.findByText('On the hub');
    expect(screen.queryByText('Back up now')).toBeNull();
    expect(screen.queryByText('Copy to a USB stick')).toBeNull();
  });
});
