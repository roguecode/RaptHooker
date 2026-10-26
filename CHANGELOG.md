# Changelog

All notable changes to RaptHooker are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the version numbers follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/roguecode/RaptHooker/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/roguecode/RaptHooker/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/roguecode/RaptHooker/releases/tag/v0.3.0
