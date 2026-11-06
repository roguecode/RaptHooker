# RAPT Laser Level (experimental)

KegLand's RAPT Laser Level is a keg lid with a laser that measures how far down the beer is. RaptHooker hears it over
Bluetooth and works out how full the keg is from that distance and the keg's size: litres left, and a percentage. It
shows on the dashboard (with a bar), on its own page (with a chart of the volume), in TV mode and on screens, and goes
out through webhooks, MQTT and Home Assistant and CSV export. It has no gravity, so it can't have a brew, but you can
[keg up](#keg-up) the beer that's in it.

Support is **experimental: it hasn't been tried with a real Laser Level yet.** KegLand doesn't publish what it sends.
RaptHooker reads it the way two community projects found it (see [attribution.md](../attribution.md)): YDraig's
[rapt-laser-level-display](https://github.com/YDraig/rapt-laser-level-display) and splitice's
[homeassistant-rapt-keglaser](https://github.com/splitice/homeassistant-rapt-keglaser), checked against captures from
thewolf-oz's [rapt-laser-level](https://github.com/thewolf-oz/rapt-laser-level). If you have one, please
[report back](https://github.com/roguecode/RaptHooker/issues) how it goes, with what it shows next to what the RAPT
app says.

## Adding one

1. Fit it to the keg and switch it on. It sends its reading over Bluetooth all the time.
2. Keep it within range of the hub (or of an [ESP32 relay](relay.md)).
3. On the dashboard, press **Add device** and open the **RAPT Laser Level** tab. Within a minute it shows up. Name it
   and add it.
4. On its page, under **Laser Level settings → The keg**, say how much the keg holds and how far down the beer is when
   it's empty and when it's full. It starts as KegLand's 19 L keg (empty at 560 mm, full at 26 mm); a 9.5 L keg is
   290 mm deep. With the keg empty (or just filled), **It's empty now** (or **It's full now**) takes what it reads at
   that moment.

The hub records it once a minute.

## Its readings

- **Distance**: mm from the sensor down to the beer. This is the only thing stored about the keg.
- **In the keg** (litres) and **Full** (%): worked out from the distance and the keg, assuming straight sides. As only
  the distance is stored, changing the keg's settings changes how full it was everywhere, history included.
- **Temperature**: the sensor's own, in the lid (not the beer's).
- **Battery** and **signal**.

Readings from firmware that doesn't send its temperature (some older firmware sends a shorter advert) aren't recorded:
the hub still lists it to add. Update its firmware in the RAPT app if that happens.

## Keg up

When a beer goes into the keg, press **Keg up** on the Laser Level's page. Its name, style and ABV are all optional; to
save typing, **Fill in from a brew** copies them from any brew (one a pill, iSpindel or Tilt recorded), and you can
still change them. If it was kegged a while ago, tick **It was kegged earlier** and say when.

While it's on tap:

- Its card on the dashboard shows the beer, its ABV and a bar of how much of it is left, with how much went in, is left
  and has been poured, in place of how full the keg is. Its small chart covers the beer from when it was kegged. The
  compact list and TV mode show its name.
- The chart on its page starts at **Kegged**: from when it was kegged up.
- **Went in** is the fullest the keg reads in the 6 hours after you keg up, so it doesn't matter whether you press
  Keg up before or after filling it. After those 6 hours it's kept, even once the readings are tidied away.

When it runs out, press **Keg empty**. It moves to **Earlier kegs** on the same page, where it can be changed or
deleted (deleting one only deletes its name, style and ABV: the readings stay). Kegging up another beer marks the one
before it empty.

## Litres, gallons, pints or your own unit

Once there's a Laser Level, a volume unit appears next to the °C/°F buttons (and in the **⋯** menu on a phone):
**Litres**, **Gallons (US)**, **Pints (UK)**, **Pints (US)** or **Custom**. Like the other units it's only for this
browser. The hub always keeps litres; the rest are worked out from them for showing.

**Custom** counts in each Laser Level's own unit: under **Laser Level settings → Your own unit**, say how big one is in
ml and what it's called (330 ml "cans", say). A Laser Level without one shows litres.
