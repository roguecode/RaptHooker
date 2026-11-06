import { APPLE_COMPANY_ID, decodeRapt, isThermometerBeacon, type RaptAdvert } from './rapt.js';
import { decodeTilt, isTiltBeacon, type TiltAdvert } from './tilt.js';

/** What an advert says, from any kind of Bluetooth device the hub knows. */
export type DeviceAdvert = RaptAdvert | TiltAdvert;

export function decodeAdvert(companyId: number, data: Uint8Array): DeviceAdvert | null {
  return decodeRapt(companyId, data) ?? decodeTilt(companyId, data);
}

/** Whether manufacturer data under Apple's company id is an iBeacon of a device the hub knows (most aren't). */
export const isKnownBeacon = (data: Uint8Array | undefined): boolean => isThermometerBeacon(data) || isTiltBeacon(data);

export { APPLE_COMPANY_ID };
