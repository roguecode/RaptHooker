import type {
  IspindelHotspot,
  IspindelInfo,
  IspindelSetupError,
  IspindelSetupInput,
  IspindelSetupProgress,
  IspindelSetupStep,
} from '@rapthooker/shared';
import { http } from '../../api';
import { tk } from '../../i18n';

export const ispindelApi = {
  info: () => http.get<IspindelInfo>('/api/ispindel'),
  /** Looks for iSpindels in setup mode now (and keeps looking for a while). */
  scan: () => http.post<{ hotspots: IspindelHotspot[]; scannedAt: number }>('/api/ispindel/scan'),
  setup: (input: IspindelSetupInput) => http.post<IspindelSetupProgress>('/api/ispindel/setup', input),
  /** This page has shown how a set-up ended: the hub needn't offer it again. */
  forget: (id: string) => http.del(`/api/ispindel/setup/${encodeURIComponent(id)}`),
};

/** Words for setting an iSpindel up, marked with tk: show them with t(). */

export const ISPINDEL_STEP_LABELS: Record<IspindelSetupStep, string> = {
  hotspot: tk("Joining the iSpindel's Wi-Fi"),
  read: tk('Reading its settings'),
  configure: tk('Saving the settings for this hub'),
  back: tk("Back on the hub's network"),
  reading: tk('Waiting for its first reading'),
  done: tk('Done'),
};

export const ISPINDEL_SETUP_ERRORS: Record<IspindelSetupError, string> = {
  'no-wifi-control': tk("The hub can't switch Wi-Fi networks. Set the iSpindel up by hand instead."),
  busy: tk("The hub's Wi-Fi is busy setting something else up. Wait for it to finish."),
  'no-password': tk("Enter the Wi-Fi password: the hub doesn't know it."),
  'no-address': tk("The hub doesn't know its own address on your network. Set the iSpindel up by hand instead."),
  'hotspot-failed': tk(
    "The hub couldn't reach the iSpindel's Wi-Fi. It only stays in setup mode for a few minutes: press its reset button again, then check again.",
  ),
  'not-ispindel': tk("That hotspot's setup page isn't an iSpindel's."),
  'save-failed': tk("The iSpindel didn't take the settings. Put it in setup mode again and try again."),
};

/** How often an iSpindel can send, with a word on its battery. */
export const ISPINDEL_INTERVAL_LABELS: Record<number, string> = {
  300: tk('Every 5 minutes (battery lasts weeks)'),
  600: tk('Every 10 minutes'),
  900: tk('Every 15 minutes (recommended)'),
  1800: tk('Every 30 minutes'),
  3600: tk('Every hour (battery lasts months)'),
};
