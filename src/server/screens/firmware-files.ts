import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Running from source (the dev server and tests): the images firmware/screen builds into bin/. The build puts
 * firmware-embedded.ts in this module's place, so the hub still only needs its one server file.
 */
export function loadFirmwareFiles(): Uint8Array[] {
  const dir = fileURLToPath(new URL('../../../firmware/screen/bin/', import.meta.url));
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.bin'))
      .map((f) => new Uint8Array(readFileSync(`${dir}${f}`)));
  } catch {
    return [];
  }
}
