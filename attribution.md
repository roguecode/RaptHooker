# Attribution

RaptHooker builds on other people's work. Thank you to all of them.

## RAPT Pill Bluetooth format

- **KegLand / RAPT**, [Pill Hydrometer Bluetooth Transmissions](https://gitlab.com/rapt.io/public/-/wikis/Pill-Hydrometer-Bluetooth-Transmissions)
  (public wiki): the advert layout (v1/v2 metrics, firmware and device-type adverts, and how the RAPT MAC relates to
  the Bluetooth address) that [src/server/ble/rapt.ts](src/server/ble/rapt.ts) decodes.
- **[sairon/rapt-ble](https://github.com/sairon/rapt-ble)** (MIT), the parser used by Home Assistant's `rapt_ble`
  integration: used to cross-check the byte layout and scaling. No code was copied.
- **KegLand**, [RAPT Pill Bluetooth operation](https://docs.rapt.io/): how to put a pill into Bluetooth telemetry mode.
- The tilt angle is the usual floating-hydrometer formula (angle between the accelerometer's long axis and gravity), as
  used by the iSpindel and GravityMon projects.

## Passive Bluetooth scanning and relays

- **BlueZ**'s [AdvertisementMonitor](https://github.com/bluez/bluez/blob/master/doc/org.bluez.AdvertisementMonitor.rst)
  and [AdvertisementMonitorManager](https://github.com/bluez/bluez/blob/master/doc/org.bluez.AdvertisementMonitorManager.rst)
  API documentation, and its source (`src/adv_monitor.c` for how monitors are registered, read and activated, and which
  RSSI values mean "unset"; `src/shared/ad.c` for how manufacturer data patterns include the company id): the passive
  scanning in [src/server/ble/bluez.ts](src/server/ble/bluez.ts).
- **[Bleak](https://github.com/hbldh/bleak)** (MIT), the Python Bluetooth library Home Assistant uses: its BlueZ backend
  (`advertisement_monitor.py`, `manager.py`) showed that an "or_patterns" monitor with the RSSI properties left out is
  how to listen passively for adverts, and what to tell users when BlueZ lacks it. No code was copied.
- **[ESPHome](https://esphome.io)** documentation for [esp32_ble_tracker](https://esphome.io/components/esp32_ble_tracker/)
  and [http_request](https://esphome.io/components/http_request/): the relay configuration in
  [docs/esphome-relay.yaml](docs/esphome-relay.yaml).

## Webhook targets

The presets in [src/shared/presets.ts](src/shared/presets.ts) follow each service's own documentation where it exists:

- [Brewfather Custom Stream](https://docs.brewfather.app/integrations/custom-stream)
- [Brewer's Friend device streams](https://docs.brewersfriend.com/api/stream) and
  [iSpindel notes](https://docs.brewersfriend.com/devices/ispindel)
- [Bricks / BierBot: RaptPill](https://docs.bierbot.com/hardware/hardware/raptpill)
- [BrewSpy: setting up iSpindel](https://brewspy.app/)
- [Home Assistant webhook triggers](https://www.home-assistant.io/docs/automation/trigger/#webhook-trigger),
  [Ubidots HTTP API](https://docs.ubidots.com/reference/http), [ThingSpeak](https://www.mathworks.com/help/thingspeak/writedata.html),
  [Discord webhooks](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks), [Fermentrack](https://docs.fermentrack.com/)
- **[mp-se/GravityMon](https://github.com/mp-se/gravitymon)** [service integration docs](https://mp-se.github.io/gravitymon/services.html):
  the Grainfather and BrewSpy endpoints and their iSpindel-format payloads, and the 15-minute limits. No code was copied.
- The iSpindel JSON field names (`name`, `ID`, `token`, `angle`, `temperature`, `temp_units`, `battery`, `gravity`,
  `interval`, `RSSI`) are the de facto format accepted by these services, as sent by the
  [iSpindel](https://github.com/universam1/iSpindel) firmware. No iSpindel code was copied.

## Home Assistant

- [Home Assistant MQTT discovery](https://www.home-assistant.io/integrations/mqtt/#mqtt-discovery), and its
  [MQTT sensor](https://www.home-assistant.io/integrations/sensor.mqtt/) and
  [binary sensor](https://www.home-assistant.io/integrations/binary_sensor.mqtt/) docs: the discovery topics, payload
  keys, availability and birth message that [src/server/mqtt.ts](src/server/mqtt.ts) follows.
- The [Mosquitto broker add-on](https://github.com/home-assistant/addons/blob/master/mosquitto/DOCS.md) docs, for the
  setup steps in [docs/home-assistant.md](docs/home-assistant.md).

## Brewing maths

- The standard ABV formula, (OG − FG) × 131.25, is common homebrewing knowledge. The alternative one for strong beers,
  76.08 × (OG − FG) / (1.775 − OG) × FG / 0.794, is the widely used formula attributed to Ray Daniels
  (_Designing Great Beers_) and Michael L. Hall ("Brew by the Numbers", _Zymurgy_).
- The fermentation curve in [src/shared/fermentation.ts](src/shared/fermentation.ts) is the textbook four-parameter
  logistic (sigmoid) curve used to describe fermentation kinetics, fitted by RaptHooker's own least-squares code (the
  "variable projection" idea of solving the linear parameters exactly is from Golub and Pereyra, 1973). No code was
  copied.

## Backups

- **Amazon Web Services**, [Authenticating requests: AWS Signature Version 4](https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html)
  (Amazon S3 API reference) and the [ListObjectsV2](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html),
  [PutObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html) and
  [DeleteObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObject.html) references: the request signing
  in [src/server/backup/s3.ts](src/server/backup/s3.ts) follows them, and its tests check it against the worked examples
  (with the documentation's example key `AKIAIOSFODNN7EXAMPLE`) on the first page. No AWS SDK code is used.
- The S3-compatible endpoints in [docs/backups.md](docs/backups.md) come from each provider's documentation:
  [Cloudflare R2](https://developers.cloudflare.com/r2/api/s3/api/), [Backblaze B2](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api),
  [Wasabi](https://docs.wasabi.com/) and [MinIO](https://min.io/docs/minio/linux/index.html).
- USB sticks are mounted with systemd's [automount support in fstab](https://www.freedesktop.org/software/systemd/man/latest/systemd.mount.html).
- Backups use SQLite's [online backup API](https://www.sqlite.org/backup.html) through Node.js's `node:sqlite`.

## Alert notifications

The channels in [src/server/channels.ts](src/server/channels.ts) follow each service's own documentation:

- [ntfy: publishing](https://docs.ntfy.sh/publish/) (the `X-Title`, `X-Priority`, `X-Tags` and `X-Click` headers,
  access tokens, and RFC 2047 encoded header values)
- [Pushover Message API](https://pushover.net/api) (form fields and message priorities)
- [Telegram Bot API: sendMessage](https://core.telegram.org/bots/api#sendmessage) (HTML formatting) and
  [@BotFather](https://core.telegram.org/bots/tutorial)
- [Discord webhooks: execute webhook](https://discord.com/developers/docs/resources/webhook#execute-webhook) (embeds
  and allowed mentions)
- Email is sent with [Nodemailer](https://nodemailer.com) (MIT No Attribution); the setup notes link to its
  [SMTP options](https://nodemailer.com/smtp/) and to Google's [app passwords](https://support.google.com/accounts/answer/185833) help.

## Icons and images

- **[Lucide](https://lucide.dev)** (ISC licence: [src/web/public/LICENSE-lucide.txt](src/web/public/LICENSE-lucide.txt)):
  most interface icons in [src/web/app/components/Icon.tsx](src/web/app/components/Icon.tsx) are adapted from Lucide,
  as are the service icons in [src/web/app/pages/alerts/ChannelIcon.tsx](src/web/app/pages/alerts/ChannelIcon.tsx).
- The RaptHooker logo and the pill illustration were drawn for this project.
- Preset badges are standard Unicode emoji, rendered by your device's emoji font.

## Libraries and tools

- Server: [Fastify](https://fastify.dev) with [@fastify/cookie](https://github.com/fastify/fastify-cookie),
  [@fastify/static](https://github.com/fastify/fastify-static) and [@fastify/websocket](https://github.com/fastify/fastify-websocket),
  [dbus-next](https://github.com/dbusjs/node-dbus-next) (talking to BlueZ), [web-push](https://github.com/web-push-libs/web-push),
  [MQTT.js](https://github.com/mqttjs/MQTT.js) (publishing to MQTT brokers and Home Assistant),
  [node-qrcode](https://github.com/soldair/node-qrcode) (MIT; the QR codes of the hub's addresses),
  [Nodemailer](https://nodemailer.com) (email alerts),
  [Zod](https://zod.dev), [pino](https://getpino.io), and Node.js's built-in `node:sqlite`.
- Web app: [React](https://react.dev), [uPlot](https://github.com/leeoniya/uPlot), [Vite](https://vite.dev),
  [vite-plugin-pwa](https://github.com/vite-pwa/vite-plugin-pwa) and [Workbox](https://github.com/GoogleChrome/workbox).
- Build and tests: [TypeScript](https://www.typescriptlang.org), [Vitest](https://vitest.dev), [Testing Library](https://testing-library.com)
  and [happy-dom](https://github.com/capricorn86/happy-dom) (component tests), [Playwright](https://playwright.dev)
  (end-to-end tests), [ESLint](https://eslint.org), [Prettier](https://prettier.io), [tsup](https://github.com/egoist/tsup),
  [tsx](https://tsx.is). The PNG app icons were rendered from the SVG logo with [resvg-js](https://github.com/yisibl/resvg-js).
  [Aedes](https://github.com/moscajs/aedes) runs an MQTT broker inside the MQTT tests (it isn't part of the app).
- On the Pi: [Raspberry Pi OS](https://www.raspberrypi.com/software/), [BlueZ](http://www.bluez.org/), Avahi,
  [systemd](https://systemd.io) (the service, its watchdog and `systemd-notify`),
  [Node.js from NodeSource](https://github.com/nodesource/distributions) and optionally [Tailscale](https://tailscale.com).
- In Docker: the official [Node.js images](https://hub.docker.com/_/node).
- Translations: plural forms follow the [Unicode CLDR plural rules](https://cldr.unicode.org/index/cldr-spec/plural-rules)
  (through the browser's `Intl.PluralRules`). The translations were drafted with AI help; corrections from native
  speakers are welcome.

## Releases, installing and updating

- **[usimd/pi-gen-action](https://github.com/usimd/pi-gen-action)** (MIT) runs **[pi-gen](https://github.com/RPi-Distro/pi-gen)**
  (BSD-3-Clause), the Raspberry Pi OS image builder, to make the experimental Raspberry Pi image. The custom stage in
  [deploy/pi-image](deploy/pi-image) follows pi-gen's stage conventions.
- **[softprops/action-gh-release](https://github.com/softprops/action-gh-release)** (MIT) publishes the GitHub releases,
  with GitHub's own [checkout](https://github.com/actions/checkout), [setup-node](https://github.com/actions/setup-node)
  and [upload-artifact](https://github.com/actions/upload-artifact) actions and the [GitHub CLI](https://cli.github.com).
- **[Renovate](https://github.com/renovatebot/renovate)** keeps the dependencies up to date.
- **[ShellCheck](https://www.shellcheck.net)** checks the shell scripts in CI.
- The changelog follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
  [Semantic Versioning](https://semver.org); RaptHooker's own code compares versions and shows the changelog (no
  library).
- The self-update runs through a [systemd path unit](https://www.freedesktop.org/software/systemd/man/latest/systemd.path.html),
  and checks for releases with GitHub's [REST API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release).
