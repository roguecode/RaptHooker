import esp32Boot from '../../../firmware/screen/bin/esp32-2432s028.boot.bin';
import esp32 from '../../../firmware/screen/bin/esp32-2432s028.bin';
import sdpro240 from '../../../firmware/screen/bin/sdpro-240.bin';
import type { FirmwareFile } from './firmware-files.js';

/** The built server: the screen firmware is inside the server file (tsup.config.ts swaps this in for firmware-files.ts). */
export function loadFirmwareFiles(): FirmwareFile[] {
  return [
    { name: 'sdpro-240.bin', data: sdpro240 },
    { name: 'esp32-2432s028.bin', data: esp32 },
    { name: 'esp32-2432s028.boot.bin', data: esp32Boot },
  ];
}
