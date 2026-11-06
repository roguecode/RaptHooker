# Tilt hydrometers (experimental)

A [Tilt](https://tilthydrometer.com) is a Bluetooth hydrometer that floats in your fermenter and sends its gravity and
temperature every few seconds. Each colour of Tilt (red, green, black, purple, orange, blue, yellow, pink) is told apart
by what it sends. RaptHooker records a Tilt like a pill: dashboard, charts, brews, calibration, alerts, webhooks, MQTT
and Home Assistant, CSV export.

Support is **experimental: it hasn't been tried with a real Tilt yet.** What a Tilt sends is well known (Tilt's own apps
and Home Assistant's Tilt integration read it the same way), so it should work. If you have one, please
[report back](https://github.com/roguecode/RaptHooker/issues) how it goes.

## Adding one

1. Put the Tilt in your fermenter, or a jug of water. It sends its reading over Bluetooth every few seconds.
2. Keep it within range of the hub (or of an [ESP32 relay](relay.md): relays pass Tilts on too).
3. On the dashboard, press **Add device** and open the **Tilt** tab. Within a minute it shows up by its colour ("Found
   Tilt Red nearby"). Name it (or keep its colour as its name) and add it.

The hub records it once a minute. A Tilt Pro, which sends one more digit of gravity and temperature, is recognised by
itself.

## Its readings

- **Gravity** is what the Tilt sends (SG, or SG to 4 decimals from a Tilt Pro). A calibration you set in Tilt's own app
  isn't in what it sends, so calibrate it in RaptHooker: a gravity offset under its settings, or the calibration
  wizard's water check.
- **Temperature** is sent in °F; RaptHooker stores °C like everything else.
- **Velocity** is worked out by RaptHooker (a Tilt doesn't send one).
- A Tilt sends no tilt angle and no battery level, so it has neither.
- A reading with a gravity no brew could have is marked as looking wrong, like a pill's.
- Now and then a Tilt sends a temperature of 999 that isn't a reading: it's left out.

Its id, like a pill's, comes from its Bluetooth address. Two Tilts of the same colour can both be added.
