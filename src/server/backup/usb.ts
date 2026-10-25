import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Where deploy/pi/setup.d/30-usb-backups.sh has systemd automount a stick labelled RAPTHOOKER. */
export const USB_DIR = '/mnt/rapthooker';
export const USB_LABEL = 'RAPTHOOKER';

/** Whether a stick is mounted (and so writable) at a folder. Injectable so tests can fake a stick. */
export type UsbCheck = (dir: string) => Promise<boolean>;

const unescapeMount = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));

/** True when a real filesystem (not just systemd's automount placeholder) is mounted at dir. */
async function realMount(dir: string): Promise<boolean> {
  let mounts: string;
  try {
    mounts = await readFile('/proc/mounts', 'utf8');
  } catch {
    // No /proc: a mount point lives on a different device from its parent folder.
    try {
      const [a, b] = await Promise.all([stat(dir), stat(dirname(dir))]);
      return a.dev !== b.dev;
    } catch {
      return false;
    }
  }
  return mounts.split('\n').some((line) => {
    const [, point, type] = line.split(' ');
    return point !== undefined && unescapeMount(point) === dir && type !== 'autofs';
  });
}

/**
 * Whether the RAPTHOOKER stick is plugged in and mounted at dir. With systemd's automount the stick is only mounted
 * while it's being used, so when the labelled device is present, looking inside the folder mounts it. Without the
 * device nothing is touched (that would make systemd wait for a stick that isn't there).
 */
export const usbMounted: UsbCheck = async (dir) => {
  if (process.platform !== 'linux') return false;
  if (await realMount(dir)) return true;
  if (!existsSync(`/dev/disk/by-label/${USB_LABEL}`)) return false;
  try {
    await readdir(dir);
  } catch {
    return false;
  }
  return realMount(dir);
};

/** A plain-English reason a copy to the stick failed. */
export function usbErrorText(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return "RaptHooker isn't allowed to write to the USB stick. Format it as FAT32 or exFAT (see the backups guide).";
    case 'EROFS':
      return 'The USB stick is read-only (check its lock switch, or it may be failing).';
    case 'ENOSPC':
      return 'The USB stick is full.';
    case 'EIO':
      return 'The USB stick had a read/write error: it may have been pulled out or be failing.';
    default:
      return `Copying to the USB stick failed: ${(err as Error).message}`;
  }
}
