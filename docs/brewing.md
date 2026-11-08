# Brewing with RaptHooker

A **brew** marks out one batch on one pill: from when you pitch (or whenever you start it, back-dated if you like) to
when you end it. The pill records around the clock either way; a brew just gives that stretch a name, its own chart and
stats, a timeline of what you did, a prediction of where it's heading and a printable summary.

## The gravity a brew uses

Everything below uses the gravity your pill's settings choose: the pill's own gravity or, if you've calibrated the tilt
(pill page → Settings), RaptHooker's gravity from the tilt, with your calibration offset applied. If you turn on
smoothing, the current and final gravity are smoothed the same way as on the pill page.

Readings that don't look right are left out of every brew figure: a pill lying on its side or out of the liquid, or a
gravity no beer could have. They're still recorded, and show faded on the charts.

## Original gravity (OG)

If you type in an OG (when you start the brew, or later with **Edit**), that's the one used.

Otherwise RaptHooker takes it from the pill:

1. It finds the brew's first good reading: the moment the pill went into the wort.
2. It skips the next hour. A pill that has just been dropped in can read high or low while it settles, and bubbles
   cling to it.
3. The OG is the **median** of the good readings from the end of that hour to **three hours** after the pill went in.
   The median ignores the odd wild reading.

During the first hour the OG shown is the median of the first few readings, so there's something to see straight
away; it settles on its final value three hours in.

The pill's own starting gravity is kept even when you type in an OG (`startGravity` in the API): "Fermentation starts"
and the velocity alerts measure from it, as a hydrometer's OG can be a few points off the pill's (see
[Alerts](./alerts.md#steps-in-a-brew)).

## ABV and attenuation

The ABV formula is a hub setting (**Settings → Hub**), used everywhere: the pill and brew pages, the summary, and
finished brews (their ABV is worked out again if you change the formula).

| Formula            | ABV                                           | Notes                                                    |
| ------------------ | --------------------------------------------- | -------------------------------------------------------- |
| Standard (default) | (OG − FG) × 131.25                            | The usual homebrew formula; fine up to about 7–8%.       |
| Alternative        | 76.08 × (OG − FG) / (1.775 − OG) × FG / 0.794 | Stays accurate for strong beers, barley wines and meads. |

While a brew ferments you see the **ABV so far** (from the OG and the current gravity). It becomes the **final ABV**
once the gravity has stopped moving or the brew has ended. "Stopped moving" means:

- the gravity changed by less than **1 point (0.001)** over the last **48 hours** of readings,
- there are at least **24 hours** of readings, and
- the gravity is at least 2 points below the OG (so a brew that hasn't started yet doesn't count as finished).

**Apparent attenuation** is how much of the sugar the yeast has used, as the hydrometer sees it:
(OG − gravity) / (OG − 1).

## Predictions and stages

A fermentation's gravity usually follows an S-shaped curve: a slow start while the yeast gets going, a steep drop,
then a long slow finish. RaptHooker fits that curve (a four-parameter logistic) to the brew's readings so far:

    gravity(t) = FG + (OG − FG) / (1 + e^(k·(t − t_mid)))

where `t_mid` is when it's halfway and `k` how steep the drop is. From the curve it shows:

- **Stage**:
  - _Lag phase_: the gravity hasn't started dropping yet.
  - _Fermenting_: dropping fast.
  - _Finishing_: slowing down, under a quarter of its fastest rate.
  - _Done_: the gravity has stopped moving (see above).
- **Predicted FG**: where the curve levels off. If you've set a target FG it's shown next to it.
- **Expected finish**: when the gravity should be within a point of the predicted FG.
- **Confidence**: _low_ until the curve has turned (before then the FG is mostly a guess, nudged towards your target FG,
  or 75% attenuation without one), _medium_ once most of the drop is in, _high_ when it's nearly there and the
  readings follow the curve closely.

How it's done, for the curious: readings are reduced to hourly medians (left out: implausible readings and the first
hour), the curve is fitted by least squares with sensible bounds, then fitted again without readings far off the
first curve. A running brew is refitted at most every 10 minutes (it's a Pi), and once more when it ends; the result is
saved with the brew.

There's no prediction until the brew has **12 hours** of readings.

### Limits

The prediction is a guide, not a promise. Check the gravity really has stopped before you package.

- Early on (before the steepest part of the drop) the predicted FG can be well off. Watch the confidence.
- Anything that changes the readings without changing the beer throws it a little: dry hops and fruit nudging the pill,
  krausen or yeast sitting on it, CO₂ bubbles, a big temperature change, a cold crash.
- Ferments that don't follow one S-curve won't fit well: a diacetyl rest that restarts activity, adding sugar or fruit
  part way, staggered nutrient additions in meads, or mixed and wild fermentations.

## Events

Note what you did and when: **dry hop**, **temperature change**, **cold crash**, **addition** (yeast nutrient, fruit,
finings…) or a plain **note**. Add them with **Add event** on the pill page or the brew's page (the time defaults to
now and can be changed). They appear on the brew's timeline, as markers on the charts and in the summary. Only the
owner can add, change or delete them; deleting a brew (or removing its pill) deletes its events too.

Something that lasts a while, like a dry hop sitting in the fermenter for a few days, can have an end: **Add an end
time** in the event. It can be in the future, for one you've planned (dry hop until Monday), or added later, when you
take the hops out. The charts shade the time in between, and the timeline says how long it lasts.

### Planned events and reminders

A running brew's events can be planned ahead: a dry hop on day 3, a cold crash next Monday. Pick a time still to come;
the timeline marks the event **Planned** (with a dashed icon) and the charts show it once its time comes. Tick **Remind
me at its start and end** and the hub notifies you when its time comes, and again at its end if it has one (see
[Alerts](./alerts.md#reminders-of-planned-events)). A finished brew's events are history, so they can't be in the
future.

To keep a busy chart clean, the eye next to an event on the timeline takes it off the charts (the brew's, the pill's
and the summary's) and puts it back. It stays on the timeline, marked _Not on the chart_. The hub remembers it, so
every device shows the same.

## Alerts for this brew

A brew can have alerts of its own, watching it alone from the moment it starts: when fermentation gets going, a gravity
or attenuation to dry hop at, a day to take a sample. Add them under **Alerts for this brew** on the brew's page; they
stop when the brew ends and are deleted with it. Alerts that went off during the brew are marked on its chart (the
**Alerts** chip under the chart hides them). See [Alerts](./alerts.md#alerts-for-one-brew).

## Profiles

Like a RAPT Pill profile, a **profile** is a set of alerts and planned events for a kind of brew, timed from its start
(fermentation starts, dry hop at 50% attenuation, a reminder to dry hop on day 3 and take the hops out on day 6, cold
crash on day 10), that a brew can start with:

- **New profile**, under **Profiles** on the **Brews** page, makes one from scratch: give it a name, then **Add alert**
  (any kind, edited as a brew's own alerts are) and **Add event** (what, on which **day of the brew**, lasting some days
  if you like, and whether it reminds you). Day 1 is the brew's first 24 hours, so a dry hop on day 3 is planned 2 days
  after the start.
- **Save as a profile** on a brew's page, under **Alerts for this brew**, keeps that brew's own alerts and its events,
  each at the same time after the start (not the notes alerts made, which say what happened in that brew). Tick
  **Remind me of its events** to have every event remind you in brews started with it. Save a new profile, or one in
  place of an existing profile.
- **Start a brew** has a **Profile** choice when there are profiles: its alerts are added to the brew, and its events
  are planned from the brew's start. A brew started earlier (back-dated) gets the events whose time has passed too,
  without reminders for them.
- **Use a profile** on a running brew's page adds a profile's alerts and planned events to it, timed from its start.
- The **Brews** page lists the profiles: what's in each, and (for the owner) **Edit** to rename one, change its notes,
  add, change or take out its alerts and events, switch reminders on or off, and delete. An event saved from a brew
  keeps its time of day unless you change its day. Deleting a profile leaves the brews started with it as they are.

## Comparing brews

On the **Brews** page, tap **Compare** and pick two to eight brews, running or finished. Their gravity curves are drawn
on one chart by **days since each brew started**, each in its own colour, with each brew's OG, FG and ABV in the
legend. Tap **Temperature** to add their temperatures (dashed). Hover or tap the chart to read every brew's value on the
same day, in a box beside the pointer and in the legend. The address (`#/brews?compare=…`) keeps your pick, so you can
bookmark a comparison.

## Batch summary

Each brew has a one-page summary (**Summary** on the brew's page, or `#/brew/<id>/summary`): name, style, dates and
length, OG, FG, ABV (naming the formula), attenuation, temperatures, the timeline, your notes and a chart sized for a
page.

- **Print / Save as PDF** opens the browser's print dialog; the page prints dark-on-white without the app around it.
  Pick "Save as PDF" as the printer to keep a file.
- **Copy summary** copies it as plain text, ready for a forum post, a message or your recipe software.

## API

Everything above is in the hub's HTTP API too (reading is open to anyone who can see the app; changes need the owner):

| Method and path                                                  | What it does                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/brews`, `GET /api/brews/:id`                           | Brews with their stats (`og`, `startGravity`, `abv`, `finalAbv`, `stable`, `prediction`…) and events                                                                                                                                                                                |
| `POST /api/brews`                                                | Start one: `{ "pillId": "…", "name": "Hazy IPA" }`, with `og`, `targetFg`, `style`, `notes`, `startedAt` (unix ms, in the past) and `profileId` (a profile it starts with) if you like                                                                                              |
| `GET /api/brews/:id/events`                                      | A brew's events, oldest first                                                                                                                                                                                                                                                       |
| `POST /api/brews/:id/events`                                     | Add one: `{ "at": <unix ms>, "kind": "dry_hop", "text": "100 g Citra" }`, with `"endAt": <unix ms>` if it lasts a while, `"hidden": true` to leave it off the charts, `"remind": true` to be reminded when it starts and ends (a running brew's start and end can be in the future) |
| `PUT /api/brews/:id/events/:eventId`                             | Change one (same body; leaving out `endAt`, `hidden` or `remind` keeps what's saved)                                                                                                                                                                                                |
| `DELETE /api/brews/:id/events/:eventId`                          | Delete one                                                                                                                                                                                                                                                                          |
| `GET /api/brews/:id/alerts`                                      | The brew's own alerts, each with `active` and `lastFiredAt`                                                                                                                                                                                                                         |
| `POST /api/brews/:id/alerts`                                     | Add one: an alert rule's body without `pillIds` and `onlyDuringBrew` (`name`, `kind`, `threshold`, and `message`, `channelIds`… as on the Alerts page), e.g. `{ "name": "Dry hop", "kind": "attenuation_reached", "threshold": 50, "message": "Add 100 g Citra" }`                  |
| `PUT`/`DELETE /api/brews/:id/alerts/:alertId`                    | Change or delete one                                                                                                                                                                                                                                                                |
| `POST /api/brews/:id/profile`                                    | Add a profile's alerts and planned events to a running brew: `{ "profileId": "…" }`                                                                                                                                                                                                 |
| `GET /api/brew-profiles`, `GET /api/brew-profiles/:id`           | Profiles: `{ "name", "notes", "alerts": [brew alerts' bodies], "events": [{ "offset": <ms from the start>, "endOffset": <ms or null>, "kind", "text", "remind" }] }`                                                                                                                |
| `POST /api/brew-profiles`, `PUT`/`DELETE /api/brew-profiles/:id` | Save, change or delete one                                                                                                                                                                                                                                                          |
| `GET /api/brews/compare?ids=a,b,c`                               | Up to 8 brews' gravity and temperature by hours since each started (≤ 400 points each)                                                                                                                                                                                              |

Event kinds: `dry_hop`, `temp_change`, `cold_crash`, `addition`, `note`. Each event has `endAt` (null for a moment),
`hidden` (left off the charts) and `remind` (reminds you when it starts and ends).
