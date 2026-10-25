# Raspberry Pi setup

RaptHooker runs on a **Raspberry Pi 3, 4, 5 or Zero 2 W**. It needs very little: a few MB of disk a month per pill
and a sliver of CPU. The original Pi Zero W (ARMv6) isn't supported.

## 1. Hardware

- **Power:** a proper supply (5 V / 2.5 A for a Pi 3). Under-voltage causes random Bluetooth and SD card problems.
- **Storage:** a decent microSD card (A1/A2), or a USB SSD.
- **Placement:** within Bluetooth range of your fermenters. A pill floating in beer inside a fridge or a stainless
  fermenter is harder to hear: keep the Pi close, and check the signal on the pill's page. It should say **OK** or
  better (better than −85 dBm); **Weak** or **Very weak** means some readings will be missed. A
  [USB Bluetooth dongle](#a-usb-bluetooth-dongle-more-range) on an extension lead, or a [relay](relay.md) next to the
  fermenter, reaches further.
- **Network:** Ethernet if you can. Wi-Fi works too: the Pi's Wi-Fi and Bluetooth share one radio, so RaptHooker
  listens [passively](#passive-scanning-kinder-to-wi-fi) to leave Wi-Fi as much of it as possible.

## 2. Flash the SD card

1. Install [Raspberry Pi Imager](https://www.raspberrypi.com/software/).
2. Choose your Pi model, **Raspberry Pi OS Lite (64-bit)** and your card.
3. In the settings: a hostname (`rapthooker` is a good choice: you'll open `http://rapthooker.local:8080`), a username
   and password (`pi` is assumed by the PC deploy scripts), Wi-Fi if needed, your time zone, and **enable SSH**
   (ideally with your public key).
4. Boot the Pi and check you can log in: `ssh pi@<hostname>.local`.

(Or write the ready-made [Raspberry Pi image](#the-ready-made-image-experimental), experimental, with RaptHooker
already on it. Then skip step 3.)

### The ready-made image (experimental)

Each release also has a Raspberry Pi OS Lite (64-bit) image with RaptHooker installed: `rapthooker-<version>.img.xz`
under [Releases](https://github.com/roguecode/RaptHooker/releases). Write it with Raspberry Pi Imager (**Choose OS →
Use custom**) and, when Imager offers OS customisation, **set a username and password**, Wi-Fi and SSH there: the
image has no default login. Without that, the first boot asks for a username and password on a screen and keyboard.
The Pi is called `rapthooker`, so once it's up open `http://rapthooker.local:8080`. The image is built automatically
and hasn't been tried on every model yet: the one-line installer is the tried and tested way.

## 3. Install RaptHooker

Logged in to the Pi, run:

```bash
curl -fsSL https://raw.githubusercontent.com/roguecode/RaptHooker/main/deploy/install.sh | sudo bash
```

Options go after `-s --`, for example
`curl -fsSL https://raw.githubusercontent.com/roguecode/RaptHooker/main/deploy/install.sh | sudo bash -s -- --hostname rapthooker --tailscale`:

- `--hostname NAME` renames the Pi (so it's `NAME.local`); without it the Pi keeps the name you gave it
- `--tailscale` also installs [Tailscale](#5-https-and-access-away-from-home-tailscale)
- `--version 0.3.0` installs that release instead of the latest

The installer checks the Pi is supported, downloads the latest [release](https://github.com/roguecode/RaptHooker/releases),
checks it against its published checksums, puts it in `/opt/rapthooker` and runs [setup.sh](../deploy/pi/setup.sh),
which:

- installs BlueZ, Avahi and Node.js 24 (if a recent enough Node isn't there already)
- creates a `rapthooker` service user, with data in `/var/lib/rapthooker` and config in `/etc/rapthooker`
- lets the service listen to Bluetooth through D-Bus ([rapthooker-dbus.conf](../deploy/pi/rapthooker-dbus.conf)),
  switches on BlueZ's experimental features, for [passive scanning](#passive-scanning-kinder-to-wi-fi), and adds a small
  helper that switches Bluetooth off and on if it ever [gets stuck](#troubleshooting)
- makes sure network time is on (the Pi has no clock battery), keeps logs in RAM to spare the SD card, and turns off
  Wi-Fi power saving
- installs the `rapthooker` systemd service, which starts at boot and restarts itself if it ever stops, and lets the
  app update itself ([docs/updating.md](updating.md))

Then it starts RaptHooker, waits until it answers and prints the addresses to open. Running the same command again
reinstalls or upgrades: your data and settings stay, and any brew carries on.

### Or build and deploy from your PC

For running your own changes. From this repository on your PC (needs Node.js 22.13+ and the OpenSSH client, which
Windows 10/11 include):

```powershell
npm install
.\deploy\deploy.ps1 -PiHost <hostname>.local -Setup
```

or on macOS/Linux:

```bash
npm install
./deploy/deploy.sh <hostname>.local --setup
```

This builds the app on your PC, copies it to `/opt/rapthooker` and runs the same setup.sh, which also renames the Pi to
`rapthooker`. To keep your hostname, add `-SetupArgs '--keep-hostname'` (PowerShell) or
`--setup-args "--keep-hostname"` (bash); to pick another, `--hostname NAME`. Use the same command without
`-Setup`/`--setup` (and with `-PiHost rapthooker.local`, the default) to update. A hub deployed this way doesn't
update itself from the app.

## 4. First visit

Open `http://rapthooker.local:8080`. The dashboard shows a short guide that ticks itself off as you go:

1. **Create an owner PIN** (right there in the guide, or in Settings). Anyone on your network can look; adding pills,
   brews and webhooks needs the owner.
2. Put your RAPT Pill in **Bluetooth mode**: in the RAPT app, open the pill → Connect → Setup → **Telemetry via
   Bluetooth**, and set the telemetry interval. It'll appear on the dashboard as **Found a RAPT Pill nearby** after its
   next broadcast. Click **Add pill**: from then on it's recorded around the clock.
3. Start a brew from the pill's page, and add webhooks and alerts as you like.

Under **Settings → Hub** you can name the hub (shown in the top bar and the browser tab), pick the default units (used
in notifications and by every browser that hasn't picked its own) and the ABV formula.

### A screen for the brewery

**TV mode** (the button on the dashboard, or `http://rapthooker.local:8080/#/kiosk`) shows every pill in big, full-screen
tiles: gravity, temperature, ABV, velocity, battery, when it was last heard and the brew's day. When the pills don't
all fit, it rotates through them (every 10 to 60 seconds; move the mouse or tap for the controls). Browsers only keep
the screen awake for pages served over HTTPS (such as through Tailscale, below) or opened on the Pi itself as
`http://localhost:8080/#/kiosk`; otherwise turn off screen blanking on the device showing it.

## 5. HTTPS and access away from home (Tailscale)

Notifications and installing the app need HTTPS. The easy way is [Tailscale](https://tailscale.com) (free for personal
use):

```bash
curl -fsSL https://tailscale.com/install.sh | sh     # or run setup.sh with --tailscale
sudo tailscale up
sudo tailscale serve --bg http://127.0.0.1:8080
tailscale serve status                               # shows https://rapthooker.<your-tailnet>.ts.net
```

Through `tailscale serve` you're recognised as the owner automatically (limit this to certain people with
`auth.allowedTailscaleUsers` in the config). Install Tailscale on your phone, open that address and use **Add to Home
Screen** / **Install app**, then switch on notifications under **Alerts**.

## 6. Backups

Every night the hub saves a copy of its database to `/var/lib/rapthooker/backups` (the last 7 are kept). Under
**Settings → Backups** you can download a copy, restore one, and have each backup copied to a USB stick named
RAPTHOOKER plugged into the Pi or uploaded to S3-compatible storage (Amazon S3, Cloudflare R2, Backblaze B2, MinIO...).
See [backups.md](backups.md) for the details, including restoring by hand.

## 7. Bluetooth: passive scanning, USB dongles and relays

**Settings → Bluetooth** shows how the hub is listening, with which adapters and relays, and how many of each pill's
readings it caught over the last day. Close to 100% is what you want; much less means the hub is missing
transmissions, and the options below help.

### Passive scanning (kinder to Wi-Fi)

A Raspberry Pi's Wi-Fi and Bluetooth share one radio chip and take turns on it. Ordinary (active) Bluetooth scanning
keeps the radio busy: on a Pi 3 B+, pings over Wi-Fi went from about 22 ms to 100–250 ms while scanning. So RaptHooker
listens **passively** when it can: it asks BlueZ for an advertisement monitor that reports only adverts carrying RAPT
data, and the Pi never transmits scan requests. Pills are heard just the same, as they put their readings in the advert
itself.

As a rough guide, on one Pi 3 B+ pings from a PC over Wi-Fi took:

| Listening | Median | 90% of pings within |
| --------- | ------ | ------------------- |
| Active    | 53 ms  | 174 ms              |
| Passive   | 26 ms  | 119–208 ms          |

Advertisement monitors are one of BlueZ's experimental features (they need BlueZ 5.56 or later and Linux 5.10 or
later; Raspberry Pi OS Bookworm and Trixie qualify). Setup switches them on
([20-bluetooth-experimental.sh](../deploy/pi/setup.d/20-bluetooth-experimental.sh)): `Experimental = true` in the
`[General]` section of `/etc/bluetooth/main.conf`, or `bluetoothd --experimental` on BlueZ older than 5.60, restarting
Bluetooth only if something changed. It stops RaptHooker and switches the radio off (rfkill) while Bluetooth restarts,
then starts RaptHooker again: restarting Bluetooth in the middle of a scan can leave the controller stuck. The hub's log
says which mode it uses, and why if it isn't passive:

```bash
journalctl -u rapthooker | grep 'scanning for RAPT Pills'
# ... scanning for RAPT Pills with hci0 (passive)
```

`bluetooth.scanMode` in `/etc/rapthooker/rapthooker.config.json` chooses (then `sudo systemctl restart rapthooker`):

| `scanMode`       | What it does                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `auto` (default) | Passive when BlueZ offers it, otherwise active                                                   |
| `passive`        | Passive only. If it isn't available, Bluetooth shows an error rather than scanning actively      |
| `active`         | Ordinary scanning (discovery), as before. Use it if passive scanning misbehaves on your hardware |

In `auto` mode the hub keeps an eye on passive scanning: if the pills it records go unheard for 2 hours (or 4 of their
intervals), it tries active scanning for as long. If that hears them, it stays active (Settings → Bluetooth says why);
if not, the pills are simply away and it goes back to passive. And if Bluetooth looks stuck altogether, the hub has it
switched off and on (see _Bluetooth stuck_ under [Troubleshooting](#troubleshooting)).

### A USB Bluetooth dongle (more range)

The Pi's own Bluetooth antenna is small and sits in its case, right next to Wi-Fi. A cheap USB Bluetooth dongle on a
USB extension lead, out of the case and closer to the fermenters, often hears pills much better, and it has a radio of
its own instead of sharing Wi-Fi's. Most USB Bluetooth 4.0/5.0 dongles work with Linux; ones with a Realtek chip may
need `sudo apt install firmware-realtek`. `bluetoothctl list` shows the adapters BlueZ has.

RaptHooker listens with every adapter it finds (the Pi's own is `hci0`, a dongle usually `hci1`). A reading heard by
several is stored once. To use only some, list them: `"bluetooth": { "adapters": ["hci1"] }` (the older
`"adapter": "hci0"` setting still works for one). A dongle plugged in while the hub runs is picked up by itself.

If the dongle hears everything, you can switch the Pi's own Bluetooth off so Wi-Fi has the radio to itself: add
`dtoverlay=disable-bt` to `/boot/firmware/config.txt`, run `sudo systemctl disable hciuart` and reboot. The dongle then
becomes `hci0`, so leave `bluetooth.adapters` empty.

### Relays

For a fermenter the Pi can't hear at all (a garage, a chest freezer), an ESP32 next to it can pass on what it hears
over Wi-Fi. See [relay.md](relay.md).

## Troubleshooting

- **Logs:** **Settings → Logs** (as the owner) shows the hub's recent log lines, filtered by level, with a Copy button
  and auto-refresh. Everything since boot is in the journal: `journalctl -u rapthooker -f`.
- **Warnings:** **Settings → Hub status** lists anything that needs attention, each with what to do: storage running
  low, a big database, the clock not set from the network, Bluetooth not working, a failed backup, or the hub
  responding slowly. It also shows storage use, MQTT and how each backup went.
- **Asking for help:** **Settings → Restart and diagnostics → Download diagnostics** saves a file with the hub's status,
  settings, Bluetooth details, its last 500 log lines and the last 200 Bluetooth broadcasts it heard. Bluetooth and IP
  addresses, names, web addresses, tokens and passwords are taken out, so it's safe to attach to a
  [GitHub issue](https://github.com/roguecode/RaptHooker/issues), but look it over first.
- **Something seems stuck:** **Restart** in the same place stops the hub and systemd starts it again a few seconds later
  (or `sudo systemctl restart rapthooker`).
- **Hangs restart themselves:** the service runs with a systemd watchdog (`Type=notify`, `WatchdogSec=60` in
  [rapthooker.service](../deploy/pi/rapthooker.service)). The hub pings it every 20 seconds from its main loop, through
  `systemd-notify`; if it ever hangs, the pings stop and systemd restarts it within a minute. `journalctl -u rapthooker`
  then shows `Watchdog timeout`. A slow first start (a database upgrade) has 5 minutes before it counts as failed.
- **Storage:** once a week, in the quiet hours after the nightly backup, the hub compacts its database if over a fifth
  of it is unused space (and the disk has room for the copy). If the disk gets nearly full (under 100 MB), it deletes
  webhook delivery logs and alert history older than a week to keep recording. Readings are never deleted that way.
- **Opening the app on your phone:** **Settings → Open on another device** shows the hub's addresses with QR codes to
  scan (the Tailscale one only for the owner).
- **`rapthooker.local` not found:** Windows sometimes fails to look up `.local` names. Try again, or use the Pi's IP
  address instead (shown by your router, or `hostname -I` on the Pi), e.g. `-PiHost 192.168.1.50`.
- **Is the pill heard?** `node /opt/rapthooker/server/rapthooker-probe.cjs 300` prints every RAPT advert the Pi hears
  for 5 minutes, decoded, with the adapter that heard it. Nothing at all usually means the pill is in Wi-Fi mode, out of
  range, or between broadcasts (they're only every few minutes). `RAPTHOOKER_SCAN_MODE=active` (or `passive`) in front
  of the command tries one way of listening; `RAPTHOOKER_ADAPTER=hci1` one adapter.
- **Bluetooth state:** Settings → Bluetooth shows whether the hub is listening, passively or actively and why, and the
  dashboard shows a warning if Bluetooth stops. `sudo systemctl restart bluetooth` (RaptHooker reconnects by itself;
  if nothing is heard afterwards, see the next point) and `rfkill list`. If bluetoothd itself stops, setup has told
  systemd to start it again (`/etc/systemd/system/bluetooth.service.d/rapthooker-restart.conf`), and RaptHooker keeps
  trying until it's back.
- **Bluetooth stuck:** now and then the Pi's Bluetooth controller stops hearing anything although everything looks fine
  (Settings → Bluetooth says it's listening, but _Last pill heard_ keeps growing). Restarting Bluetooth in the middle of
  a scan can do it. The hub notices: when the pills it records go unheard for about 5 of their intervals (at least 15
  minutes) after it has restarted its own listening, it asks a small helper that runs as root
  ([bt-reset.sh](../deploy/pi/bt-reset.sh), started by `rapthooker-bt-reset.path`) to switch Bluetooth off and on, and
  then listens again. That happens at most once an hour, then after 3 hours and then every 6 hours while it doesn't
  help. Pills heard only through a relay, or by nobody for a day (switched off between brews), don't count. Settings →
  Bluetooth shows the last reset, and `journalctl -u rapthooker-bt-reset` what the helper did. On a
  hub set up before the helper existed, the log suggests doing it by hand (running setup again adds the helper):
  `sudo rfkill block bluetooth && sleep 2 && sudo rfkill unblock bluetooth && sudo systemctl restart rapthooker`
- **Wi-Fi slow while the hub runs:** check Settings → Bluetooth says **Passive**. If it says active because BlueZ's
  experimental features are off, run setup again (`sudo bash /opt/rapthooker/deploy/pi/setup.sh --keep-hostname`), or
  use Ethernet.
- **Gaps in the chart** are times nothing was recorded: the Pi was off, restarting, or the pill was out of range.
