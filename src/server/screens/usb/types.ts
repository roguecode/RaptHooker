import type { UsbBoardId, UsbPort, UsbStatus } from '@rapthooker/shared';

/** Bytes to write at a place in a board's flash. */
export interface FlashRegion {
  at: number;
  data: Uint8Array;
  /** For the log. */
  name: string;
}

/** What esptool says about the board on a port. */
export interface UsbBoard {
  /** esptool's chip family: 'esp32', 'esp32s3', 'esp8266', ... */
  chip: string;
  /** What it says the chip is: "ESP32-D0WD-V3 (revision v3.1)". */
  description: string;
  /** Its MAC address, lower case with colons (the Wi-Fi station's, which RaptHooker's firmware goes by). */
  mac: string;
  /** Flash size in MB, if it said. */
  flashMb: number | null;
}

export type UsbErrorCode = 'busy' | 'denied' | 'no-board' | 'failed';

export class UsbError extends Error {
  constructor(
    readonly code: UsbErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Puts firmware on boards plugged into the hub's USB (esptool.ts), or pretends to (MockUsb in simulator.ts). One
 * board at a time: the set-up job never overlaps calls.
 */
export interface UsbFlasher {
  readonly name: string;
  status(): Promise<UsbStatus>;
  ports(): Promise<UsbPort[]>;
  /** Asks the board what it is (it restarts afterwards). */
  identify(port: string): Promise<UsbBoard>;
  /** Writes the regions and checks them; leaves the board in its boot loader for `watch` to restart. */
  write(port: string, regions: FlashRegion[], onProgress: (percent: number) => void): Promise<void>;
  /**
   * Restarts the board and passes each line it prints to `onLine` until that returns true or `ms` runs out. False if
   * the hub couldn't read the port: set-up then goes by the network alone.
   */
  watch(port: string, ms: number, onLine: (line: string) => boolean): Promise<boolean>;
  /**
   * Asks the boards on these ports which screen they are, without restarting them (RaptHooker firmware 1.1.1 and
   * later answers "?RHSCREEN"). Ports that don't answer are left out.
   */
  whois(ports: string[]): Promise<Map<string, UsbBoardId>>;
}

/** A hub that doesn't set boards up over USB (switched off in the config). */
export class NoUsb implements UsbFlasher {
  readonly name = 'none';
  constructor(private readonly reason: string) {}
  async status(): Promise<UsbStatus> {
    return { canSetUp: false, reason: this.reason, esptool: null, ports: [] };
  }
  async ports(): Promise<UsbPort[]> {
    return [];
  }
  async identify(): Promise<UsbBoard> {
    throw new UsbError('failed', "This hub doesn't set screens up over USB");
  }
  async write(): Promise<void> {
    throw new UsbError('failed', "This hub doesn't set screens up over USB");
  }
  async watch(): Promise<boolean> {
    return false;
  }
  async whois(): Promise<Map<string, UsbBoardId>> {
    return new Map();
  }
}
