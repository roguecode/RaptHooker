import type { ScreenSetupError, ScreenSetupStep, ScreenState } from '@rapthooker/shared';
import { tk } from '../../i18n';

/** Words for the screens pages, marked with tk: show them with t(). */

export const STEP_LABELS: Record<ScreenSetupStep, string> = {
  hotspot: tk("Joining the screen's Wi-Fi"),
  identify: tk('Checking the screen'),
  install: tk('Installing RaptHooker firmware'),
  restart: tk('Waiting for the screen to restart'),
  screen: tk('Talking to the screen'),
  wifi: tk('Connecting the screen to your Wi-Fi'),
  back: tk("Back on the hub's network"),
  find: tk('Finding the screen on your network'),
  done: tk('Done'),
};

export const SETUP_ERRORS: Record<ScreenSetupError, string> = {
  busy: tk('Another screen is being set up. Wait for it to finish.'),
  'no-wifi-control': tk("The hub can't switch Wi-Fi networks."),
  'hotspot-failed': tk("The hub couldn't join the screen's Wi-Fi. Check the screen is on and near the hub, then scan again."),
  'not-supported': tk("This isn't a screen RaptHooker can set up."),
  'install-failed': tk("The firmware didn't install, so the screen still has its own. Unplug it, plug it back in and try again."),
  'no-restart': tk(
    "The screen didn't come back after installing. Give it a minute: if it shows the RaptHooker logo, scan again; if it stays blank, unplug it and plug it back in.",
  ),
  'on-network': tk(
    'RaptHooker is on the screen now, and it joined your network by itself with a set-up from before. Add it from Found on your network.',
  ),
  'screen-unreachable': tk("The hub couldn't talk to the screen on its Wi-Fi."),
  'wrong-password': tk("The screen couldn't join: the Wi-Fi password is wrong."),
  'network-not-found': tk("The screen can't see that network. Screens only use 2.4 GHz Wi-Fi: check the name, and that it's in range."),
  'no-address': tk('The screen joined the network but the router gave it no IP address.'),
  'wifi-failed': tk("The screen couldn't join the network."),
  'not-found': tk("The screen is on your network, but the hub can't find it there yet. It may turn up under Found on your network."),
  'no-password': tk("Enter the Wi-Fi password: the hub doesn't know it."),
  'no-usb': tk("The hub can't put firmware on boards over USB."),
  'usb-failed': tk(
    "The hub couldn't talk to the board. Unplug it and plug it back in, then try again. If it still won't, hold its BOOT button while the hub starts.",
  ),
  'usb-busy': tk('Something else on the hub is using the board (a serial monitor, say). Close it and try again.'),
  'wrong-board': tk("That board isn't one RaptHooker has firmware for."),
  failed: tk('Something went wrong.'),
};

/** Why the hub can't set boards up over USB (UsbStatus.reason, or the detail of a 'no-usb' set-up error). */
export const USB_REASONS: Record<string, string> = {
  off: tk("USB set-up is switched off in the hub's config."),
  'no-python': tk(
    'The hub needs Python and esptool to put firmware on boards. Run the Pi set-up again, or install them (pip install esptool).',
  ),
  'no-esptool': tk('The hub needs esptool to put firmware on boards. Run the Pi set-up again, or install it (pip install esptool).'),
  'no-pyserial': tk('The hub needs pyserial to talk to boards. Run the Pi set-up again, or install it (pip install pyserial).'),
  'not-allowed': tk("The hub isn't allowed to use its USB serial ports. Run the Pi set-up again to allow it."),
};

/** Why the hub can't set screens up itself (WifiStatus.reason). */
export const WIFI_REASONS: Record<string, string> = {
  off: tk("Wi-Fi set-up is switched off in the hub's config."),
  'unsupported-os': tk("The hub can't switch Wi-Fi networks on this system."),
  'no-networkmanager': tk("The hub's system doesn't use NetworkManager, which the hub needs to switch Wi-Fi networks."),
  'no-adapter': tk('The hub has no Wi-Fi adapter.'),
  'not-allowed': tk("The hub isn't allowed to switch Wi-Fi networks. Run the Pi set-up again to allow it."),
};

export const STATE_LABELS: Record<ScreenState, string> = {
  online: tk('Online'),
  late: tk('Late'),
  offline: tk('Offline'),
  unknown: tk('Not heard from yet'),
};
