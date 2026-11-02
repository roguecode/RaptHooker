import type { FoundScreen } from '@rapthooker/shared';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import type { Logger } from '../log.js';
import type { Settings } from '../settings.js';
import type { SystemService } from '../system.js';
import { browseScreens, resolveScreen } from './discovery.js';
import { loadFirmware } from './firmware.js';
import { ScreenManager } from './manager.js';
import { MockUsb, MockWifi, type FakeScreen } from './simulator.js';
import { EsptoolFlasher } from './usb/esptool.js';
import { NoUsb, type UsbFlasher } from './usb/types.js';
import { NetshWifi } from './wifi/netsh.js';
import { NetworkManagerWifi } from './wifi/networkmanager.js';
import { NoWifi, type WifiController } from './wifi/types.js';

export { ScreenError, ScreenManager } from './manager.js';

/**
 * The screens service, with the Wi-Fi control and USB set-up the config and platform allow (or pretend screens and a
 * pretend board in mock mode).
 */
export function createScreens(deps: { config: Config; store: Store; settings: Settings; system: SystemService; log: Logger }): {
  screens: ScreenManager;
  fakes: FakeScreen[];
  usb: UsbFlasher;
} {
  const { config, log } = deps;
  const mode = config.screens.wifi;
  const fakes: FakeScreen[] = [];
  let wifi: WifiController;
  if (mode === 'off') wifi = new NoWifi('off');
  else if (mode === 'mock') wifi = new MockWifi(() => fakes);
  else if (mode === 'networkmanager' || (mode === 'auto' && process.platform === 'linux')) wifi = new NetworkManagerWifi(log);
  else if (mode === 'netsh' || (mode === 'auto' && process.platform === 'win32')) wifi = new NetshWifi(log);
  else wifi = new NoWifi('unsupported-os');

  const usbMode = config.screens.usb;
  const usb: UsbFlasher =
    usbMode === 'off'
      ? new NoUsb('off')
      : usbMode === 'mock'
        ? new MockUsb(
            async (fake) => {
              await fake.start();
              fakes.push(fake);
            },
            { networks: { Brewery: 'hops-and-barley' } },
          )
        : new EsptoolFlasher(config.screens.python, log);

  const mock = mode === 'mock' || usbMode === 'mock';
  const { hubUrl } = config.screens;
  const screens = new ScreenManager({
    store: deps.store,
    settings: deps.settings,
    log,
    wifi,
    usb,
    firmware: loadFirmware(),
    // Set in the config when the hub can't see its own address on the network (in a container, say).
    addresses: hubUrl ? async () => [{ kind: 'lan', url: hubUrl }] : () => deps.system.addresses({ tailscale: false }),
    lookup: mock
      ? async (hostname) => fakes.find((f) => `rh-screen-${f.id.slice(-6)}` === hostname && f.online)?.address ?? null
      : resolveScreen,
    browse: mock
      ? async () =>
          fakes
            .filter((f) => f.online)
            .map((f): FoundScreen => ({
              id: f.id,
              model: f.model,
              firmware: f.firmware,
              api: 1,
              ip: f.address,
              hostname: `rh-screen-${f.id.slice(-6)}`,
              claimed: !!f.settings.token,
            }))
      : () => browseScreens(log),
  });
  return { screens, fakes, usb };
}
