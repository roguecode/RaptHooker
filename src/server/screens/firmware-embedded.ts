import sdpro240 from '../../../firmware/screen/bin/sdpro-240.bin';

/** The built server: the screen firmware is inside the server file (tsup.config.ts swaps this in for firmware-files.ts). */
export function loadFirmwareFiles(): Uint8Array[] {
  return [sdpro240];
}
