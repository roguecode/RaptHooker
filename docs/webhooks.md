# Webhooks

✨ **Create UNLIMITED FREE webhooks** ✨

A webhook sends each chosen pill's latest reading to a URL on a schedule. Make as many as you like under **Webhooks**:
pick a preset, fill in your key or ID, and switch it on.

## How sending works

- **One request per pill.** A webhook for "all pills" sends each pill separately (that's what Brewfather and friends
  expect), and includes pills you add later. [Batch mode](#all-pills-in-one-request-batch-mode) sends them together.
- **Frequency.** Each pill is sent at most once per interval, as soon as a new reading arrives after the interval is
  up. Most brewing services accept one reading per device every **15 minutes** and ignore (or reject) more.
- **Only new readings** (on by default) skips a send when the pill hasn't reported since the last one, e.g. while it's
  out of range. With it off, the last reading is resent each interval (up to a day old).
- **Only while a brew is running** keeps quiet when a pill isn't in a brew.
- **Don't send readings that look wrong** (on by default) holds back a reading when the pill doesn't look like it's
  floating: lying on its side, or a gravity no beer could have. It isn't counted as a failure; the webhook's card says
  why nothing was sent.
- **Restarts don't cause floods or repeats.** When each pill was last sent is stored, so after the hub has been off it
  sends the latest reading once rather than everything it missed (unless you ask it to
  [catch up](#catch-up-after-an-outage)).
- **Failures** are retried after 1, 2, 5, 10, 30 and 60 minutes (never more often than the webhook's own interval).
  The delivery log keeps the last 200 attempts with the request and response.
- **Send a test now** sends the preview straight away (it doesn't count as a scheduled send).
- URLs, headers and bodies often contain API keys, so only the owner can see them.

## More options

### Only send when something changes

Tick **Only send when something changes** to hold a reading back unless, since the last one sent for that pill:

- the gravity has moved at least _N_ points (1 point is 0.001 SG: 1.050 → 1.049), **or**
- the temperature has moved at least _N_ degrees (in the webhook's temperature unit).

Leave a box empty to ignore it. **But send at least every** _N_ minutes sends the latest reading anyway after that long
without a send, so the destination knows the pill is still there. The interval still applies as the shortest gap
between sends. While it waits, the webhook's card says what it's waiting for.

### All pills in one request (batch mode)

Some destinations (your own server, Home Assistant, a spreadsheet script) are happier with one request for every pill
than one per pill. Tick **Send all pills in one request**: the body template is filled in for each pill, and the
results go where `{{items}}` is in the **batch body**, separated by commas (JSON) or new lines (plain text).

Body template (for each pill):

```json
{ "name": "{{name}}", "gravity": {{gravity}}, "temperature": {{temperature}}, "time": "{{timestamp}}" }
```

Batch body:

```json
{ "hub": "{{hub_name}}", "count": {{count}}, "readings": [{{items}}] }
```

What's sent:

```json
{
  "hub": "RaptHooker",
  "count": 2,
  "readings": [
    { "name": "Kveik", "gravity": 1.0213, "temperature": 19.6, "time": "2026-10-01T12:00:00.000Z" },
    { "name": "Stout", "gravity": 1.0472, "temperature": 18.9, "time": "2026-10-01T11:58:10.000Z" }
  ]
}
```

- Only for JSON and plain-text bodies (not GET).
- One request per interval, with every pill that has something to send. Each pill's own rules still apply: a pill
  without a new reading, one that looks wrong or one that hasn't changed enough is left out; if none has anything, no
  request is sent.
- The batch body, URL and headers can use `{{items}}`, `{{count}}`, `{{timestamp}}`, `{{timestamp_unix}}`,
  `{{timestamp_ms}}` (when the request is sent), `{{interval}}`, `{{hub_name}}`, `{{app}}` and `{{app_version}}`.
  Pill and reading variables only work in the body template.

### Catch up after an outage

Off by default. When a destination couldn't be reached for a while (it was down, or the hub lost its internet
connection), **Catch up after an outage** sends the readings it missed once it works again:

- oldest first, **one reading per interval** (for each interval with no successful send, the last reading in it),
- at most **10 a minute**, and at most **7 days** back,
- then it carries on as normal.

Readings that look wrong or haven't changed enough (with the options above) are skipped as usual. Time when the
webhook was switched off or paused isn't replayed, and readings are only recorded while the hub is on, so there's
nothing to replay for a power cut.

Templates use each reading's own time (`{{timestamp}}`), so a service that accepts timestamps gets the right history.
**Many don't**: Brewfather, Brewer's Friend, Grainfather and the iSpindel-style services file every reading under the
time it arrives, ignore readings that are older than the last one, or accept only one reading every 15 minutes. Leave
catch-up off for them unless you know they cope. It suits your own server, Home Assistant (with the time from the
payload) and databases.

### Pause

**Pause** stops a webhook sending for an hour, a day or until you **Resume** it; it carries on by itself when the
pause is over. Pills are still recorded meanwhile. The API: `POST /api/webhooks/:id/pause` with
`{ "until": <ms since 1970> }`, or `{ "until": null }` to resume.

### Duplicate, export and import

- **Duplicate** (in the list and the editor) makes a switched-off copy called "… (copy)".
- **Export** downloads every webhook as a JSON file. It includes the URLs, headers and bodies **with their API keys
  and tokens**, so keep it private.
- **Import** adds the webhooks from such a file as new webhooks, **switched off** so you can check them first. Pills
  chosen by id are kept when this hub has them; a choice of pills this hub doesn't have becomes "All pills".

## Templates

The URL, header values and body are templates. `{{variable}}` is replaced by a value; escaping depends on where it is:

| Where             | `{{name}}` with `Hazy "IPA"`                       | Empty value |
| ----------------- | -------------------------------------------------- | ----------- |
| JSON body         | `Hazy \"IPA\"` (put quotes round it: `"{{name}}"`) | `null`      |
| URL / form body   | `Hazy%20%22IPA%22`                                 | empty       |
| Header, text body | `Hazy "IPA"`                                       | empty       |

Numbers go in bare: `"gravity": {{gravity}}`. Give a fallback for values that can be empty with `{{velocity|0}}`
(in JSON the fallback is inserted as written, so `{{brew_name|none}}` inside quotes gives `"none"`).

A webhook can't be switched on while its URL isn't `http(s)://…`, a `<PLACEHOLDER>` from the preset is still there,
a JSON body doesn't parse, or (in batch mode) the batch body has no `{{items}}`. The editor shows the request exactly
as it will be sent.

### Variables

| Variable                                             |                                                                                                |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `name`, `name_slug`                                  | The pill's name, and as `lower-case-with-dashes`                                               |
| `pill_id`, `chip_id`                                 | RaptHooker's id; a number from the last 3 bytes of the Bluetooth address (like an iSpindel ID) |
| `address`, `rapt_id`                                 | Bluetooth address; the MAC address the RAPT app shows                                          |
| `firmware`, `device_type`                            | e.g. `20250319_055542_b3788ba`, `PillG1`                                                       |
| `device`                                             | `pill`, or `thermometer` for a RAPT Bluetooth Thermometer                                      |
| `gravity`, `gravity_unit`, `gravity_label`           | In the webhook's unit; `G` or `P`; `SG` or `°P`                                                |
| `gravity_sg`, `gravity_plato`, `gravity_points`      | Always in that unit (points: 1.0465 → 46.5)                                                    |
| `temperature`, `temp_unit`                           | In the webhook's unit; `C` or `F`                                                              |
| `temperature_c`, `temperature_f`                     | Always in that unit                                                                            |
| `velocity`                                           | Gravity points per day, negative while fermenting (empty until the pill has enough data)       |
| `plausible`                                          | `true` when the pill looks like it's floating, `false` when the reading looks wrong            |
| `pill_gravity_sg`, `pill_velocity`                   | What the pill itself sent, even when RaptHooker works the gravity or velocity out itself       |
| `battery`, `rssi`, `tilt`                            | %, dBm at the hub, degrees from vertical                                                       |
| `accel_x`, `accel_y`, `accel_z`                      | Raw accelerometer                                                                              |
| `timestamp`, `timestamp_unix`, `timestamp_ms`        | When the reading was taken (ISO 8601 UTC, seconds, ms)                                         |
| `age_seconds`, `interval`                            | How old the reading is; the webhook's interval in seconds                                      |
| `brew_id`, `brew_name`, `brew_style`, `brew_started` | The pill's running brew (empty when none)                                                      |
| `brew_og`, `brew_target_fg`                          | In the webhook's gravity unit                                                                  |
| `brew_abv`, `brew_attenuation`, `brew_days`          | So far                                                                                         |
| `hub_name`                                           | This hub's name (Settings)                                                                     |
| `app`, `app_version`                                 | `RaptHooker` and its version                                                                   |

In batch mode the batch body also has `items` and `count` (see [batch mode](#all-pills-in-one-request-batch-mode)).

A RAPT Bluetooth Thermometer only has a temperature and a signal strength: its gravity, velocity, battery, tilt and
accelerometer variables are `null` (empty outside JSON), and it never has a brew. Give a fallback (`{{gravity|0}}`) if
the service you send to needs a number, or pick only pills for that webhook.

## Presets

Every preset is marked **Verified** or **Untested**:

- **Verified** presets have been tried against the real service and work.
- **Untested** presets are built from the service's documentation and other open-source projects (see
  [attribution.md](../attribution.md)), but haven't been tried against the real service yet. Use **Send a test now**
  and check the delivery log; please [report back on GitHub](https://github.com/roguecode/RaptHooker/issues) whether
  it works, so it can be marked verified (or fixed).

| Preset                | Status      | URL                                                                 | Notes                                                                                                                                                                                                                                                        |
| --------------------- | ----------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Brewfather**        | Untested    | `https://log.brewfather.net/stream?id=<LOGGING_ID>`                 | [Custom Stream](https://docs.brewfather.app/integrations/custom-stream): Settings → Power-ups → Custom Stream. Max one post per device name per 15 min. The device is identified by `name`. Its `battery` field is volts, so the pill's % goes in `comment`. |
| **Grainfather**       | Untested    | `http://community.grainfather.com/iot/<DEVICE_ID>/ispindel`         | Add "iSpindel DIY electronic Hydrometer" as equipment in the Grainfather app and copy the id from its Server URL. iSpindel JSON, gravity in °P (Grainfather converts it). 15 min.                                                                            |
| **Brewer's Friend**   | Untested    | `https://log.brewersfriend.com/stream/<API_KEY>`                    | [Device stream API](https://docs.brewersfriend.com/api/stream). One post per 15 min per key and brew session (HTTP 429 otherwise).                                                                                                                           |
| **BrewSpy**           | Untested    | `http://brew-spy.com/api/ispindel`                                  | iSpindel JSON with your hydrometer's token in `token`; one token (and webhook) per pill.                                                                                                                                                                     |
| **Bricks (BierBot)**  | Untested    | `https://brewbricks.com/api/iot/v1`                                 | The [same payload as the RAPT portal integration](https://docs.bierbot.com/hardware/hardware/raptpill), with your API key.                                                                                                                                   |
| **Fermentrack**       | Untested    | `http://<FERMENTRACK_HOST>/ispindel/`                               | iSpindel JSON; name the gravity sensor in Fermentrack like the pill.                                                                                                                                                                                         |
| **Home Assistant**    | Untested    | `http://<HOME_ASSISTANT>:8123/api/webhook/<WEBHOOK_ID>`             | Webhook trigger; use `trigger.json.gravity` etc.                                                                                                                                                                                                             |
| **Ubidots**           | Untested    | `https://industrial.api.ubidots.com/api/v1.6/devices/{{name_slug}}` | `X-Auth-Token` header.                                                                                                                                                                                                                                       |
| **ThingSpeak**        | Untested    | `https://api.thingspeak.com/update.json`                            | Write API key in the body; one channel per pill.                                                                                                                                                                                                             |
| **Discord**           | ✅ Verified | your channel's webhook URL                                          | A short message per reading; pick a long interval.                                                                                                                                                                                                           |
| **Everything (JSON)** | –           | your server                                                         | Every value, nested by pill / reading / brew.                                                                                                                                                                                                                |
| **Custom**            | –           | anything                                                            | Start from scratch.                                                                                                                                                                                                                                          |

The services that take iSpindel-format JSON expect the battery in volts; RAPT Pills report a percentage, which is sent
as it is.

## Reading the data yourself

To pull readings into a script or dashboard instead of pushing them, use the read-only API with an API token: see
[api.md](api.md).
