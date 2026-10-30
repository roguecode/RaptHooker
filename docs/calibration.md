# Where the numbers come from, and calibration

Every number RaptHooker shows, sends and alerts on comes from your pill. By default it's exactly what the pill
works out itself; RaptHooker can work some of them out instead, per pill, if you'd like. Nothing you choose here
changes what's stored: the readings the pill sent are kept as they are, so you can switch back (or compare) any time.

Find the choices on the pill's page, under **Pill settings → Where the numbers come from** (owner only; open Pill
settings from its heading).

## Gravity

- **From the pill (default).** The gravity the pill sends, using its own calibration from the RAPT app.
- **Worked out by RaptHooker from the tilt.** RaptHooker turns the pill's tilt (its angle from vertical) into gravity
  using calibration points you give it (see [Tilt points](#tilt-points)). Use it if your pill's own calibration is off
  and you'd rather calibrate it yourself. It needs at least two points at different tilts first.

The gravity offset (see [Offsets](#offsets)) is added to whichever you choose.

## Velocity

How fast the gravity is moving, in points per day (negative while fermenting).

- **From the pill (default).** The velocity the pill works out itself.
- **Worked out by RaptHooker.** A straight line through the last 6–72 hours of readings (24 by default), leaving out
  any where the pill wasn't floating. Shorter follows changes faster; longer is steadier.

The pill page shows both side by side ("Pill says −3.1 /day · RaptHooker −2.8 /day"), so you can compare before you
switch.

## Smoothing

**Off (default)**, **Light** (gravity averaged over the last hour) or **Strong** (the last 4 hours). It averages out
wobbles from bubbles and knocks, and is used for what's shown, sent to webhooks and MQTT, and alerted on.

To calm a chart down without changing any numbers, use **Smoothing − / +** under the chart instead: it only changes
how the lines are drawn, in this browser (0 shows the readings as they are).

## What changes when you switch

The tiles, the charts (worked out again from the stored readings), brew stats, alerts, webhooks and MQTT all follow
your choice straight away. Whenever RaptHooker's gravity or velocity is in use, the chart also draws the pill's own as
a thin dotted line (tap it in the legend to hide it), and the tiles show what the pill says.

## Readings that look wrong

A pill lying on its side, or out of the liquid, still sends readings, but their gravity is nonsense. RaptHooker flags
readings where the pill doesn't look like it's floating:

- the pill page warns "This reading looks wrong: is the pill floating?";
- charts show them as grey dots, left out of the gravity line;
- they're left out of brew stats, gravity alerts and RaptHooker's velocity and smoothing;
- webhooks and MQTT skip them by default (each has a setting).

## Readings caught

The **Caught** tile shows how many of the readings the pill sent over the last day the hub actually received (from the
interval it has learned). Below about 80%, try the hub, a USB Bluetooth dongle or a relay closer to the fermenter (see
[pi-setup.md](pi-setup.md#7-bluetooth-passive-scanning-usb-dongles-and-relays)).

## Calibration wizard

**Pill settings → Calibration wizard** walks you through three steps. Each stands on its own, so do the ones you need.
The latest reading updates live while the wizard is open; it warns you if the reading is old (the pill may be out of
range) or the pill doesn't look like it's floating.

### Offsets

1. **Water check (gravity offset).** Float the pill in plain tap water at about 20 °C (68 °F), knock off any bubbles
   and wait for 2–3 readings. Water should read 1.000; the wizard shows the offset that makes it so (to 0.0001) and
   sets it for you.
2. **Thermometer (temperature offset).** Put the pill and a thermometer you trust in the same liquid, wait for a
   reading, and type what the thermometer says. The wizard works out the offset.

You can also type offsets in yourself under Pill settings (gravity in points: 1 point = 0.001 SG).

### Tilt points

For gravity worked out from the tilt:

1. Make up a liquid of known gravity (sugar or malt extract in water works) and measure it with a hydrometer or
   refractometer. Plain water is 1.000.
2. Float the pill in it at about 20 °C and wait for a reading or two.
3. Type the gravity you measured and press **Add point**. The point stores the pill's tilt from the latest reading.

Aim for **3–6 points spread from water up to the highest OG you brew**. RaptHooker draws a straight line through two
points, a curve through three, and a cubic through four or more (up to 20 points). The wizard shows the fitted curve
and how far each point is from it; re-measure (or delete) any that are far out. When you're happy, press **Use it** to
switch the gravity to RaptHooker's.
