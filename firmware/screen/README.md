# RaptHooker screen firmware

Firmware for the screens RaptHooker sets up ([docs/rapthooker-screens.md](../../docs/rapthooker-screens.md)). It
shows a picture fetched from the hub, and does everything else (set-up, settings, updates) over a small HTTP API the
hub talks to. One source, one build per model (`RH_MODEL`, a PlatformIO environment each):

| Model            | Env     | Board                                                                        | Installed                     |
| ---------------- | ------- | ---------------------------------------------------------------------------- | ----------------------------- |
| `sdpro-240`      | `sdpro` | "Geekmagic Ultra/Smart weather clock": ESP8266, 4 MB flash, ST7789 240 × 240 | Over the stock firmware's OTA |
| `esp32-2432s028` | `cyd`   | ESP32-2432S028 ("Cheap Yellow Display"): ESP32, 4 MB flash, 320 × 240        | Over USB, with esptool        |

The chips differ in the platform layer ([src/platform.cpp](src/platform.cpp): crash counting, roll-back, HMAC, system
details) and in `#if defined(ESP8266)` / `ESP32` blocks in place (Wi-Fi, mDNS, web server, updates, the settings
sector); the boards in [src/hw.h](src/hw.h) (pins, screen size, panel set-up).

The built images are committed in [bin/](bin) (`<model>.bin`, with `<model>.json`; for ESP32 boards also
`<model>.boot.bin`, below) and go into the hub's bundle, so a release always carries the firmware it was tested with.
The hub reads the version and checks from the image itself.

## Building

Needs [PlatformIO](https://platformio.org/) (`pip install platformio`).

```bash
npm run firmware          # = pio run -d firmware/screen: every model
```

[tools/postbuild.py](tools/postbuild.py) copies the image to `bin/<model>.bin` and refuses it unless it carries the
`RHSCREEN-FW:<model>:<version>` marker and:

- ESP8266: is a complete DIO image for 4 MB flash with a good checksum and CRC, and fits the stock firmware's update
  page (at most 0x7C000 bytes: it cuts anything past 512 KB short);
- ESP32: is a DIO image for the ESP32 with its SHA-256 appended (and right), and fits the app partition (0x1E0000). It
  also writes `bin/<model>.boot.bin`: the flash from 0x1000 to 0x10000 for the first install over USB, with the boot
  loader, the partition table ([partitions-esp32.csv](partitions-esp32.csv)), an empty NVS, and OTA data that starts
  `app0`.

Builds are reproducible: the same source gives the same bytes. The `cyd-crashtest` environment (not built by default,
and not copied to `bin/`) crashes 20 s after it starts, to check on a board that a bad update is taken back.

Change [src/version.h](src/version.h) for a new version. `FW_API` goes up only when the HTTP API gains something the hub
needs to know about.

### Image checks on a computer

[src/image.cpp](src/image.cpp) checks an update as it streams in, before anything is committed. It builds and runs on
a computer too:

```bash
cd firmware/screen
python -m ziglang c++ -std=c++17 -O1 -w -DESP8266 -Itest/host -o test/host/test_image.exe test/host/test_image.cpp src/image.cpp
test/host/test_image.exe bin/sdpro-240.bin [stock.bin]
```

The hub has the same checks in TypeScript (`src/server/screens/firmware.ts`).

### Trying a screen by hand

[tools/screenctl.mjs](tools/screenctl.mjs) talks to a screen directly: `identify` and `flash-stock` for a stock screen
on its hotspot, `info`, `setup`, `settings`, `ota` and `call` for one running this firmware. `BIND=192.168.4.x` sends
from that address (a second Wi-Fi adapter on the screen's hotspot). On Windows, pass JSON as `@file.json`.

## How it behaves

- **Start-up:** Wi-Fi and the web server come first, so a screen can always be updated, then the display. After three
  crashes in a row it starts in safe mode (no picture fetching) until it has run well for six minutes or is updated.
- **Updates on the ESP32** start on trial: the new firmware stays (`esp_ota_mark_app_valid_cancel_rollback`) once it's
  on the network and has drawn a picture (or after six minutes with a way in), or before a restart it was asked for. If
  it crashes first, or hasn't managed within 10 minutes, the boot loader goes back to the firmware it replaced (the
  ESP32 keeps both, in `app0` and `app1`).
- **Settings** are JSON in a 4 KB sector: `"RHS1"`, the length and a CRC-32 (each 4 bytes, little-endian), then the
  JSON. On the ESP8266 it's the sector between the stock file system and EEPROM (0x3FA000), which the stock firmware
  doesn't use: its own files and settings are left alone, so the original firmware can go back. On the ESP32 it's the
  start of the `rhscreen` partition (0x3D0000), where the hub writes it over USB. The sector is wiped when other
  firmware is installed, so RaptHooker put on again later starts in set-up mode. Keys a newer version wrote are kept
  when an older one saves.
- **Wi-Fi:** 802.11g by default on the ESP8266 (b/g/n on the ESP32), switching between g and n by itself when it joins
  but gets no address (some mesh routers), or when the router turns it away before it joins for 10 s (some only take
  802.11n). A 169.254 address counts as none. After 5 minutes away from its network it
  opens its own hotspot, `RaptHooker-Screen-XXXXXX`, as well, so it can be given new details, and keeps trying. For the
  first minutes it logs `net: still joining <ssid>: <why>` every 15 s, for whoever watches the serial port.
- **Picture:** fetched from `imageUrl` every `interval` seconds (or what the hub's `X-Refresh` says), a baseline JPEG
  of the screen's size, at most 64 KB (160 KB on the ESP32). The picture fills the screen; a line under it explains
  problems.
- **Button:** pressing it (on an ESP32 board, tapping the screen or pressing BOOT) shows the details for 30 s.
- **Panels (ESP32 boards):** the panel's controller differs from batch to batch. At start-up the firmware reads its ID
  and picks a profile (set-up, MADCTL and inversion for landscape with the USB socket on the right): `8181b3` (seen on
  2026 boards: it ignores row/column exchange after the ILI9341 set-up, so it gets a minimal one), `st7789` (85 85 52),
  else `ili9341`. The `panel` setting turns (1), mirrors (2), swaps red and blue (4) or inverts (8) on top.
- **mDNS:** `rh-screen-xxxxxx.local`, and service `_rhscreen._tcp` with TXT `id`, `model`, `fw`, `api`, `hub` and
  `claimed` (`1` once a hub has given it a key).

## HTTP API (level 1)

Port 80, JSON, CORS open (`Access-Control-Allow-Origin: *`) so a browser can set a screen up. Request bodies need a
`Content-Length` (the web server can't read chunked bodies). Once a screen has a key (`token`), the calls marked 🔑 need
`Authorization: Bearer <token>`; before that, anyone on its hotspot may set it up.

| Call                                    | What                                                                                                                                                                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/info`                         | Everything about it: `firmware` (`"rapthooker-screen"`), `version`, `api`, `model`, `id`, `mac`, `hostname`, `name`, `hub`, `claimed`, `state`, `features`, `wifi`, `image`, `display`, `setup`, `system`. With `?challenge=` (16–64 characters) a screen that has a key adds `proof`: see below |
| `POST /api/setup` 🔑                    | `{ ssid, password, token, hub, name, imageUrl, interval, brightness, channel }`: tries the network while keeping its hotspot (moved to `channel` first). 202                                                                                                                                     |
| `GET /api/setup`                        | How the try is going: `{ trial: idle/testing/connected/failed, error, ip, saved, channel }`                                                                                                                                                                                                      |
| `POST /api/setup/finish` 🔑             | Restarts on the network it joined                                                                                                                                                                                                                                                                |
| `GET`, `POST /api/settings` 🔑          | Reads or changes `name`, `hub`, `imageUrl` (http only), `interval`, `brightness`, `phy`, `txPower`, `token`, `ssid` + `password`, `panel` (with `panel` in `features`); `reboot: true` in the answer when the network changed                                                                    |
| `POST /api/ota?size=&md5=[&force=1]` 🔑 | Multipart firmware upload. Without `force` only RaptHooker firmware for this model; `force=1` takes other firmware (the original, to put it back) but still checks it's a whole, valid image                                                                                                     |
| `POST /api/adopt`                       | No body: shows a six-digit code for 120 s (the same one while it's up). `{ code, token, hub, name, imageUrl }`: takes the new key if the code is right. Five wrong tries end a code; ten wrong codes in all and it takes none for 15 minutes (429)                                               |
| `POST /api/identify` 🔑                 | Shows its name for a moment                                                                                                                                                                                                                                                                      |
| `POST /api/test-pattern` 🔑             | With `test-pattern` in `features`: colour bars and words to check the panel by, for `{ seconds }` (default 60; 0 ends it)                                                                                                                                                                        |
| `POST /api/refresh` 🔑                  | Fetches a new picture now                                                                                                                                                                                                                                                                        |
| `POST /api/reboot` 🔑                   | Restarts                                                                                                                                                                                                                                                                                         |
| `POST /api/reset` 🔑                    | Forgets its settings and restarts in set-up mode                                                                                                                                                                                                                                                 |
| `GET /api/scan` 🔑                      | Wi-Fi networks it can see: `{ networks: [{ ssid, rssi, channel, bssid, open }] }`                                                                                                                                                                                                                |
| `GET /api/log` 🔑                       | Its recent log, as text                                                                                                                                                                                                                                                                          |

Picture requests carry `X-Screen-Id` (the id), `X-Screen-Firmware` (`<model>/<version>`) and `X-Screen-Status`
(`rssi=…;up=…;heap=…;fail=…`), which is how the hub knows a screen is alive without asking it.

### The key

The hub gives a screen its key at set-up (on the screen's own hotspot) or adoption (with the code it shows). After
that the hub only sends the key to an address that has proved it has it: it asks `GET /api/info?challenge=<random>`,
and the screen answers with `proof`, the hex HMAC-SHA256 of `rhscreen-proof:<id>:<challenge>` keyed with the key. So a
faked picture request or mDNS answer can't have the hub send the key somewhere else. Firmware with `proof` in its
`features` has to prove it every time once it has; older firmware is taken at its word until it's updated.

### Compatibility

Later firmware only adds: new fields in answers, new calls, new names in `features`. Nothing that a level offered
changes meaning or goes away, so the hub can talk to older and newer screens alike, checking `api` or `features` before
using anything newer. Unknown fields in requests are ignored.

`display` has `width` and `height`, and with `panel` in `features` the `controller` ID, the `profile` picked and the
`panel` corrections. `system` has `chip` (`esp8266`, `esp32`), and on the ESP32 `partition` and `trial` (new firmware not
yet kept).

## Over USB

Sent `?RHSCREEN` on a line of its own (at 115200 baud), the firmware answers on a line of its own with `RHSCREEN-ID `
and JSON: `id`, `model`, `fw`, `name`, `hub`, `claimed`, `state` and, when it's on the network, `ip`. Never the key.
The hub asks the boards on its USB this to tell its screens from new boards, opening the port without restarting the
board: on Linux both DTR and RTS stay raised as opening the port left them (dropping either one first trips the boards'
auto-reset wiring), and on Windows both stay low.

## Installing on an ESP32 board over USB

The hub runs esptool (at 230400 baud: the boards' CH340 drops bytes faster) to read the board's chip, MAC and flash
size, then writes in one go: `<model>.boot.bin` at 0x1000, `<model>.bin` at 0x10000 and a settings sector at 0x3D0000
with the Wi-Fi details, key, hub and picture address. It then restarts the board (RTS) and reads its serial log at
115200: `RHSCREEN-FW:<model>:<version>` (it started), `net: online <ip>` (it joined), or the reasons it can't
(`wrong password`, `network not found`). Finally it finds the screen at that address (or by mDNS) and has it prove it
has the key.

| Partition  | Offset   | Size     |                                                    |
| ---------- | -------- | -------- | -------------------------------------------------- |
| `nvs`      | 0x9000   | 0x5000   | Wi-Fi calibration                                  |
| `otadata`  | 0xE000   | 0x2000   | Which app starts, and whether it's on trial        |
| `app0`     | 0x10000  | 0x1E0000 | Firmware                                           |
| `app1`     | 0x1F0000 | 0x1E0000 | Firmware (updates alternate)                       |
| `rhscreen` | 0x3D0000 | 0x20000  | RaptHooker's settings (the first 4 KB)             |
| `coredump` | 0x3F0000 | 0x10000  | The last crash (read it with esptool, espcoredump) |

The layout is written only at set-up and never changes after: every later firmware has to fit `app0`/`app1`.

## Installing on a stock screen

The stock firmware's update page (`POST /update_ota`, multipart, on its hotspot at 192.168.4.1) installs whatever it's
sent and cuts anything past 512 KB short, which would leave a screen that can't start. So the hub only sends an image
that has passed the checks above, and only to a screen it has identified as a stock Geekmagic Ultra/Smart weather clock (its `/mac`,
`/config` and set-up page). The stock firmware sometimes restarts before its `OK` gets out: once the whole image has
gone, the hub goes by what comes back (RaptHooker's hotspot, or the stock one again). After the image arrives the screen
copies it into place for about 5 seconds, when it mustn't lose power.
