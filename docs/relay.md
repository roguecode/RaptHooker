# Bluetooth relays (ESP32 + ESPHome)

A RAPT Pill floating in beer, inside a stainless fermenter or a fridge in the garage, can be too far from the Pi to
hear. A **relay** is a small Wi-Fi board near the fermenter that listens for the pill (and RAPT Bluetooth Thermometers)
and passes what it hears on to RaptHooker. You can have as many as you like, alongside the Pi's own Bluetooth: every
reading is still stored once, however many of them hear it.

The relay below is an ESP32 running [ESPHome](https://esphome.io). Anything else that can hear Bluetooth adverts and
make an HTTP request can be a relay too: see [Posting adverts yourself](#posting-adverts-yourself).

> **Untested:** the ESPHome configuration ([esphome-relay.yaml](esphome-relay.yaml)) follows ESPHome's current
> documentation but hasn't been tried on real hardware yet. If it doesn't build or work, please open an issue with the
> error from the ESPHome log.

## What you need

- An **ESP32** board, e.g. a plain "ESP32 DevKit" (ESP32-WROOM). ESP32-S3 and ESP32-C3 boards work with ESPHome too;
  change `board:` to match. (The ESP8266 has no Bluetooth.)
- A USB cable and a USB phone charger to power it where it'll live.
- A computer with ESPHome: `pip install esphome`, or the ESPHome Device Builder (also available as a Home Assistant
  app).

## Set it up

1. **Create a relay token.** In RaptHooker, open **Settings → API tokens**, give the token a name (e.g. "Shed ESP32"),
   choose **Relay** and create it. Copy the token straight away: it's only shown once. A relay token can only post
   adverts; it can't read or change anything.
2. **Make a folder** for the relay with two files:
   - `rapt-relay.yaml`: a copy of [esphome-relay.yaml](esphome-relay.yaml).
   - `secrets.yaml`, with your Wi-Fi and the token (keep the word `Bearer` and the space before the token):

     ```yaml
     wifi_ssid: 'YourWiFi'
     wifi_password: 'your-wifi-password'
     rapthooker_relay_auth: 'Bearer rh_relay_paste-your-token-here'
     ```

3. **Check the two settings** at the top of `rapt-relay.yaml`: `name` is what RaptHooker will call the relay, and
   `rapthooker_url` is where RaptHooker is (`http://rapthooker.local:8080/api/relay`; if the ESP32 can't find
   `rapthooker.local`, use the Pi's IP address instead).
4. **Flash it.** Plug the ESP32 into your computer and run `esphome run rapt-relay.yaml` (or use **Install** in the
   Device Builder). The first time has to be over USB; later updates can go over Wi-Fi.
5. **Watch it work.** The log shows the ESP32 joining Wi-Fi. After the pill's next transmission, the relay appears in
   RaptHooker under **Settings → Bluetooth → Relays**, with when it was last heard and how many adverts it has passed
   on.
6. **Put it near the fermenter**, powered from a USB charger. Settings → Bluetooth also shows how many of each pill's
   readings are being caught: it should climb towards 100% over the next day.

## Troubleshooting

- **"RaptHooker answered 401"** in the ESP32's log: the token is wrong, deleted, or missing the `Bearer ` in front.
- **"Couldn't reach RaptHooker"**: check `rapthooker_url`. Try the Pi's IP address instead of `rapthooker.local`, and
  use `http://` with port 8080 on your home network (not the Tailscale address).
- **Nothing shows up in RaptHooker**: make sure the pill is in Bluetooth mode, and check the ESP32's log for errors.
  The relay only posts when it hears RAPT adverts, so it stays quiet between the pill's transmissions.
- **To stop a relay**, delete its token under Settings → API tokens. A relay that hasn't posted for a day disappears
  from the list.

## Posting adverts yourself

Anything on your network can post adverts it heard to `POST /api/relay`, with a relay token:

```bash
curl -X POST http://rapthooker.local:8080/api/relay \
  -H "Authorization: Bearer rh_relay_..." \
  -H "Content-Type: application/json" \
  -d '{"relay": "shed", "adverts": [{"address": "AA:BB:CC:DD:EE:FF", "rssi": -70,
       "manufacturerData": {"16722": "5054020001bc09485c929b4483d4ae291b3203f79e6400"}}]}'
```

- `relay`: a name for the relay (up to 60 characters).
- `adverts`: 1 to 50 adverts. Each has the Bluetooth `address`, the `rssi` in dBm (or `null`) and `manufacturerData`:
  the company id **in decimal** (`16722` for RAPT's 0x4152, `17739` for 0x454B) mapped to the data **after** the
  company id, in hex. That's how BlueZ presents it, and how [rapt.ts](../src/server/ble/rapt.ts) decodes it. A RAPT
  Bluetooth Thermometer's iBeacon goes under `76` (Apple's 0x004C, starting `02154b6567`). Data under other company ids
  is ignored.
- `ageMs` (optional): how long ago the relay heard the advert, if it collects them before posting. RaptHooker stamps
  readings with the time it receives them otherwise.

The answer is `{"accepted": 1, "ignored": 0}`. Requests without a valid relay token get `401`, bodies over 32 KB
`413`, and a relay posting more than 600 adverts a minute `429`: send each distinct advert once rather than every
repeat (a pill repeats each advert many times during a transmission).
