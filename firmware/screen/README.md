# RaptHooker screen firmware

Firmware for the screens RaptHooker sets up ([docs/rapthooker-screens.md](../../docs/rapthooker-screens.md)). It
shows a picture fetched from the hub, and does everything else (set-up, settings, updates) over a small HTTP API the
hub talks to. One build per model; today that's `sdpro-240`, the "Geekmagic Ultra/Smart weather clock" (ESP8266, 4 MB flash, ST7789
240 × 240).

The built image is committed as [bin/sdpro-240.bin](bin/sdpro-240.bin) (with [bin/sdpro-240.json](bin/sdpro-240.json))
and goes into the hub's bundle, so a release always carries the firmware it was tested with. The hub reads the version
and checks from the image itself.

## Building

Needs [PlatformIO](https://platformio.org/) (`pip install platformio`).

```bash
npm run firmware          # = pio run -d firmware/screen
```

[tools/postbuild.py](tools/postbuild.py) copies the image to `bin/<model>.bin` and refuses it unless it is a complete
DIO image for 4 MB flash with a good checksum and CRC, carries the `RHSCREEN-FW:<model>:<version>` marker, and fits
the stock firmware's update page (at most 0x7C000 bytes: it cuts anything past 512 KB short). Builds are
reproducible: the same source gives the same bytes.

Change [src/version.h](src/version.h) for a new version. `FW_API` goes up only when the HTTP API gains something the hub
needs to know about.

### Image checks on a computer

[src/image.cpp](src/image.cpp) checks an update as it streams in, before anything is committed. It builds and runs on
a computer too:

```bash
cd firmware/screen
python -m ziglang c++ -std=c++17 -O1 -w -Itest/host -o test/host/test_image.exe test/host/test_image.cpp src/image.cpp
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
- **Settings** are JSON with a CRC in the 4 KB sector between the stock file system and EEPROM (0x3FA000), which the
  stock firmware doesn't use: its own files and settings are left alone, so the original firmware can go back. The
  sector is wiped when other firmware is installed, so RaptHooker put on again later starts in set-up mode. Keys a
  newer version wrote are kept when an older one saves.
- **Wi-Fi:** 802.11g by default, switching between g and n by itself when it joins but gets no address (some mesh
  routers). A 169.254 address counts as none. After 5 minutes away from its network it opens its own hotspot,
  `RaptHooker-Screen-XXXXXX`, as well, so it can be given new details, and keeps trying.
- **Picture:** fetched from `imageUrl` every `interval` seconds (or what the hub's `X-Refresh` says), a baseline JPEG
  of the screen's size, at most 64 KB. The picture fills the screen; a line under it explains problems.
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
| `GET`, `POST /api/settings` 🔑          | Reads or changes `name`, `hub`, `imageUrl` (http only), `interval`, `brightness`, `phy`, `txPower`, `token`, `ssid` + `password`; `reboot: true` in the answer when the network changed                                                                                                          |
| `POST /api/ota?size=&md5=[&force=1]` 🔑 | Multipart firmware upload. Without `force` only RaptHooker firmware for this model; `force=1` takes other firmware (the original, to put it back) but still checks it's a whole, valid image                                                                                                     |
| `POST /api/adopt`                       | No body: shows a six-digit code for 120 s (the same one while it's up). `{ code, token, hub, name, imageUrl }`: takes the new key if the code is right. Five wrong tries end a code; ten wrong codes in all and it takes none for 15 minutes (429)                                               |
| `POST /api/identify` 🔑                 | Shows its name for a moment                                                                                                                                                                                                                                                                      |
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

## Installing on a stock screen

The stock firmware's update page (`POST /update_ota`, multipart, on its hotspot at 192.168.4.1) installs whatever it's
sent and cuts anything past 512 KB short, which would leave a screen that can't start. So the hub only sends an image
that has passed the checks above, and only to a screen it has identified as a stock Geekmagic Ultra/Smart weather clock (its `/mac`,
`/config` and set-up page). The stock firmware sometimes restarts before its `OK` gets out: once the whole image has
gone, the hub goes by what comes back (RaptHooker's hotspot, or the stock one again). After the image arrives the screen
copies it into place for about 5 seconds, when it mustn't lose power.
