# Read-only API

Everything the web app shows comes from a small JSON API on the hub. Scripts, dashboards (Grafana, a spreadsheet,
Home Assistant's REST sensor...) can read it too.

## Tokens

Viewing is open to anyone on your network, so a script on your LAN can read without a token. Use an **API token**
when you want a script to identify itself, or when the hub is reached in ways where open viewing isn't wanted.

Create one under **Settings → API tokens** (owner only). There are two kinds:

| Kind      | Can                                                                                                                                                        |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Read**  | Read pills, readings, brews and the rest of the read-only API. It can't change anything, and sees secrets (webhook URLs and keys) hidden, like any viewer. |
| **Relay** | Only post Bluetooth adverts from a relay (see [relay.md](relay.md)). It can't read anything.                                                               |

The token (`rh_read_…` or `rh_relay_…`) is shown **once**, when it's created; the hub only keeps a hash of it. Lost
it? Delete it and make another. The list shows when each token was last used. Deleting a token stops it working
straight away.

Send it in the `Authorization` header:

```bash
HUB=http://rapthooker.local:8080
TOKEN=rh_read_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
curl -H "Authorization: Bearer $TOKEN" $HUB/api/pills
```

| Response | Why                                                                                                  |
| -------- | ---------------------------------------------------------------------------------------------------- |
| `401`    | The token is unknown or has been deleted (a wrong token is refused rather than treated as a viewer). |
| `403`    | A read token tried to change something (only `GET` is allowed), or a relay token tried to read.      |

## Endpoints

All times are milliseconds since 1970 (UTC). Gravity is SG and temperature °C, whatever units the app shows. Each pill
has a `kind`: `"pill"`, or `"thermometer"` for a RAPT Bluetooth Thermometer, whose readings have only a `temperature`
and `rssi` (the rest is `null`).

| Endpoint                                                 | What                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/pills`                                         | Every pill with its settings, latest reading (`live.latest`) and running brew                                                                                                                                                                                                                                         |
| `GET /api/state`                                         | Pills, pills heard nearby, the Bluetooth status and whether the clock is set                                                                                                                                                                                                                                          |
| `GET /api/pills/:id/history?from=&to=&points=`           | Readings between `from` and `to` as columns (`ts`, `gravity`, `temperature`, `velocity`, `battery`, `rssi`, `tilt`, `implausible`); averaged into at most `points` (10–4000, default 800). With `&exclude=1`, the pill's excluded ranges (below) are left out of averages, smoothing and velocity and come back empty |
| `GET /api/pills/:id/export.csv?from=&to=`                | Every reading as CSV                                                                                                                                                                                                                                                                                                  |
| `GET /api/brews?pill=`                                   | Brews, newest first, optionally for one pill                                                                                                                                                                                                                                                                          |
| `GET /api/brews/:id`                                     | One brew with its stats (OG, gravity, ABV, attenuation...)                                                                                                                                                                                                                                                            |
| `GET /api/brews/:id/events`                              | Dry hops, temperature changes and notes logged on a brew                                                                                                                                                                                                                                                              |
| `GET /api/brews/:id/export.csv`                          | The brew's readings as CSV                                                                                                                                                                                                                                                                                            |
| `GET /api/brews/compare?ids=a,b`                         | Gravity and temperature curves of up to 8 brews, by time since each started                                                                                                                                                                                                                                           |
| `GET /api/alerts/rules`, `GET /api/alerts/events?limit=` | Alert rules and what they've fired                                                                                                                                                                                                                                                                                    |
| `GET /api/webhooks`                                      | Webhooks and how they're doing (URLs, headers and bodies hidden)                                                                                                                                                                                                                                                      |
| `GET /api/settings/hub`                                  | The hub's name and default units                                                                                                                                                                                                                                                                                      |
| `GET /api/status`                                        | Version, start time, database size, backups, disk space and warnings                                                                                                                                                                                                                                                  |
| `GET /api/session`                                       | Who you are to the hub (`"via": "token"` for a token)                                                                                                                                                                                                                                                                 |
| `GET /api/live` (WebSocket)                              | Live updates: a `hello` with everything, then `reading`, `pill`, `brew`, `webhook`... messages as they happen                                                                                                                                                                                                         |
| `GET /api/image.png`, `GET /api/pills/:id/image.png`     | A picture of every pill, or of one, for a small screen; also `.jpg` and `.bmp`. Its size, look and contents are in the query: see [screens.md](./screens.md#whats-in-the-link)                                                                                                                                        |

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
instead. Only the charts change: the readings, brew stats, alerts, webhooks and exports stay as they were, and the
history leaves them out only when asked to (`exclude=1`). The ranges are in each pill's `exclusions` (`id`, `from`,
`to`, `createdAt`), oldest first.

| Endpoint                                        | What                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `POST /api/pills/:id/exclusions`                | `{ "from": <ms>, "to": <ms> }` leaves that range out (joining any it overlaps); the pill |
| `DELETE /api/pills/:id/exclusions/:exclusionId` | Puts a range back on the charts; the pill                                                |
