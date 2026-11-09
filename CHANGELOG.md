# Changelog

All notable changes to RaptHooker are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the version numbers follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.11.0] - 2026-11-09

### Added

- Alerts now show in the UI and can be acknowledged to clear
- Alerts also show on relevant screen UI's ([#36](https://github.com/roguecode/RaptHooker/issues/36))

## [0.10.0] - 2026-11-08

Brew profiles, alerts that follow your brew, and reminders for things like dry hopping.

### Added

- **Brew profiles.** Save a set of alerts and planned events, pick it when you start a
  brew. Make one under **Brews → Profiles**, or save a brew's alerts and events as a profile.
- **Alerts for one brew.** Add alerts on a brew's page that only watch that brew.
- **New alerts:** **Fermentation starts**, **Attenuation reaches** and **Days into the brew**. Each one goes off once
  per brew.
- **Say what to do.** Give an alert a message ("Add the dry hops") and have it added to the brew's timeline when it
  goes off.
- **Planned events and reminders.** Plan an event for later in a brew (a dry hop on day 3) and get a reminder when it
  starts and ends.
- **Readings on charts.** Hovering on the graphs shows the values now.
- **Decimal places.** Choose how many decimals SG, °P and temperatures show under **Settings → Hub**. Notifications and
  chart axes now show SG to 4 decimals by default.

### Fixed

- **Fermentation speeds up** and **Fermentation slows** no longer go off as soon as a brew starts. They now wait for
  the gravity to drop 2 points from what the pill read at the start of the brew.
- Hubs where Bluetooth can't start, such as in a Proxmox LXC container, can update again instead of rolling back. New
  installs in a container now turn Bluetooth off; add `--bluetooth` to keep it on.

## [0.9.1] - 2026-11-07

### Added

- `GET /api/screens/wifi` has a `band` field: the band of the hub's own Wi-Fi network (2.4, 5 or 6 GHz).

### Fixed

- Setting up a screen when the hub is on the 5 GHz band of a network that has the same name on 2.4 GHz: the screen was
  given the 5 GHz channel, and could fail to join ("couldn't join"). It now gets the network's 2.4 GHz channel.
- Screens a router turns away before they join ("couldn't join"), like one that only takes 802.11n: the screen now
  switches between 802.11g and n by itself after 10 s, as it already did when it joined but got no address. This is in
  screen firmware 1.1.2. A screen being set up gets it first, and set-up screens are offered it under **Screens**.

## [0.9.0] - 2026-11-07

Join us on Discord: https://discord.gg/qyaY6QXjdh

### Added

- Support for new devices:
  - iSpindel
  - Tilt Hydrometer (experimental)
  - RAPT Laser Level (experimental)
- Alerts for when fermentation speeds up or stalls, and alerts now show on charts.
- Brew events can now have a start and end time (like a dry hop), and can be hidden from the chart.
- Bluetooth can be switched off, for hubs that only use relays or iSpindels.
- Beta versions. Add support to switch between mainline and betas from Settings → Updates.
- A Help button in the top bar, linking to the Discord server and GitHub.

### Changed

- The Pills page is now Devices.
- The dashboard and TV charts cover the whole brew instead of the last 24 hours.

### Fixed

- Excluded chart ranges now also apply on the dashboard, in TV mode and on image links.

## [0.8.0] - 2026-11-02

### Added

- **MeadTools webhook preset.** Send your pills' readings to [MeadTools](https://meadtools.com)' wireless hydrometer
  logging: paste the hydrometer token from MeadTools into the body, and each pill shows up there under its own name,
  ready to start a brew for. Untested for now, so please report back if you try it.

### Changed

- **Send all pills in one request** is only offered for destinations that can read several pills from one request
  (your own server, Home Assistant, Discord, Everything (JSON) and Custom). Brewfather, Grainfather, Brewer's Friend,
  BrewSpy, Bricks, MeadTools, Fermentrack, Ubidots and ThingSpeak take one reading per request, so a webhook for all
  pills sends each one on its own. A webhook already saved with it on for one of them still sends as before; its card
  and the editor warn about it.

## [0.7.0] - 2026-11-02

### Added

- **Screens.** RaptHooker can now turn a **Geekmagic Ultra/Smart weather clock** (a little 240 × 240 Wi-Fi desk screen) into a display
  for your pills. Plug it in, open the new **Screens** tab and press **Add a screen**: the hub finds the screen's own
  Wi-Fi, puts RaptHooker's firmware on it, connects it to your network and shows the details once it's there. From then
  on the screen fetches a picture of a pill (or of every pill) from the hub, designed with the same choices as an image
  link, as often as you like; when something's wrong it says so in a line under the picture. The **Screens** page shows
  how each one is doing, offers new screen firmware (**Update all**), finds screens on the network again (adding one
  takes the code it shows), and can put a screen's original firmware back. A pill's page shows the screens showing it,
  and the **Image link** dialog can send its picture to a screen. A hub that can't switch Wi-Fi networks (in Docker, say)
  sets screens up from a browser instead. See [docs/rapthooker-screens.md](docs/rapthooker-screens.md).
  - Stored in a new `screens` table (schema 5), which older versions leave alone.
  - On a Pi, setting up again (or updating) adds a polkit rule that lets the service switch Wi-Fi networks through
    NetworkManager for this.
  - New config keys `screens.wifi` and `screens.hubUrl`; the Docker config sets screens up from a browser.
- **ESP32 screens over USB.** The **ESP32-2432S028** 2.8" board ("Cheap Yellow Display", 320 × 240) is a RaptHooker
  screen too: plug it into the hub's USB, and **Add a screen** (on its new **Plugged into the hub (USB)** tab) writes the
  firmware and your Wi-Fi details in one go, watches it join, and finds it on the network, in about a minute, without
  the hub leaving its Wi-Fi. As panels on these boards vary from batch to batch, **Does the screen look right?** shows a
  test pattern and can turn, mirror or recolour the picture. Updates on these boards go back to the firmware they had by
  themselves if the new one doesn't work.
  - The screen firmware (1.1.0) now builds for the ESP32 as well as the ESP8266, from the same source.
  - On a Pi, setting up again (or updating) installs esptool in `/usr/local/lib/rapthooker/esptool` and adds the
    service to the `dialout` group.
  - New config keys `screens.usb` and `screens.python`; the Docker config has USB set-up off.
  - Saved screens gain `panel` (display corrections), which older versions keep.
  - Boards left plugged into the hub are recognised: firmware 1.1.1 says which screen it is over USB (without
    restarting), so the USB tab lists your screens under **Already set up** and only opens by itself for a new board.
  - Screens are marked **experimental**. The **Screens** page says so, and lists the screens that have been confirmed
    working, with where users bought them (not endorsements), and which other screens might or won't work.

### Changed

- The live updates' `hello` message also has the hub's screens.

### Fixed

- A hub on Wi-Fi alone came back after a router restart only when NetworkManager happened to try again (it gives up
  after a few failures). Now the hub asks NetworkManager to reconnect once it has been off its Wi-Fi for 2 minutes.

## [0.6.0] - 2026-10-30

### Added

- **Leave a bump out of the charts.** Knocked the pill while adding hops, and the chart shows a big spike? Zoom in on it
  and press **Exclude this range**. The pill's and the brew's charts then hide those readings and draw a dashed curve
  through the gap that carries on the way the readings were going either side; the charts' averages, smoothing and
  RaptHooker's velocity leave the knock out too. Point at the curve (or tap it) to see the range shaded, with a button
  to put its readings back for good. The readings themselves are kept: brew stats, alerts, webhooks and exports don't
  change. **Exclusions**, next to the lines on the chart, switches back to the readings in this browser. The ranges are
  saved with the pill's settings (a new `exclusions` list, which older versions keep), so every browser sees them.
- **Smoothing for the eye.** **Smoothing − / +** under a pill's and a brew's chart draws the lines as a moving average
  over 15 minutes up to 16 hours, centred so the line doesn't lag; 0 shows the readings as they are. Only the drawing
  changes: the legend, stats, alerts and webhooks keep using the readings. Each browser remembers its choice.

### Changed

- **The chart's buttons are under it.** The lines to show, **Show it all**, **Exclude this range**, **Exclusions** and
  **Smoothing** sit below the chart; the time ranges, PNG and CSV stay above. The notes that were under the chart are
  gone (the legend names the dotted and faded lines).

### Removed

- **Picking the OG from the chart.** Tapping a reading to use it as the brew's OG is gone; change the OG with **Edit**
  on the brew.

## [0.5.0] - 2026-10-28

### Added

- **Colours to choose from.** Besides the original violet and blue, the app now comes in Ocean, Hops, Amber, Rosé and
  Graphite, each with a dark and a light version that follow the Auto, Dark or Light theme. Pick one per browser under
  **Settings → Hub → This browser** or in the top bar menu. Violet stays the default.
- **Pictures for small screens.** **Image link**, on the dashboard and on each pill's page, gives a web address for a
  picture of every pill (or of one) for a screen that shows images from the web: a GeekMagic mini screen, an ESPHome
  display, an e-paper frame. Choose the screen size (presets include the 240 × 240 GeekMagic), what's on it (readings,
  the brew and its progress, a graph of the brew, battery and signal), dark or light in any of the colours, the units,
  and PNG, JPEG or BMP, and watch the preview change as you go. The hub draws a fresh picture in the app's look each
  time the screen loads the link, and everything about it is in the link itself. See
  [docs/screens.md](https://github.com/roguecode/RaptHooker/blob/main/docs/screens.md).

### Changed

- **A tidier pill page.** Under the pill's summary come the running brew, the history, the pill's data (battery,
  signal, tilt, firmware and the rest, now in a **Data** panel) and its settings. Each panel folds away from its
  heading; Data and the settings start folded, and the browser remembers what you open or fold. A folded Data panel
  still says when readings are being missed or the signal is weak, and the "is the pill floating?" warning shows under
  the summary. The history opens on the brew when one is running, including one started while the page is open.
- **Grainfather, BrewSpy and ThingSpeak webhooks take one pill each.** These services file everything a webhook sends
  under one device, so a webhook for several pills mixed their readings together. The editor now says so at the top,
  starts with one pill (the hub's only pill, if it has one) and saves only one, unless you choose **Allow several pills
  anyway**. Existing webhooks keep sending as they are; one that sends several pills to such a service shows a warning
  on its card and in the editor.

## [0.4.1] - 2026-10-27

### Added

- **How to switch a RAPT Pill to Bluetooth** in the README, on the original firmware and the new (V2) one, with a short
  video of each.

### Fixed

- **Alerts:** an alert that "Don't repeat for" kept quiet is now announced once that time is up if it's still going
  (before, a pill that went quiet again soon after coming back was never reported). An alert whose rule is switched
  off, or whose brew ends, no longer stays "firing" and fires afresh the next time. "Fermentation stable" uses the
  gravity worked out from the tilt when a pill is set to, as everything else does. The in-app message when an alert
  clears now says where things are ("Back to normal: Kveik is at 21.0 °C") rather than repeating why it fired.
- **No false "goes quiet" alerts after the hub starts:** on a Pi without a clock, pills heard before the time was set
  from the network no longer look silent for as long as the hub was off, and their "last heard" time is put right.
- **"Last heard" no longer jumps back** when a relay posts an advert it heard a few minutes earlier.
- **Webhooks with an emoji (or other non-Latin text) in a header**, e.g. from a pill's name, are sent (as UTF-8)
  instead of failing every time. Catching up after an outage now sends the smoothed gravity and RaptHooker's velocity
  when a pill uses them, like a normal send.
- **Settings saved by a newer version are kept** when hub, MQTT and backup settings, alerts or notification channels
  are saved after going back to an older one.
- **Backups:** a cloud (S3) backup turned away because the hub's clock is off now shows as a warning. A missed weekly
  CSV export is made up the next day rather than the day after. Unfinished copies left by a restart in the middle of
  one are tidied up, and a failed S3 upload no longer leaves the file open.
- **Charts:** live readings on a brew's chart (and the dashboard and TV mode) no longer break the line for pills that
  report every half hour or so. A brew's chart zooms out, and double-click, 0 and Escape show all of it, like a pill's.
  The dashboard and TV mode sparklines leave out readings where the pill wasn't floating.
- **The app no longer shows "Offline" for a moment** (or stays that way) after signing in or out.
- A pill change that's turned down (gravity from the tilt without calibration points) no longer half-applies.
- `LOG_LEVEL=debug` shows debug messages in the log and the in-app log viewer.
- The message for MQTT settings that couldn't be loaded is translated.
- Database compaction with a backup time after 23:30 waits for the quiet hours after midnight.

## [0.4.0] - 2026-10-26

### Added

- **RAPT Bluetooth Thermometers:** a RAPT Bluetooth Thermometer near the hub (or a relay) shows up under "Found nearby"
  and is added like a pill. It's recorded once a minute, with its own card, page, charts, TV mode tile and CSV export,
  and is sent by webhooks (gravity and battery are `null`), published over MQTT (a Home Assistant device with
  temperature, signal and last reading) and watched by temperature and "gone quiet" alerts. It has no gravity, battery
  or brews.
- **A copy of the data before an update changes how it's stored**, kept on the hub (the last 3) and listed under
  Settings → Backups as "From before an update", to download or restore. If the copy can't be made, the data is left
  as it was.

### Changed

- **Ready for more kinds of device:** readings now store what a device doesn't measure as empty rather than 0. The
  first start after updating converts the database once (seconds, or up to half a minute for a very big one on a Pi);
  every reading, average and setting is kept exactly as it was. Versions from now on also refuse to open data that a
  later version has marked as unusable by them, rather than risk damaging it.
- **Grainfather, BrewSpy and Home Assistant webhook presets are verified:** tried against the real services and
  working. The Home Assistant guide now shows how to make sensors for your pills from the webhook, without MQTT.

## [0.3.0] - 2026-10-25

The first release.

### Added

- **Records every RAPT Pill it hears** over Bluetooth, around the clock, on a Raspberry Pi. Scanning is passive, so
  it's gentle on the Pi's radio. Readings are dated to when they were taken, and readings that look wrong (a pill lying
  on its side out of the beer, say) are flagged instead of spoiling the chart and the numbers.
- **Bluetooth relays**: another device (such as an ESP32) near the fermenter can pass a pill's broadcasts on to the hub.
- **Each pill at a glance**: gravity, temperature, battery, tilt, signal strength in words (Excellent to Very weak,
  with the dBm alongside and a tip when it's weak) and how many of its readings the hub caught over the last day.
- **Dashboard**: arrange the pills, a compact view, a "brewing only" filter and a TV mode for an always-on screen. The
  app opens offline with the last readings it saw, and can be installed on phones and computers.
- **Charts**: zoom and pan (also by pinching), date ranges, PNG and CSV export, an overview strip and brew events.
- **Brews** with their own chart, OG (worked out automatically, or your own), gravity, ABV (a choice of formula, and a
  final ABV once the gravity is stable), attenuation, notes and events (dry hop, cold crash...). Also an estimate of
  when fermentation will finish and the stage it's in, a summary at the end, and brews compared side by side.
- **Calibration**: offsets for gravity and temperature, and a wizard for a water check, a reference thermometer and
  tilt calibration points. RaptHooker can also work out gravity velocity, gravity from the tilt and smoothing of noisy
  readings itself; the pill's own values stay the default.
- **Webhooks** with presets for popular brewing services, a template editor with a live preview and a delivery log.
  Send several pills in one request, only when a value crosses a threshold, pause, duplicate, import and export, and
  catch up on readings missed while a service was down.
- **MQTT** with **Home Assistant** discovery: each pill appears in Home Assistant by itself.
- **Alerts** by browser notification, ntfy, Pushover, Telegram, Discord and email.
- **API tokens** for scripts and other apps.
- **Backups**: download and restore from the app, copy to a USB stick or S3-compatible storage, made every night on
  the Pi, and a weekly CSV of every brew.
- **One-line installer** for the Raspberry Pi (and an experimental ready-made image), and **updates from the app**: the
  hub checks for a new version once a day (you can turn this off) and updates itself with one click, going back to the
  version it had if the new one doesn't start. A "What's new" note shows after each update.
- **Development builds say so**: a hub deployed from source with `deploy.ps1`/`deploy.sh` shows **Development build**
  and the commit it was built from, and can switch back to the latest release.
- **Watchdog**: systemd restarts the hub if it ever stops responding, and Bluetooth is reset by itself if it gets
  stuck. Warnings for low storage and other problems, and the database is tidied now and then.
- **Hub addresses as QR codes**, a **logs viewer** and a **diagnostics** download.
- **First-run guide**, a **light theme**, hub settings (name, default units, ABV formula), and keyboard and screen
  reader support.
- **Translations**: Deutsch, Español, Français, Italiano, Nederlands, Polski and Português (Brasil).
- **Docker** image for Linux hosts with Bluetooth.

[Unreleased]: https://github.com/roguecode/RaptHooker/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/roguecode/RaptHooker/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/roguecode/RaptHooker/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/roguecode/RaptHooker/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/roguecode/RaptHooker/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/roguecode/RaptHooker/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/roguecode/RaptHooker/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/roguecode/RaptHooker/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/roguecode/RaptHooker/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/roguecode/RaptHooker/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/roguecode/RaptHooker/releases/tag/v0.3.0
