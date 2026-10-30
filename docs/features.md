# Features

Everything RaptHooker does, in more detail than the [README](../README.md).

- **Every pill, recorded around the clock.** Add as many pills as you like; each is recorded on its own, whether or not
  a brew is running. Readings are stored in SQLite on the Pi.
- **RAPT Bluetooth Thermometers too.** A RAPT Bluetooth Thermometer (KL24334) is found and added like a pill, and
  recorded once a minute: its temperature and signal on the dashboard, its own page, charts, TV mode, CSV export,
  webhooks, MQTT and Home Assistant, and temperature and "gone quiet" alerts. It has no gravity, battery or brews. Its
  Bluetooth format isn't published by KegLand; RaptHooker's decoding was worked out against the RAPT app's readings.
- **Brews.** Start a brew on a pill (now, or back-dated to when you pitched), and end it when you're done. Each brew
  keeps its own chart, OG (typed in, or taken from the pill once it has settled), current/final gravity, ABV (standard
  or strong-beer formula), attenuation, temperature range and notes. Brews can be edited, resumed and exported.
  See [docs/brewing.md](./brewing.md).
- **Predictions.** A fermentation curve fitted to each running brew shows its stage (lag, fermenting, finishing, done),
  the expected final gravity and when it should get there. The final ABV is called once the gravity stops moving.
- **Brew timeline.** Log dry hops, temperature changes, cold crashes, additions and notes; they show on the charts.
- **Compare brews** side by side: overlay up to eight brews' gravity and temperature by days since they started.
- **Batch summary** for each brew: a one-page, printable (or save-as-PDF) summary, or copy it as plain text to share.
- **Nothing gets lost to restarts.** Crashes, power cuts, reboots and updates don't stop a brew: the hub picks up where
  it left off and the downtime simply shows as a gap in the chart. The Pi has no clock battery, so readings are held
  until the clock has been set from the network.
- **Looks after itself.** A systemd watchdog restarts the hub if it ever hangs, and Bluetooth is switched off and on if
  it gets stuck. It warns about low storage, a stopped
  Bluetooth, an unsynced clock or a failed backup (with what to do), compacts its database now and then, and trims old
  logs if the disk nearly fills up. A log viewer, a restart button and a diagnostics file (with addresses, names and
  secrets taken out) to attach to an issue are under Settings. See
  [docs/pi-setup.md](./pi-setup.md#troubleshooting).
- **Open it on your phone** by scanning a QR code of the hub's address (Settings → Open on another device).
- **Every value the pill sends:** gravity, temperature, gravity velocity (points/day), battery, signal strength (in
  words, from Excellent to Very weak, with the dBm alongside), tilt, raw accelerometer, firmware and device type, plus
  the interval the hub has learned for each pill.
- **The pill's numbers, or RaptHooker's: your choice per pill.** By default everything is the pill's own. You can
  switch on gravity worked out by RaptHooker from the tilt (with your own calibration points), RaptHooker's own
  velocity (a straight line through the last 6–72 hours) and light or strong smoothing, and compare both side by side
  before you switch. Readings where the pill doesn't look like it's floating are flagged, greyed out on the charts and
  left out of brew stats and gravity alerts. See [docs/calibration.md](./calibration.md).
- **Charts you can explore:** drag across them or pinch to zoom, pan with the overview strip, double-tap to see it
  all; ranges from 6 hours to everything (or pick dates), brew events marked, the pill's own values as a dotted line
  when RaptHooker's are in use, smoothing for the eye (**Smoothing − / +**, which changes only the drawing) and PNG
  export. Knocked the pill while adding hops? Zoom in on the spike and **Exclude this range**: the charts draw a dashed
  curve through it from the readings either side (point at it to see the range, or put it back), while the readings
  themselves are kept. **Exclusions** under the chart switches back to the readings.
- **Kind to Wi-Fi, with room to reach further.** The hub listens passively (BlueZ advertisement monitor), which leaves
  a Pi's shared Wi-Fi/Bluetooth radio far more time for Wi-Fi than ordinary scanning. It can listen with several
  adapters at once (a USB dongle closer to the fermenter) and take adverts from ESP32 relays running ESPHome, and shows
  how many of each pill's readings it catches. See [docs/pi-setup.md](./pi-setup.md#7-bluetooth-passive-scanning-usb-dongles-and-relays)
  and [docs/relay.md](./relay.md).
- **Webhooks** with presets for popular brewing services (each marked verified or untested), a `{{variable}}` template
  with live preview, custom headers, methods and body formats, per-webhook frequency, on/off switch, choice of pills,
  "only while brewing", skipping readings that look wrong, "only send when something changes", all pills in one
  request, pause, duplicate, import/export, optional catch-up after an outage, test sends, retries and a delivery log.
  See [docs/webhooks.md](./webhooks.md).
- **Read-only API** with API tokens for your own scripts and dashboards. See [docs/api.md](./api.md).
- **MQTT and Home Assistant.** Publish every reading to an MQTT broker. With Home Assistant discovery each pill shows up
  as a device with gravity, temperature, battery and brew sensors, no YAML needed. Without MQTT, the Home Assistant
  webhook preset feeds automations, or sensors you define in YAML. See [docs/home-assistant.md](./home-assistant.md).
- **Alerts**: too warm/cold, target gravity reached, fermentation finished (gravity stable), low battery, pill gone
  quiet. Sent as browser notifications and through ntfy, Pushover, Telegram, Discord or email, chosen per alert. See
  [docs/alerts.md](./alerts.md).
- **Name your pills**, pick colours, fine-tune calibration offsets (or let the calibration wizard work them out from
  plain water and a thermometer you trust), archive or remove them.
- **CSV export** of a pill's readings or a brew.
- **Backups.** A copy of everything every night, kept on the Pi and copied to a USB stick and/or S3-compatible storage
  (Amazon S3, Cloudflare R2, Backblaze B2, MinIO...), plus a weekly CSV export of your brews. Download a copy any time
  and restore one from the app. See [docs/backups.md](./backups.md).
- **Installable app** (PWA) on phones and computers. SG/°P and °C/°F per browser (or the hub's defaults), and an Auto,
  Dark or Light theme in your choice of colours: Violet, Ocean, Hops, Amber, Rosé or Graphite (Settings → Hub → This
  browser, or the top bar menu). Opens offline with the last readings this browser saw, clearly marked as saved.
- **Your dashboard, your way.** Arrange the pills in your own order (drag them, or use the arrow buttons), switch to a
  compact list, or show only the pills with a brew on the go. A step-by-step guide gets a new hub going, ticking itself
  off as you create the PIN and add your first pill.
- **TV mode** (`#/kiosk`): big, full-screen readings for a spare screen or TV, rotating through the pills when they don't
  all fit, keeping the screen awake where the browser allows it.
- **Pictures for small screens.** **Image link**, on the dashboard and on each pill's page, makes a web address for a
  picture of every pill (or of one) that a screen showing images from the web can load: a GeekMagic mini screen, an
  ESPHome display, an e-paper frame. Pick the screen's size (or a preset), what's on it (readings, the brew and its
  progress, a graph, battery and signal), dark or light in any of the colours, and PNG, JPEG or BMP, with a live
  preview. The hub draws a fresh picture, in the app's look, each time the screen loads it. See
  [docs/screens.md](./screens.md).
- **Name your hub** and pick its default units and ABV formula (the standard one or one for strong beers). Problems
  the hub notices (a full SD card, Bluetooth trouble) show as a banner at the top.
- **In your language:** English, Deutsch, Español, Français, Italiano, Nederlands, Polski and Português (Brasil),
  following the browser or picked per browser. See [docs/translations.md](./translations.md) to improve one.
- **Accessible:** works with the keyboard and screen readers, with large touch targets on phones and less motion for
  people who ask their device for it.
- **One-line install, and updates from the app**, which go back to the version you had if the new one doesn't start.
  A "What's new" note after each update.
- **Owner PIN** for changes; anyone on your network can look. Works with Tailscale for HTTPS and access away from home.
