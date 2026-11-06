# iSpindels

An [iSpindel](https://www.ispindel.de) is a DIY Wi-Fi hydrometer: an ESP8266, an accelerometer and a temperature sensor
in a tube that floats in your fermenter. Every so often it wakes up, sends its reading over your Wi-Fi and goes back to
sleep. RaptHooker takes those readings itself, so an iSpindel is recorded like a pill: dashboard, charts, brews,
calibration, alerts, webhooks, MQTT and Home Assistant, CSV export.

It has been tested with a real iSpindel on firmware 6.5.1, set up both by the hub and by hand. Firmware 7, and other
firmware that sends the same format (such as GravityMon), should work but haven't been tried: please
[report back](https://github.com/roguecode/RaptHooker/issues) if you use one.

## What it needs

- **2.4 GHz Wi-Fi that reaches the hub.** iSpindels can't use 5 GHz. Guest and IoT networks often stop devices on them
  from talking to the rest of your network: the iSpindel joins, but its readings never get to the hub.
- **The hub's IP address**, not `rapthooker.local`: iSpindels can't look up `.local` names. Give the hub a fixed
  address in your router (a DHCP reservation) so it doesn't change.
- **The hub's iSpindel token.** RaptHooker makes one for you. It's shown under **Add device → iSpindel** (to the
  owner) and listed under **Settings → API tokens** as _iSpindels_. It can only post iSpindel readings: it can't read
  anything.

## Adding one

On the dashboard, press **Add device** and open the **iSpindel** tab. An iSpindel that's already sending to the hub
shows at the top, ready to name and add. To set one up, choose **Set it up for me** or **Set it up by hand**.

### Set it up for me

The hub sets the iSpindel up itself, from the iSpindel's setup hotspot, as your phone would. It needs a hub that can
switch Wi-Fi networks, as a Pi can by default (`screens.wifi` in [configuration.md](configuration.md)). A hub that
can't, in Docker say, shows the steps to do it by hand instead.

1. Put the iSpindel in setup mode: press its reset button (twice quickly, on some). For about 5 minutes it opens its
   own open Wi-Fi network, called `iSpindel` (`iSpindel_<its name>` on firmware 7).
2. The hub looks for it every 15 seconds while the tab is open, and once a minute otherwise; **Check again** looks now.
   Pick it when it shows up.
3. Choose the Wi-Fi it should join (the one it uses now, the hub's, or another, with its password), a new name if you
   want one, and how often it sends a reading, and start.

What the hub does then (the tab says so too, and shows each step):

1. It joins the iSpindel's hotspot for about a minute. If Wi-Fi is the hub's only connection, it's off your network
   meanwhile; the page reconnects by itself when it's back.
2. It reads the iSpindel's settings and changes only these: the Wi-Fi network and its password, **Service Type**
   (HTTP), **Server Address**, **Server Port** and **Path / URI** (this hub), **Token**, **Update Interval**, and the
   name if you gave a new one. Its gravity formula, battery conversion factor, temperature unit and everything else stay
   as they are. (Firmware 7 turns its HTTPS and Home Assistant options off by itself for the HTTP service.)
3. It saves them. The iSpindel leaves setup mode, restarts and joins your Wi-Fi.
4. The hub goes back to its own network and waits up to 2 minutes for the first reading, then adds the iSpindel. If
   that reading comes later, the hub still adds it when it does, for the next 2 hours (even if the hub restarts).
   After that, it shows at the top of the tab, to add.

### Set it up by hand

1. Put the iSpindel in setup mode, as above.
2. On your phone, join its network, open `http://192.168.4.1` and choose **Configuration**.
3. Set these, and leave everything else as it is. The tab shows each value for your hub, with a button to copy it.

   | Setting             | Value                                                                    |
   | ------------------- | ------------------------------------------------------------------------ |
   | SSID, Password      | Your Wi-Fi (2.4 GHz)                                                     |
   | Service Type        | HTTP                                                                     |
   | Token               | The hub's iSpindel token                                                 |
   | Server Address      | The hub's IP address, e.g. `192.168.1.20`                                |
   | Server Port         | The hub's port (`8080` on a Pi)                                          |
   | Path / URI          | `/api/ispindel`                                                          |
   | Update Interval (s) | `900` (every 15 minutes) is a good start: shorter wears the battery down |

4. Save. It restarts, joins your Wi-Fi and sends its first reading within a minute: it shows up at the top of the tab,
   to add.

Other firmware that posts the iSpindel's JSON can use the same address. The token can go in the JSON's `token`, in an
`Authorization: Bearer` header or in the address (`?token=`). See [api.md](api.md).

## Its readings

- **Gravity** is what the iSpindel's own formula (its _Polynominal_) gives, turned into SG if it sends °Plato.
  RaptHooker's calibration works on top, as for a pill: an offset, or the [calibration wizard](calibration.md) working
  the gravity out from the tilt.
- **Tilt** and **battery voltage** are kept with every reading. The battery % is estimated from the voltage.
- **Signal** is the iSpindel's Wi-Fi signal, not Bluetooth at the hub.
- **Velocity** is worked out by RaptHooker (an iSpindel doesn't send one).
- A reading taken lying flat or standing up (a tilt over 85° or under 5°), or with a gravity no brew could have, is
  marked as looking wrong, like a pill's that isn't floating.
- A temperature its sensor couldn't read (it says −127 °C) isn't stored.

## When readings don't arrive

- **Look in the hub's log** (Settings → Logs). A post the hub turns away is logged, with why: no token, the wrong
  token, or not a reading.
- **Nothing in the log at all:** the iSpindel isn't reaching the hub. Check the network it's on (2.4 GHz, not a guest or
  IoT one), and the address and port.
- **The Wi-Fi password was wrong:** the iSpindel can't join, so put it in setup mode and set it up again.
- **The first reading is late:** it can take a while after setting up (once, a quarter of an hour). The hub still adds
  the iSpindel when it comes, for 2 hours.
- **Setup mode ran out** without saving (after about 5 minutes): firmware 6.5.1 then sends its next readings with its
  name and token encoded as on its setup page. RaptHooker decodes them, so they still count.
- **The token was deleted** (Settings → API tokens): every iSpindel set up with it stops sending. The hub makes a new
  one; set them up again.

## Trying it without an iSpindel

In development mode (`npm run dev:server` without a config file) the hub has a pretend iSpindel in setup mode, which
**Set it up for me** can set up (it knows the Wi-Fi `Brewery`, password `hops-and-barley`). It then sends a reading
every minute. See [development.md](development.md).
