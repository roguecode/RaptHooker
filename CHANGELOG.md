# Changelog

All notable changes to RaptHooker are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the version numbers follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **iSpindels.** RaptHooker now records [iSpindels](docs/ispindel.md), the DIY Wi-Fi hydrometer, like a
  pill: dashboard, charts, brews, calibration, alerts, webhooks, MQTT and Home Assistant, CSV export. An iSpindel sends
  its readings over your Wi-Fi to the hub (`/api/ispindel`), with a token the hub makes for it. **Add device →
  iSpindel** can set one up for you: the hub finds iSpindels in setup mode (it keeps looking, every 15 seconds while
  the tab is open), joins one's hotspot for about a minute, changes only the settings it needs (Wi-Fi, the HTTP
  service, the hub's address, the token and how often it sends) and adds it when its first reading arrives. Or set it
  up by hand, with every value to type shown on the same screen, ready to copy. Tested with a real iSpindel on firmware
  6.5.1.
  - Stored in the same tables as pills, with two new columns for readings, `tilt` (degrees) and `voltage` (battery
    volts), and their sums in the rollups (schema 6). Older versions leave them alone: they list an iSpindel you've
    added but don't record it.
  - An iSpindel's `kind` is `ispindel`, its address `ISPINDEL:<chip id>` and its id `ispindel-<chip id>`.
  - A new kind of API token, made by the hub and listed as _iSpindels_ under Settings → API tokens, can only post
    iSpindel readings.
  - Readings in the API gain `voltage`, and devices heard nearby a `name`. New webhook variable `battery_voltage`, MQTT
    state field `battery_voltage` and, for iSpindels, a _Battery voltage_ entity in Home Assistant. An iSpindel's CSV
    export has its own columns.
- **Tilt hydrometers (experimental).** A [Tilt](docs/tilt.md) of any colour, Pro too, is found over Bluetooth (or
  through a relay) and added like a pill, then recorded once a minute: gravity and temperature, with brews, charts,
  calibration, alerts, webhooks, MQTT and Home Assistant, CSV export. Not tried with a real Tilt yet: please report back
  if you have one.
  - A Tilt's `kind` is `tilt`; its id comes from its Bluetooth address, like a pill's. It's named and coloured after its
    colour when added.
  - The ESP32 relay's ESPHome configuration passes Tilts on too: update yours from
    [docs/esphome-relay.yaml](docs/esphome-relay.yaml) to relay them.
- **RAPT Laser Levels (experimental).** A [RAPT Laser Level](docs/laser-level.md) on a keg says how far down the beer
  is; RaptHooker shows how full the keg is (litres and %) from the keg's size, set on its page (KegLand's 19 L keg to
  start with). It has its own dashboard card with a bar, a volume chart, TV mode and screens, and webhooks, MQTT, Home
  Assistant and CSV export get the volume, fill and distance. Not tried with a real one yet: its Bluetooth format comes
  from two community projects, checked against a third's captures (see [attribution.md](attribution.md)). Please
  report back if you have one.
  - A new `distance` column for readings (mm), NULL for every other device, and its sums in the rollups (schema 7).
    Older versions leave it alone.
  - A Laser Level's `kind` is `laser-level`, and its settings have a `vessel` (`capacity` litres, `emptyMm`, `fullMm`).
    Only the distance is stored, so changing the keg changes how full it was everywhere.
  - Readings in the API gain `distance`, `fill` and `volume`, and the history `distance`. New webhook variables
    `volume_l`, `fill_percent` and `distance_mm`, MQTT state fields `volume`, `fill` and `distance`, and _Volume_,
    _Fill_ and _Distance to the beer_ entities in Home Assistant for Laser Levels.
  - **Keg up.** [Keg up](docs/laser-level.md#keg-up) a beer under a Laser Level, with its name, style and ABV (all
    optional, and they can be filled in from any brew). Its card then shows the beer with how much went in, is left and
    has been poured (in place of how full the keg is), and its chart starts at the new **Kegged** range. **Keg empty**
    moves it to the earlier kegs on its page.
    - Kept in a new `kegs` table (schema 8), which older versions leave alone. How much went in is the fullest reading in
      the 6 hours after kegging up.
    - New `/api/kegs` endpoints, `keg` and `keg-removed` live messages, and a `keg` on each Laser Level in the API.
  - **Volume units.** With a Laser Level, a volume unit next to °C/°F shows kegs in litres, US gallons, UK or US pints, or
    each Laser Level's own unit (330 ml cans, say: set in its settings, and in the API as its `servingUnit`). Picked per
    browser; the hub keeps litres.
- **Add device.** A new **Add device** button on the dashboard opens one dialog with a tab for each kind of device: RAPT
  Pills, RAPT Thermometers, RAPT Laser Levels and Tilts heard nearby, ready to name and add as on the dashboard, and
  iSpindels.
- **Alerts on how fast fermentation is going** ([#21](https://github.com/roguecode/RaptHooker/issues/21)). Two new
  kinds of [alert](docs/alerts.md), **Fermentation slows** and **Fermentation speeds up**, go off when the gravity drops
  fewer or more points a day than you pick, going by the pill's velocity. "Fermentation slows" at 10, say, tells you
  fermentation is nearing its end. While a brew is running, it waits until the gravity has dropped 2 points from the
  OG, so it doesn't go off before fermentation gets going. As you type a threshold, the alert editor says what it means
  in SG (0.5 points a day: "drops by less than 0.0005 in a day (that's 1.0500 to 1.0495)"), where it clears and what
  else decides when it goes off; "Fermentation stable" gets the same.
  - Their kinds in the API are `velocity_slow` and `velocity_fast`, with the `threshold` in points a day dropped (a
    velocity of −12 is 12), which has to be more than 0. An older version, if you go back, keeps such a rule but doesn't
    fire it.
- **Alerts on the chart.** A pill's History chart marks where each alert went off and where it cleared. **Alerts**,
  under the chart, hides them in this browser. `GET /api/alerts/events` takes `pillId=` for just one pill's.
- **Switching Bluetooth off**, for a hub on a machine without it or where it can't be passed through (an LXC container,
  say). Settings → Hub → **Listen over Bluetooth** switches the hub's own Bluetooth off or on straight away; the
  installer's `--no-bluetooth` switches it off for good (`bluetooth.enabled: false` in the config file, kept through
  updates; `--bluetooth` undoes it) and leaves the machine's Bluetooth alone. While it's off there's no _Bluetooth isn't
  working_ warning, and [relays](docs/relay.md) and iSpindels carry on. See
  [Without Bluetooth](docs/pi-setup.md#without-bluetooth).
  - Hub settings gain `bluetooth` (true unless switched off; leaving it out of `PUT /api/settings/hub` keeps what's
    saved). The Bluetooth status's `state` can be `off`, with `offBy` saying where (`settings` or `config`).
  - An older version, if you go back, listens over Bluetooth again.

### Changed

- The **MeadTools** webhook preset is now marked **Verified**: it's been tried against MeadTools and works.
- The **Pills** page is now **Devices**, as it has every kind of device on it.
- The small charts on the dashboard's cards and in TV mode cover a running brew (or the beer on tap) from its start,
  or else the last 24 hours, or everything when there's less than that (they always showed the last 24 hours).
- For an iSpindel, the `rssi` webhook variable and the _Signal strength_ entity are its Wi-Fi signal.
- `screens.wifi` and `screens.hubUrl` also apply to setting up iSpindels; the hub sets up one screen or iSpindel at a
  time.
- The `device` webhook variable can also be `tilt` or `laser-level`. A Tilt has no _Battery_ or _Tilt_ entity in Home
  Assistant (it sends neither), and a Laser Level only the entities it has.

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

[Unreleased]: https://github.com/roguecode/RaptHooker/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/roguecode/RaptHooker/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/roguecode/RaptHooker/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/roguecode/RaptHooker/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/roguecode/RaptHooker/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/roguecode/RaptHooker/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/roguecode/RaptHooker/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/roguecode/RaptHooker/releases/tag/v0.3.0
