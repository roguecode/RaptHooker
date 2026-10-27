# Changelog

All notable changes to RaptHooker are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the version numbers follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

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

[Unreleased]: https://github.com/roguecode/RaptHooker/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/roguecode/RaptHooker/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/roguecode/RaptHooker/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/roguecode/RaptHooker/releases/tag/v0.3.0
