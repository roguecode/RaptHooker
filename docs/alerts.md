# Alerts

Alerts tell you when something needs your attention: the beer gets too warm or too cold, it reaches its target
gravity, fermentation slows down or looks finished, a pill's battery is low or a pill goes quiet. Add them under
**Alerts → New alert**, and choose under **Where alerts go** how they reach you.

## Kinds of alert

| Alert                      | Fires when                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Temperature above**      | The temperature goes over the threshold. It clears once it's 0.5 °C below again.                                                       |
| **Temperature below**      | The temperature drops under the threshold. It clears once it's 0.5 °C above again.                                                     |
| **Gravity reaches**        | The gravity drops to the target (it clears if it rises 3 points above it).                                                             |
| **Fermentation stable**    | The gravity has moved less than _N_ points over the window (48 hours unless you change it).                                            |
| **Fermentation slows**     | The gravity drops fewer than _N_ points a day. It clears once it's dropping a point a day faster (or half _N_ faster, if that's less). |
| **Fermentation speeds up** | The gravity drops more than _N_ points a day. It clears once it's dropping a point a day slower (or half _N_ slower, if that's less).  |
| **Battery below**          | The battery drops under the percentage (it clears 5% above it).                                                                        |
| **Pill goes quiet**        | Nothing has been heard from the pill for _N_ minutes.                                                                                  |

A gravity point is 0.001: 1.012 is 12 points above water (1.000), and 1.050 to 1.038 is a drop of 12 points.
"Fermentation slows" and "Fermentation speeds up" go by the pill's velocity, the one its page shows (the pill's own, or
RaptHooker's if you've picked that: see [calibration](./calibration.md)). The threshold is how many points a day the
gravity is dropping, so a velocity of −12 /day is 12 points (0.012) a day, and it has to be more than 0. For example,
"Fermentation slows" at 10 tells you fermentation is nearing its end, so you can plan the next step. A gravity that
isn't dropping at all, or is rising, counts as slower than any threshold. Right after pitching the gravity isn't
dropping yet either, but a velocity can still say it is: a tenth of a point in an hour is 2.4 points a day, and the
velocity can include readings from before the brew. So while a brew is running, both wait until the gravity has dropped
2 points from the brew's OG, and a "Fermentation speeds up" that went off before then clears while the gravity is
within a point of the OG. Either velocity is a trend over hours, so these alerts follow a change a little late, and a
small threshold (a few points a day) can be set off by the pill's normal drift.

As you type a threshold for these alerts and "Fermentation stable", the alert editor says what it means in SG
("Alerts when the gravity drops by less than 0.0005 in a day (that's 1.0500 to 1.0495)", for 0.5), where it clears,
and what else decides when it goes off.

Each alert can watch all pills or just some, and can be limited to **only while a brew is running**. **Don't repeat
for** stops an alert that clears and fires again from notifying you more often than that.

Gravity alerts ignore readings that look wrong: a pill lying on its side out of the beer still sends a gravity worked
out from its tilt, which can be nonsense like 0.2. "Gravity reaches", "Fermentation stable", "Fermentation slows" and
"Fermentation speeds up" wait for a real reading instead. Temperature, battery and "goes quiet" alerts still use those
readings.

## What you get

- **In the app**, always: a pop-up while the app is open, and the **Recent** list on the Alerts page.
- **On the pill's chart**: a mark where each alert went off (**Alert: Too warm**) and where it cleared
  (**OK: Too warm**). **Alerts**, under the chart, hides them in this browser. The hub keeps the latest 500 alerts
  of all the pills, so ones from long ago may no longer be marked.
- **A notification** when an alert fires, sent to the places the alert's **Send to** picks. "Pill goes quiet" also
  tells you when the pill is heard again.
- The notification's title is the alert's name ("Too warm") and the text says what happened ("Kveik is at 24.6 °C,
  above 24.0 °C"), in the hub's units (Settings).

## Where alerts go

Every alert has a **Send to** choice:

- **Everywhere** (the default): browser notifications plus every service under **Where alerts go** that's switched on.
  Services you add later are included.
- Or pick any mix of **Browser notifications** and your services. Pick none and the alert only shows in the app.

Alerts made before services existed send everywhere. Deleting a service takes it out of the alerts that used it.

Each service shows its last result (**Sent** or **Failed**, when, and why). **Test** sends _"RaptHooker test:
notifications from (your hub's name) work"_. Sends to different services happen at the same time, and one failing
doesn't hold up the others. A service that doesn't answer within 10 seconds counts as failed; failed notifications
aren't retried.

How urgent each notification is:

| Service  | Alert fires                   | Pill heard again, and tests  |
| -------- | ----------------------------- | ---------------------------- |
| ntfy     | Priority **high**, ⚠️ tag     | Default priority             |
| Pushover | Priority **1** (high)         | Priority 0 (normal)          |
| Telegram | A message (bold title)        | The same                     |
| Discord  | An amber card from RaptHooker | A green (tests: purple) card |
| Email    | Marked high priority          | Normal                       |

### Browser notifications

Switch them on under **Notifications on this device** on each phone or computer that should get them. They need the
app opened over HTTPS (for example through Tailscale), and on an iPhone the app must be added to the Home Screen first.
The other services work without HTTPS.

### ntfy

[ntfy](https://ntfy.sh) is free and needs no account.

1. Install the ntfy app on your phone (or open ntfy.sh in a browser).
2. Pick a topic name that's hard to guess (**Make one up** in RaptHooker does this) and subscribe to it in the app.
   Anyone who knows the topic can read your alerts.
3. Under **Where alerts go → Add → ntfy**, type the same topic and send a test.

Running your own ntfy server? Change **Server**, and fill in an **access token** (or a username and password) for a
protected topic. RaptHooker posts the text to `<server>/<topic>` with the `X-Title`, `X-Priority` and `X-Tags` headers
([ntfy publishing docs](https://docs.ntfy.sh/publish/)).

### Pushover

[Pushover](https://pushover.net) is a reliable paid app (a one-off purchase per platform after a free trial).

1. Sign up at pushover.net and install the app. Your **user key** is on the dashboard.
2. [Create an application](https://pushover.net/apps/build) (call it RaptHooker) and copy its **API token**.
3. Paste both into RaptHooker and send a test. Fill in **Device** only to send to one of your devices.

High priority (alerts firing) gets past Pushover's quiet hours.

### Telegram

1. In Telegram, talk to [@BotFather](https://t.me/BotFather): send `/newbot` and follow the steps. Copy the **bot
   token** it gives you.
2. Open a chat with your new bot and send it any message (or add the bot to a group).
3. In a browser, open `https://api.telegram.org/bot<your token>/getUpdates` and copy the number after
   `"chat":{"id":`. That's the **chat ID** (group chat IDs start with `-`). For a public channel, use `@channelname`
   and make the bot an admin of the channel.
4. Paste the token and chat ID into RaptHooker and send a test.

### Discord

1. In Discord: **Server Settings → Integrations → Webhooks → New Webhook**.
2. Pick the channel it posts to, then **Copy Webhook URL**.
3. Paste it into RaptHooker and send a test.

Alerts are posted as a card from "RaptHooker". They never ping anyone (`@everyone` and mentions are switched off).

### Email

RaptHooker sends email through your mail provider's SMTP server. Look up its settings; for example Gmail uses
`smtp.gmail.com`, port 587 with STARTTLS (or 465 with TLS), your address as the username and an
[app password](https://support.google.com/accounts/answer/185833).

- **Security**: STARTTLS (usually port 587) or TLS (usually port 465). "None" is only for a mail server on your own
  network.
- **Username** and **password**: leave both empty if the server needs no login.
- **From**: most providers only accept your own address. `RaptHooker <you@example.com>` shows a nicer name.
- **To**: one or more addresses, separated by commas.

## Privacy

Keys, tokens, passwords, ntfy topics, webhook URLs and email addresses are only shown to the owner. Anyone else sees
each service's name and kind and whether its last send worked. Error messages never include keys or tokens. The
settings are kept in the hub's database, so they're in its backups too: keep backups somewhere safe.
