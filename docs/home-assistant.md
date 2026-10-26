# Home Assistant and MQTT

RaptHooker can publish every reading to an MQTT broker. With **Home Assistant discovery** switched on, each pill shows
up in Home Assistant as a device with gravity, temperature, battery and brew sensors: nothing to write in YAML.

There's also a [webhook option](#without-mqtt-a-webhook) that needs no broker: for automations, or for sensors you
define yourself in YAML.

## Set up MQTT

### 1. A broker

RaptHooker and Home Assistant both connect to an MQTT broker, which passes the readings on. If you already have one
(Mosquitto, EMQX, one on a NAS…), skip to [step 2](#2-home-assistant). Otherwise, how to get one depends on how Home
Assistant is installed. Look in Home Assistant's **Settings** menu for **Apps** (called **Add-ons** before 2026):

- **There's an Apps (or Add-ons) menu:** you have Home Assistant OS. Use [the Mosquitto app](#a-the-mosquitto-app).
- **There isn't:** you have Home Assistant Container (Docker) or Core, which can't install apps. Run Mosquitto
  yourself: [on the RaptHooker Pi](#b-mosquitto-on-the-rapthooker-pi) is the simplest, or
  [in Docker](#c-mosquitto-in-docker) next to Home Assistant. (To be sure which you have: **Settings → System →
  Repairs**, then **⋮ → System information** shows the **Installation type**.)

#### a. The Mosquitto app

1. In Home Assistant open **Settings → Apps → Install app** (**Settings → Add-ons → Add-on store** on older versions),
   find **Mosquitto broker**, install it and start it.
2. Make a login for RaptHooker: **Settings → People → Add person**, turn on **Allow login**, and give it a username
   such as `rapthooker` and a good password. The Mosquitto app accepts Home Assistant logins. Don't use the names
   `homeassistant` or `addons`; they're reserved.
3. Carry on with [step 2](#2-home-assistant). The broker's address for RaptHooker is your Home Assistant's, e.g.
   `mqtt://homeassistant.local:1883`.

#### b. Mosquitto on the RaptHooker Pi

Mosquitto is small and runs happily next to RaptHooker. On the Pi:

```bash
sudo apt install -y mosquitto
# A login for both RaptHooker and Home Assistant (it asks for a password):
sudo mosquitto_passwd -c /etc/mosquitto/passwd rapthooker
sudo chown root:mosquitto /etc/mosquitto/passwd
sudo chmod 640 /etc/mosquitto/passwd
# Listen on the network, logins only:
printf 'listener 1883\nallow_anonymous false\npassword_file /etc/mosquitto/passwd\n' | sudo tee /etc/mosquitto/conf.d/rapthooker.conf
sudo systemctl restart mosquitto
```

The broker's address is then `mqtt://localhost:1883` for RaptHooker and `rapthooker.local`, port `1883` (or the Pi's
IP address), for Home Assistant.

#### c. Mosquitto in Docker

If Home Assistant runs in Docker, Mosquitto can sit next to it. Make a `mosquitto` folder with a
`config/mosquitto.conf` in it:

```text
listener 1883
allow_anonymous false
password_file /mosquitto/config/passwd
persistence true
persistence_location /mosquitto/data/
```

With Docker Compose (as most Home Assistant Container setups use), add it to your `compose.yaml` (or
`docker-compose.yml`):

```yaml
services:
  mosquitto:
    image: eclipse-mosquitto:2
    container_name: mosquitto
    restart: unless-stopped
    ports:
      - '1883:1883'
    volumes:
      - ./mosquitto/config:/mosquitto/config
      - ./mosquitto/data:/mosquitto/data
```

Create the login (it asks for a password), then start it:

```bash
docker compose run --rm mosquitto mosquitto_passwd -c /mosquitto/config/passwd rapthooker
docker compose up -d mosquitto
```

Without Compose, from inside the `mosquitto` folder:

```bash
docker run --rm -it -v "$PWD/config:/mosquitto/config" eclipse-mosquitto:2 mosquitto_passwd -c /mosquitto/config/passwd rapthooker
docker run -d --name mosquitto --restart unless-stopped -p 1883:1883 \
  -v "$PWD/config:/mosquitto/config" -v "$PWD/data:/mosquitto/data" eclipse-mosquitto:2
```

`docker logs mosquitto` should end with `mosquitto version 2… running`. The broker's address for RaptHooker is the
Docker machine's, port `1883`. For Home Assistant it's the same; if Home Assistant runs with `network_mode: host` on
the same machine (the usual way), `localhost` works too.

### 2. Home Assistant

Open **Settings → Devices & services**. With the Mosquitto app, Home Assistant finds the broker by itself: select
**Configure** on the discovered MQTT integration and **Submit**. Otherwise select **Add integration**, choose **MQTT**,
and enter the broker's address, port `1883` and the login from step 1.

### 3. RaptHooker

Open **Settings → MQTT and Home Assistant** in RaptHooker (you need to be the owner):

| Setting                               | What to enter                                                                                               |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Publish readings over MQTT            | On                                                                                                          |
| Broker address                        | From step 1: e.g. `mqtt://homeassistant.local:1883` (Mosquitto app) or `mqtt://localhost:1883` (on this Pi) |
| Username, password                    | The login from step 1                                                                                       |
| Base topic                            | `rapthooker` (change it if you run more than one hub)                                                       |
| Add pills to Home Assistant           | On. Leave the discovery prefix as `homeassistant` unless you changed it in Home Assistant's MQTT options.   |
| Keep the latest reading on the broker | On (retained), so Home Assistant has values straight after it restarts                                      |
| Skip readings that look wrong         | On: a pill lying on its side or out of liquid sends nonsense gravity                                        |

Select **Test connection**, then **Save**. The chip next to the title turns green (**Connected**) and the latest
reading of every pill is published straight away. If something's wrong, the chip says what (wrong password, address
not found, port refused, TLS problem); RaptHooker keeps trying in the background, waiting a little longer each time.

Addresses: `mqtt://` is plain MQTT (usually port 1883), `mqtts://` is MQTT over TLS (usually 8883), and `ws://` /
`wss://` are MQTT over WebSockets. With `mqtts://` the broker's certificate must be trusted by the Pi (self-signed
certificates aren't supported); on your own network plain `mqtt://` is fine.

MQTT problems never affect recording: readings are stored whether or not the broker is reachable.

### 4. In Home Assistant

Each pill appears under **Settings → Devices & services → MQTT → Devices**, named like the pill in RaptHooker, made by
KegLand, and connected through a **RaptHooker** hub device (whose _Connection_ sensor shows whether the hub is online).

| Entity                              | Unit       | Notes                                                                                               |
| ----------------------------------- | ---------- | --------------------------------------------------------------------------------------------------- |
| Gravity                             | (SG)       | The gravity RaptHooker uses (the pill's, or worked out from the tilt if you chose that), 4 decimals |
| Temperature                         | °C         | Home Assistant converts it if you use °F                                                            |
| Gravity velocity                    | points/day | Negative while fermenting                                                                           |
| Battery                             | %          |                                                                                                     |
| Brew                                |            | The running brew's name; unknown when no brew is running                                            |
| Original gravity                    | (SG)       | The brew's OG                                                                                       |
| ABV                                 | %          | The brew's ABV so far                                                                               |
| Attenuation                         | %          | Apparent attenuation so far                                                                         |
| Fermentation stage                  |            | `lag`, `active`, `finishing` or `done`, once RaptHooker can tell                                    |
| Implausible reading                 |            | A _problem_ sensor: on when the pill doesn't look like it's floating                                |
| Signal strength                     | dBm        | Diagnostic                                                                                          |
| Tilt                                | °          | Diagnostic                                                                                          |
| Last reading                        |            | Diagnostic: when the pill last reported                                                             |
| Gravity (Plato)                     | °P         | Off at first: turn it on in the entity's settings if you brew in Plato                              |
| Gravity / velocity sent by the pill |            | Diagnostic and off at first: the pill's own values, when RaptHooker works out its own               |

All entities show as _unavailable_ while the hub is offline. Renaming a pill in RaptHooker renames the device in Home
Assistant (unless you've renamed it there yourself); archiving or removing a pill removes the device. When Home
Assistant restarts, RaptHooker announces everything again as soon as Home Assistant says it's back.

A RAPT Bluetooth Thermometer appears as a _RAPT Bluetooth Thermometer_ device with only **Temperature**, **Signal
strength** and **Last reading**. In its state the gravity, velocity, battery, tilt and brew fields are `null`.

An example automation, a notification when a fermenter gets too warm:

```yaml
alias: Fermenter too warm
triggers:
  - trigger: numeric_state
    entity_id: sensor.myexamplepill_temperature
    above: 22
actions:
  - action: notify.notify
    data:
      message: '{{ trigger.to_state.name }} is at {{ trigger.to_state.state }} {{ trigger.to_state.attributes.unit_of_measurement }}'
```

## Topics and payloads

`<topic>` is the base topic (`rapthooker` by default) and `<pill id>` is the pill's Bluetooth address without the
colons, in lower case (the **What gets published** list in the settings shows each pill's id).

| Topic                                                            | Retained        | What                                                                                |
| ---------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------- |
| `<topic>/status`                                                 | Yes             | `online` while the hub is connected, `offline` when it isn't (its MQTT last will)   |
| `<topic>/<pill id>/state`                                        | If you chose to | Each new reading as JSON (below)                                                    |
| `<topic>/<pill id>/plausible`                                    | If you chose to | `true`, or `false` when the pill doesn't look like it's floating                    |
| `<prefix>/sensor/rapthooker_<pill id>/<object>/config`           | Yes             | Home Assistant discovery for each sensor (and `binary_sensor/…/implausible/config`) |
| `<prefix>/binary_sensor/rapthooker_hub_<host>/connection/config` | Yes             | Home Assistant discovery for the hub device                                         |

RaptHooker listens to `<prefix>/status` for Home Assistant's _birth_ message, and publishes everything again when it
arrives.

An example state:

```json
{
  "name": "MyExamplePill",
  "gravity": 1.0123,
  "gravity_plato": 3.15,
  "temperature": 19.5,
  "velocity": -4.2,
  "battery": 87.5,
  "rssi": -71,
  "tilt": 38.4,
  "plausible": true,
  "pill_gravity": 1.0123,
  "pill_velocity": -4.2,
  "timestamp": "2026-10-24T09:41:00.000Z",
  "brew_name": "Summer pale",
  "og": 1.048,
  "abv": 4.73,
  "attenuation": 74.4,
  "stage": "active"
}
```

| Field                                            | Meaning                                                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `gravity`, `gravity_plato`                       | The gravity in use (SG, 4 decimals) and in °Plato, calibration offsets applied                            |
| `temperature`                                    | °C, offset applied                                                                                        |
| `velocity`                                       | Gravity points per day (from the pill, or RaptHooker's own if you chose that), or `null`                  |
| `battery`, `rssi`, `tilt`                        | Battery %, signal strength at the hub (dBm), angle from vertical (°)                                      |
| `plausible`                                      | `false` when the pill doesn't look like it's floating                                                     |
| `pill_gravity`, `pill_velocity`                  | What the pill itself sent (they differ from the above if RaptHooker works out gravity or velocity itself) |
| `timestamp`                                      | When the reading was taken (UTC)                                                                          |
| `brew_name`, `og`, `abv`, `attenuation`, `stage` | The running brew, or `null` when there's none                                                             |

With **Skip readings that look wrong** on, a reading from a pill that isn't floating isn't published to the state
topic (Home Assistant keeps the last good one), but `<topic>/<pill id>/plausible` still changes to `false` so the
_Implausible reading_ sensor can tell you the pill has fallen over.

To watch everything from a computer with the Mosquitto clients installed:

```bash
mosquitto_sub -h homeassistant.local -u rapthooker -P 'your password' -t 'rapthooker/#' -v
```

The same topics work with anything else that speaks MQTT: Node-RED, Telegraf into InfluxDB, and so on.

## Troubleshooting

- **"The broker turned down the username or password"**: check the login, and that it isn't one of the reserved
  names. After changing it in Home Assistant, save it again in RaptHooker.
- **"Couldn't find …"**: the Pi can't look up that name. Try the IP address of the broker instead.
- **"… refused the connection"**: the broker isn't running, or the port is wrong (1883 for `mqtt://`). A Mosquitto you
  run yourself only accepts other machines with a `listener 1883` line in its config (see step 1).
- **"… closed the connection"** or a TLS message: the port may expect TLS (`mqtts://`), or the other way round.
- **No devices in Home Assistant**: check that _Add pills to Home Assistant_ is on, that MQTT discovery is enabled in
  Home Assistant's MQTT options, and that the discovery prefix matches. Each pill added in RaptHooker (and not
  archived) gets a device as soon as the hub connects.
- **Brew sensors are "unknown"**: no brew is running on that pill. Start one in RaptHooker.

## Without MQTT: a webhook

If you'd rather not run MQTT, the **Home Assistant** webhook preset (✅ verified) sends each reading to a Home
Assistant [webhook trigger](https://www.home-assistant.io/docs/automation/trigger/#webhook-trigger). An automation can
use it straight away, and a few lines of YAML turn it into sensors with history, for dashboards and graphs.

Compared with MQTT, you write the sensors yourself (a block per pill), they're entities without a device, and there
are no brew stage or "implausible reading" sensors. In return there's no broker to run.

### 1. A webhook id

The webhook id goes in the URL, and anyone who knows it can post readings, so make it long and random. Either:

- make one up with `openssl rand -hex 16`, or
- let Home Assistant make one: **Settings → Automations & scenes → Create automation → Create new automation**, then
  **Add trigger → Other triggers → Webhook**. Copy the id it shows, and discard the automation (or keep it, to run an
  automation on every reading as well).

### 2. RaptHooker

Under **Webhooks**, choose **Home Assistant** and set the URL to:

```text
http://<Home Assistant's IP address>:8123/api/webhook/<webhook id>
```

Use Home Assistant's address on your local network (**Settings → System → Network** in Home Assistant), not a Tailscale
name (see [things to know](#things-to-know)). Pick the pills (all of them is fine: each reading says which pill it's
from), set the interval (5 minutes, or 1 to send every reading), switch it on and **Send a test now**.

Each request carries one pill's reading:

```json
{
  "pill": "MyExamplePill",
  "pill_id": "08b61f452f66",
  "gravity": 1.0123,
  "temperature": 19.5,
  "velocity": -4.2,
  "battery": 87.5,
  "rssi": -71,
  "tilt": 38.4,
  "brew": "Summer pale",
  "abv": 4.73,
  "timestamp": "2026-10-24T09:41:00.000Z"
}
```

`pill_id` is the pill's Bluetooth address without the colons, in lower case. It's at the end of the pill page's
address in RaptHooker (`…/#/pill/08b61f452f66`) and never changes, unlike the name. `velocity` and `abv` are `null`
until there's one and `brew` is empty while no brew is running. A RAPT Bluetooth Thermometer only has `temperature`
and `rssi`: its other numbers are `null`.

### 3. Sensors in Home Assistant

1. In `configuration.yaml`, add this line (if there's already a `template:` section, add the blocks below to it instead):

   ```yaml
   template: !include_dir_merge_list templates/
   ```

   Then restart Home Assistant. That's only needed once: after editing the templates later, **Developer tools → YAML →
   Template entities** reloads them.

2. Make a `templates` folder next to `configuration.yaml`, and in it a file such as `rapthooker.yaml` with a block per
   pill. Put in your webhook id and the pill's id, and name the sensors as you like:

   ```yaml
   - triggers:
       - trigger: webhook
         webhook_id: '<webhook id>'
         allowed_methods: [POST]
         local_only: true
     conditions:
       - condition: template
         value_template: "{{ trigger.json is defined and trigger.json.pill_id == '08b61f452f66' }}"
     sensor:
       - name: MyExamplePill gravity
         unique_id: rapthooker_webhook_08b61f452f66_gravity
         state: '{{ trigger.json.gravity }}'
         state_class: measurement
       - name: MyExamplePill temperature
         unique_id: rapthooker_webhook_08b61f452f66_temperature
         state: '{{ trigger.json.temperature }}'
         unit_of_measurement: '°C'
         device_class: temperature
         state_class: measurement
       - name: MyExamplePill velocity
         unique_id: rapthooker_webhook_08b61f452f66_velocity
         state: '{{ trigger.json.velocity }}'
         unit_of_measurement: 'points/day'
         state_class: measurement
       - name: MyExamplePill battery
         unique_id: rapthooker_webhook_08b61f452f66_battery
         state: '{{ trigger.json.battery }}'
         unit_of_measurement: '%'
         device_class: battery
         state_class: measurement
       - name: MyExamplePill ABV
         unique_id: rapthooker_webhook_08b61f452f66_abv
         state: '{{ trigger.json.abv }}'
         unit_of_measurement: '%'
         state_class: measurement
       - name: MyExamplePill last reading
         unique_id: rapthooker_webhook_08b61f452f66_timestamp
         state: '{{ trigger.json.timestamp }}'
         device_class: timestamp
   ```

   The same pattern works for `tilt` (`°`), `rssi` (`dBm`, `device_class: signal_strength`) and `brew` (text: leave out
   the unit and `state_class`). For a thermometer, keep only the temperature (and signal) sensors.

3. Reload the template entities. The sensors fill in with the next reading (or **Send a test now** in RaptHooker).

An automation can use the same webhook id at the same time: give it a **Webhook** trigger with that id, and its
conditions and actions can use `trigger.json.temperature` and so on. Or trigger it from the sensors, with a plain
**Numeric state** trigger like the [example above](#4-in-home-assistant).

### Things to know

- **`local_only: true` turns away Tailscale.** Home Assistant only counts addresses on your local network as local,
  and Tailscale's (`100.x.y.z`) aren't, so readings sent to a Tailscale name are dropped and Home Assistant's log says
  _Received remote request for local webhook_. Use Home Assistant's local IP address in the URL, or set
  `local_only: false` (then the webhook id is all that keeps others out).
- **A delivery that worked in RaptHooker may still have gone nowhere.** Home Assistant answers every webhook request
  with success, even when the id is wrong or no block matched the pill. If the sensors don't update, check the id and
  `pill_id`, and Home Assistant's log.
- **Keep the `rapthooker_webhook_` start to the unique ids.** RaptHooker's MQTT sensors use `rapthooker_<pill id>_…`,
  so the same ids would clash if you ever use both.
- **Entities, not a device.** Template sensors aren't grouped under a device. If you want one per pill, use
  [MQTT](#set-up-mqtt) instead.

The preset and its variables are described in [webhooks.md](webhooks.md).
