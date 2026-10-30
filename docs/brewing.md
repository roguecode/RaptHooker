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

## Comparing brews

On the **Brews** page, tap **Compare** and pick two to eight brews, running or finished. Their gravity curves are drawn
on one chart by **days since each brew started**, each in its own colour, with each brew's OG, FG and ABV in the
legend. Tap **Temperature** to add their temperatures (dashed). Hover or tap the chart to read every brew's value on the
same day. The address (`#/brews?compare=…`) keeps your pick, so you can bookmark a comparison.

## Batch summary

Each brew has a one-page summary (**Summary** on the brew's page, or `#/brew/<id>/summary`): name, style, dates and
length, OG, FG, ABV (naming the formula), attenuation, temperatures, the timeline, your notes and a chart sized for a
page.

- **Print / Save as PDF** opens the browser's print dialog; the page prints dark-on-white without the app around it.
  Pick "Save as PDF" as the printer to keep a file.
- **Copy summary** copies it as plain text, ready for a forum post, a message or your recipe software.

## API

Everything above is in the hub's HTTP API too (reading is open to anyone who can see the app; changes need the owner):

| Method and path                         | What it does                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /api/brews`, `GET /api/brews/:id`  | Brews with their stats (`og`, `abv`, `finalAbv`, `stable`, `prediction`…) and events   |
| `GET /api/brews/:id/events`             | A brew's events, oldest first                                                          |
| `POST /api/brews/:id/events`            | Add one: `{ "at": <unix ms>, "kind": "dry_hop", "text": "100 g Citra" }`               |
| `PUT /api/brews/:id/events/:eventId`    | Change one (same body)                                                                 |
| `DELETE /api/brews/:id/events/:eventId` | Delete one                                                                             |
| `GET /api/brews/compare?ids=a,b,c`      | Up to 8 brews' gravity and temperature by hours since each started (≤ 400 points each) |

Event kinds: `dry_hop`, `temp_change`, `cold_crash`, `addition`, `note`.
