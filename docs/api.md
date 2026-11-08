# API

Everything the web app shows comes from a small JSON API on the hub. Scripts, dashboards (Grafana, a spreadsheet,
Home Assistant's REST sensor...) can read it too. Changes need the owner: see [Changing things](#changing-things).

## Tokens

Viewing is open to anyone on your network, so a script on your LAN can read without a token. Use an **API token**
when you want a script to identify itself, or when the hub is reached in ways where open viewing isn't wanted.

Create one under **Settings → API tokens** (owner only), as a **Read** or a **Relay** token. The hub makes a third
kind itself, for iSpindels:

| Kind         | Can                                                                                                                                                                                                         |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Read**     | Read pills, readings, brews and everything else a viewer can see. It can't change anything, and sees secrets (webhook URLs and keys) hidden, like any viewer.                                               |
| **Relay**    | Only post Bluetooth adverts from a relay (see [relay.md](relay.md)). It can't read anything.                                                                                                                |
| **iSpindel** | Only post readings from [iSpindels](ispindel.md) (`POST /api/ispindel`). It can't read anything. The hub makes this one itself, and keeps it so the owner can see it again under **Add device → iSpindel**. |

A read or relay token (`rh_read_…` or `rh_relay_…`) is shown **once**, when it's created; the hub only keeps a hash of
it. Lost it? Delete it and make another. The iSpindel token starts `rh_ispindel_…`. The list shows when each token was
last used. Deleting a token stops it working straight away.

Send it in the `Authorization` header:

```bash
HUB=http://rapthooker.local:8080
TOKEN=rh_read_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
curl -H "Authorization: Bearer $TOKEN" $HUB/api/pills
```

| Response | Why                                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------------------- |
| `401`    | The token is unknown or has been deleted (a wrong token is refused rather than treated as a viewer).        |
| `403`    | A read token tried to change something (only `GET` is allowed), or a relay or iSpindel token tried to read. |

## Endpoints

All times are milliseconds since 1970 (UTC). Gravity is SG and temperature °C, whatever units the app shows.

Every device is a "pill" in the API, with a `kind` that says what it is and what its readings have. Whatever a device
doesn't measure is `null`.

| `kind`        | Device                             | Its readings have                                                                                                                                |
| ------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pill`        | RAPT Pill                          | `gravity`, `temperature`, `velocity`, `battery`, `rssi`, `tilt` and the accelerometer (`x`, `y`, `z`)                                            |
| `thermometer` | RAPT Bluetooth Thermometer         | Only `temperature` and `rssi`                                                                                                                    |
| `ispindel`    | [iSpindel](ispindel.md)            | What a pill's have, plus `voltage` (its battery, V; `battery` is the charge estimated from it), but no `x`, `y`, `z`. `rssi` is its Wi-Fi signal |
| `tilt`        | [Tilt](tilt.md)                    | `gravity`, `temperature`, `velocity` and `rssi`. No `battery`, `tilt` or `x`, `y`, `z`                                                           |
| `laser-level` | [RAPT Laser Level](laser-level.md) | `distance` (mm down to the beer), `fill` (%) and `volume` (litres), `temperature` (the sensor's own), `battery` and `rssi`. No gravity           |

`voltage` is only there for iSpindels, and `distance`, `fill` and `volume` only for Laser Levels: on other readings
they're missing or `null`. The history only has a `distance` column for a Laser Level.

A Laser Level's `fill` and `volume` are worked out from `distance` and its `vessel` (`capacity` litres, `emptyMm`,
`fullMm`), which the owner sets with `PATCH /api/pills/:id` (`{ "vessel": { ... } }`). A Laser Level also has a `keg`:
the beer kegged up under it (below), or `null`, and a `servingUnit`: its own unit for showing how much is left
(`{ "ml": 330, "name": "cans" }`, set the same way), or `null`. Other kinds don't have either.

A device that hasn't been added yet but is heard nearby (`nearby` in `/api/state`) has a `name` if it says its own
(iSpindels do).

| Endpoint                                                 | What                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/pills`                                         | Every pill with its settings, latest reading (`live.latest`) and running brew                                                                                                                                                                                                                                                |
| `GET /api/state`                                         | Pills, pills heard nearby, the Bluetooth status and whether the clock is set. The Bluetooth status's `state` is `starting`, `scanning`, `error`, `unavailable`, `mock` (simulated) or `off` (switched off, with `offBy`: `settings` or `config`)                                                                             |
| `GET /api/pills/:id/history?from=&to=&points=`           | Readings between `from` and `to` as columns (`ts`, `gravity`, `temperature`, `velocity`, `battery`, `rssi`, `tilt`, `implausible`); averaged into at most `points` (10–4000, default 800). With `&exclude=1`, the pill's excluded ranges (below) are left out of averages, smoothing and velocity and come back empty        |
| `GET /api/pills/:id/export.csv?from=&to=`                | Every reading as CSV                                                                                                                                                                                                                                                                                                         |
| `GET /api/brews?pill=`                                   | Brews, newest first, optionally for one pill                                                                                                                                                                                                                                                                                 |
| `GET /api/brews/:id`                                     | One brew with its stats (OG, gravity, ABV, attenuation...)                                                                                                                                                                                                                                                                   |
| `GET /api/brews/:id/events`                              | Dry hops, temperature changes and notes logged on a brew, and ones planned (`remind`: it reminds you when it starts and ends)                                                                                                                                                                                                |
| `GET /api/brews/:id/alerts`                              | The brew's own alerts (see [brewing.md](./brewing.md#api))                                                                                                                                                                                                                                                                   |
| `GET /api/brews/:id/export.csv`                          | The brew's readings as CSV                                                                                                                                                                                                                                                                                                   |
| `GET /api/brews/compare?ids=a,b`                         | Gravity and temperature curves of up to 8 brews, by time since each started                                                                                                                                                                                                                                                  |
| `GET /api/brew-profiles`                                 | Brew profiles: alerts and planned events a brew can start with                                                                                                                                                                                                                                                               |
| `GET /api/alerts/rules`, `GET /api/alerts/events?limit=` | Alert rules and what they've fired, newest first (up to 500; with `&pillId=`, only that pill's). Reminders of planned events are among the events, with a `ruleId` of `reminder:<event id>`                                                                                                                                  |
| `GET /api/webhooks`                                      | Webhooks and how they're doing (URLs, headers and bodies hidden)                                                                                                                                                                                                                                                             |
| `GET /api/settings/hub`                                  | The hub's name, default units, the decimals readings are shown with (`decimals`: `sg`, `plato`, `temperature`), ABV formula, whether it checks for updates (`updateCheck`) and whether it listens over Bluetooth (`bluetooth`)                                                                                               |
| `GET /api/status`                                        | Version, start time, database size, backups, disk space and warnings                                                                                                                                                                                                                                                         |
| `GET /api/session`                                       | Who you are to the hub (`"via": "token"` for a token)                                                                                                                                                                                                                                                                        |
| `GET /api/live` (WebSocket)                              | Live updates: a `hello` with everything, then `reading`, `pill`, `brew`, `webhook`... messages as they happen                                                                                                                                                                                                                |
| `GET /api/image.png`, `GET /api/pills/:id/image.png`     | A picture of every device, or of one, for a small screen; also `.jpg` and `.bmp`. Its size, look and contents are in the query: see [screens.md](./screens.md#whats-in-the-link)                                                                                                                                             |
| `GET /api/screens`, `GET /api/screens/:id`               | The hub's [screens](./rapthooker-screens.md): name, model, MAC and IP address, the pill each shows (`pillId`, `null` for all), look, `interval`, `brightness`, `firmware` and `status` (`state` is `online`, `late`, `offline` or `unknown`; also when it last fetched its picture, its signal, a firmware `update` waiting) |
| `GET /api/screens/:id/image.jpg`                         | The picture a screen shows, as it gets it                                                                                                                                                                                                                                                                                    |

## Examples

The latest gravity and temperature of every pill (with [jq](https://jqlang.org)):

```bash
curl -s -H "Authorization: Bearer $TOKEN" $HUB/api/pills \
  | jq '.[] | {name, gravity: .live.latest.gravity, temperature: .live.latest.temperature, at: .live.latest.ts}'
```

The last 24 hours of one pill, at most 200 points:

```bash
NOW=$(date +%s000)
curl -s -H "Authorization: Bearer $TOKEN" \
  "$HUB/api/pills/<PILL_ID>/history?from=$((NOW - 86400000))&to=$NOW&points=200"
```

A pill's readings as CSV:

```bash
curl -s -H "Authorization: Bearer $TOKEN" -o readings.csv "$HUB/api/pills/<PILL_ID>/export.csv"
```

Live updates from the WebSocket (with [websocat](https://github.com/vi/websocat)):

```bash
websocat -H "Authorization: Bearer $TOKEN" ws://rapthooker.local:8080/api/live
```

A Home Assistant REST sensor:

```yaml
sensor:
  - platform: rest
    name: Fermenter gravity
    resource: http://rapthooker.local:8080/api/pills
    headers:
      Authorization: Bearer rh_read_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
    value_template: '{{ value_json[0].live.latest.gravity }}'
    scan_interval: 300
```

To push readings somewhere instead, use [webhooks](webhooks.md) (or MQTT).

## Changing things

Everything that changes something (adding pills, brews, webhooks, settings) needs the owner: signed in with the PIN in
the app, or through Tailscale. Tokens can't do it. Owner-only extras for webhooks:

| Endpoint                                            | What                                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET /api/webhooks/export`                          | Every webhook, **with its secrets**, as a file for **Import**                                              |
| `POST /api/webhooks/import`                         | Adds the webhooks from an export, switched off                                                             |
| `POST /api/webhooks/:id/pause`                      | `{ "until": <ms> }` pauses until then; `{ "until": null }` resumes                                         |
| `POST /api/webhooks/:id/duplicate`                  | A switched-off copy                                                                                        |
| `GET`, `POST /api/tokens`, `DELETE /api/tokens/:id` | List, create (`{ "name": "Grafana", "scope": "read" }`, the response has the token once) and delete tokens |

A pill's charts can leave out ranges of its history (a knock while adding hops, say) and draw a curve through them
instead; so do the pictures for screens (`/api/image.png` and the like). Only the charts change: the readings, brew stats,
alerts, webhooks and exports stay as they were, and the history leaves them out only when asked to (`exclude=1`). The
ranges are in each pill's `exclusions` (`id`, `from`, `to`, `createdAt`), oldest first.

| Endpoint                                        | What                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `POST /api/pills/:id/exclusions`                | `{ "from": <ms>, "to": <ms> }` leaves that range out (joining any it overlaps); the pill |
| `DELETE /api/pills/:id/exclusions/:exclusionId` | Puts a range back on the charts; the pill                                                |

A beer kegged up under a [Laser Level](laser-level.md#keg-up) is a keg: `id`, `pillId`, `name`, `style`, `abv` (% or
`null`), `brewId` (the brew it was filled in from, or `null`), `keggedAt`, `endedAt` (`null` while it's on tap),
`createdAt` and `startVolume` (litres that went in: the fullest it read in the 6 hours after `keggedAt`, or `null` until
there's a reading). Listing them works with a token; the rest needs the owner. The live updates send `keg` and
`keg-removed` messages.

| Endpoint                 | What                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/kegs?pill=`    | Kegs, newest first, optionally for one Laser Level                                                                                                                     |
| `GET /api/kegs/:id`      | One keg                                                                                                                                                                |
| `POST /api/kegs`         | `{ "pillId": "...", "name": "...", "style": "...", "abv": 5.2, "brewId": null, "keggedAt": <ms> }` (all but `pillId` optional) kegs one up, emptying the one before it |
| `PATCH /api/kegs/:id`    | Changes any of those, or `endedAt`                                                                                                                                     |
| `POST /api/kegs/:id/end` | Marks it empty (`{ "at": <ms> }`, or now)                                                                                                                              |
| `DELETE /api/kegs/:id`   | Deletes it; the readings stay                                                                                                                                          |

[Screens](./rapthooker-screens.md) are set up and looked after by the owner:

| Endpoint                                                       | What                                                                                                                                                      |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/screens/wifi`, `POST /api/screens/wifi/scan`         | Whether the hub can switch Wi-Fi networks to set a screen up (`canSetUp`, `reason`, its own `ssid`, `channel` and `band`...), and the networks it can see |
| `POST /api/screens/setup`, `GET /api/screens/setup`            | `{ hotspot, ssid, password, name, pillId, look }` starts setting a screen up (an empty `password`: the hub's own); then how it's going                    |
| `GET /api/screens/usb`                                         | Whether the hub can set boards up over USB (`canSetUp`, `reason`, `esptool`), and its serial ports (`path`, `name`, `vid`, `pid`, `likely`)               |
| `POST /api/screens/usb/setup`                                  | `{ port, model, ssid, password, name, pillId, look }` starts setting up a board on the hub's USB; follow it like `/api/screens/setup`                     |
| `GET /api/screens/found`, `POST /api/screens/discover`         | RaptHooker screens on the network that the hub doesn't have; `discover` looks again                                                                       |
| `POST /api/screens/adopt`                                      | `{ id }` has a found screen show a code; `{ id, code, name }` adds it                                                                                     |
| `POST /api/screens/manual`, `POST /api/screens/manual/done`    | Setting a screen up from a browser: a key and picture address for it, then `{ pending, id, model, ip }` once it's on the network                          |
| `GET /api/screens/firmware/:model`                             | The firmware the hub has for a model (headers `X-Firmware-Version` and `X-Firmware-Md5`)                                                                  |
| `PATCH /api/screens/:id`                                       | `{ name, pillId, look, interval, brightness, panel }`, any of them (`panel`: display corrections, for boards that have them); the screen                  |
| `POST /api/screens/:id/identify`, `/refresh`, `/reboot`        | Shows its name for a moment, fetches a new picture now, restarts                                                                                          |
| `POST /api/screens/:id/test-pattern`                           | Shows the test pattern for a minute (boards with display corrections)                                                                                     |
| `POST /api/screens/:id/update`, `POST /api/screens/update-all` | New firmware for one screen (the screen, once it's back with it), or for every one that needs it (`{ updated, failed }`)                                  |
| `GET /api/screens/:id/log`                                     | The screen's recent log, as text                                                                                                                          |
| `POST /api/screens/:id/restore`                                | The screen's original firmware file as the body (`application/octet-stream`): checked, sent to the screen, and the screen forgotten                       |
| `DELETE /api/screens/:id?reset=1`                              | Forgets a screen; with `reset=1` it also forgets its Wi-Fi and opens its own network for setting up again                                                 |

A set-up's progress says `via` (`wifi` or `usb`) and, while installing over USB, `percent`. Set-up progress and screens
found on the network also come as live messages (`screen-setup`, `screens-found`), and
changes to a screen as `screen` and `screen-removed`.

[iSpindels](./ispindel.md) post their readings themselves; adding them and setting them up is the owner's:

| Endpoint                                              | What                                                                                                                                                                                                                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/ispindel`                                  | An iSpindel's reading, as its HTTP service sends it (JSON with `name`, `ID`, `token`, `angle`, `temperature`, `temp_units`, `battery`, `gravity`, `interval`, `RSSI`). Needs the iSpindel token: in `token`, a `Bearer` header or `?token=`              |
| `GET /api/ispindel`                                   | What setting one up needs: the `token` (owner only), the address to send to (`server`: `host`, `hosts`, `port`, `path`), whether the hub can switch Wi-Fi networks (`wifi`), iSpindels in setup mode nearby (`hotspots`) and the owner's current `setup` |
| `POST /api/ispindel/scan`                             | Looks for iSpindels in setup mode now, and keeps looking every 15 seconds for the next minute and a half: `{ hotspots, scannedAt }`                                                                                                                      |
| `POST /api/ispindel/setup`, `GET /api/ispindel/setup` | `{ hotspot, ssid, password, name, interval }` starts setting one up from its hotspot (an empty `ssid`: the network it has; an empty `name`: its own); then how it's going (`step`, `state`, `error`, `written`, `deviceId`)                              |
| `DELETE /api/ispindel/setup/:id`                      | How that set-up ended has been shown: the hub stops offering it (it otherwise keeps it for 15 minutes, for a page that missed the end)                                                                                                                   |

An iSpindel that posts with the token is listed under `nearby` until it's added with `POST /api/pills` like any other
device (its address is `ISPINDEL:` and its chip id in hex). Hotspots seen and set-up progress also come as live messages
(`ispindel-hotspots`, and `ispindel-setup` for the owner).
