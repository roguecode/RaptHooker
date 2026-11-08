# Keeping people's data

People record real brews with RaptHooker, some of them for years. An update must never lose, change or orphan any of
it: not the readings, not the brews, not the settings, not the things people have set up around the hub (Home
Assistant, webhooks, scripts using the API). This page is the checklist for any change to how things are stored,
identified or sent, and for adding a new kind of device.

**Any release, either way.** People switch between releases in both directions: the installer puts the previous version
back if an update doesn't start, owners try a [beta](./updating.md#trying-a-beta) and go back to the release, or move
from one beta to another. So every release has to keep working with the data that any other release has left, older or
newer, and then hand it on again, with nothing lost or changed whichever order they run in. That's not left to care:
the [tests](#tests) run every published release against what the current code leaves, and nothing is released that
fails them. If a change can't be made that way, stop and ask.

## Where the data is

Everything is in one SQLite database, `/var/lib/rapthooker/rapthooker.db` on a Pi (see [db.ts](../src/server/db.ts)):

| Table                                             | What                                                                                                                                                                                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pills`                                           | Every device you've added (pills, thermometers, iSpindels, Tilts, Laser Levels and any kind to come), with its settings as JSON. "Pill" in table and column names means any device. |
| `readings`                                        | Every reading, one row per device and time. Raw readings older than `rawRetentionDays` are deleted.                                                                                 |
| `rollups`                                         | 15-minute sums of the readings. Once raw readings are deleted they're the only history left, so they're as precious as the readings.                                                |
| `brews`, `brew_events`, `brew_alerts`             | Brews, their timelines and their own alerts.                                                                                                                                        |
| `brew_profiles`                                   | Profiles: alerts and planned events a brew can start with, as JSON.                                                                                                                 |
| `webhooks`, `webhook_state`, `webhook_deliveries` | Webhooks, how far each has got, and their recent deliveries.                                                                                                                        |
| `alert_rules`, `alert_state`, `alert_events`      | Alerts.                                                                                                                                                                             |
| `channels`, `push_subs`, `api_tokens`             | Notification channels, browsers with notifications on, API tokens.                                                                                                                  |
| `screens`                                         | [Screens](./rapthooker-screens.md) the hub has set up, by MAC address, with their settings (and the key the hub gave each) as JSON.                                                 |
| `meta`                                            | Hub settings (as JSON) and bookkeeping.                                                                                                                                             |

Outside the database: `rapthooker.config.json`, the push keys, and the backups (see [Backups](./backups.md)).

## The database

- **Only through migrations.** A schema change is a new entry at the end of `MIGRATIONS` in
  [db.ts](../src/server/db.ts). Never edit, reorder or remove one that has been released (`git tag` lists the
  releases). All the migrations an update brings run in one transaction, so if any of them fails nothing changes.
- **Betas are releases.** A published beta's migrations can't change either, and every later version, betas included,
  has to have them in the same place. A beta that changes the schema is cut from `main` with its migrations merged
  there first; two betas never each add a different migration with the same number. `npm test`
  ([compatibility.test.ts](../src/server/test/compatibility.test.ts)) compares `MIGRATIONS` with every release tag.
- **The database knows its migrations.** Each version notes a hash of every migration it runs (`migrationHashes` in
  `meta`, by number). A version whose migration of that number is different (a development build's, before it was
  changed and released) refuses the database instead of taking the migration as done (`checkCompatible`), so it never
  runs on a schema it doesn't understand; the installer then puts the previous version back.
- **A copy first.** Before upgrading an existing database the hub keeps a copy of it (`pre-update-<time>.db` in the
  data folder, the last 3, listed under Settings → Backups as **From before an update**). If the copy can't be made,
  the database isn't upgraded and the hub doesn't start. If the upgrade fails, the copy is deleted again, as the
  database is as it was.
- **Add, don't change.** New tables, and new columns that allow NULL or have a DEFAULT. Never drop or rename a table
  or column that holds people's data, and never change what a column means or its unit (°C, SG, milliseconds since
  1970, dBm, percent).
- **Rebuilding a table** (SQLite can't drop `NOT NULL` or change a column's type) copies every row, in one migration:
  `CREATE TABLE x_vN (...)`, `INSERT INTO x_vN (...) SELECT ... FROM x` with no `WHERE`, `DROP TABLE x`,
  `ALTER TABLE x_vN RENAME TO x`. Migration 4 is an example.
- **Every older release must still work on the upgraded database**, as people go back to them and they record with
  their own SQL. A new column needs a default that's right for the rows an older version writes without knowing
  the column. The rollups' `*_missing` counts are an example: counting the readings that lacked a measurement, rather
  than those that had it, keeps a bucket right when an older version adds a pill's reading (which has everything).
  For a measurement no older version ever records (an iSpindel's `tilt` and `voltage`, a Laser Level's `distance`),
  it's the other way round: the rollups count the readings that had it (`tilt_n`, `voltage_n`, `distance_n`), so a row
  an older version adds rightly counts as having none of them.
- **Never shut older versions out.** `minSchema` in `meta` (`MIN_SCHEMA_KEY`) makes versions that don't know that many
  migrations refuse the database. No migration and no code may set it (a test checks): people must always be able to
  go back. Versions still honour it, in case a build ever did, and refuse rather than damage the data.
- **What a device doesn't measure is NULL**, never a made-up 0. A new kind of measurement is a new nullable column in
  `readings`, plus a sum and a `<name>_missing` count in `rollups` (see migration 4), or a `<name>_n` count if older
  versions never record it (migrations 6 and 7), written in `Store.addReading` and averaged in `Store.history` and
  `Store.prunedRollups`. Store what the device measured, not what's worked out from it with settings that can change:
  a Laser Level's readings keep the distance, and how full the keg was comes from its `vessel` when shown.
- **Size.** Migrations run while the hub starts, and the installer gives an update 60 seconds to answer. Go over
  `readings` once at most: copying a million readings takes a couple of seconds on a PC and up to half a minute on a
  Pi. A rebuilt table leaves the old one's space unused in the file (and in every backup): the hub compacts the
  database about ten minutes after an upgrade, when that's worth it and there's room (databases up to 1 GB).
- **Flags.** `readings.flags` bit 1 is `FLAG_IMPLAUSIBLE`. Bit 2 was used by development builds; new flags get new
  bits.

## Devices

- **Identity.** A device's id is worked out from its address (`pillIdFromAddress`) and is used everywhere: readings,
  brews, webhook and alert state, MQTT topics and Home Assistant's unique ids, links. Never change how an existing
  device's id or address is worked out, or its history is orphaned and Home Assistant gets duplicates.
- **Kinds.** Each device's settings have a `kind` (`DeviceKind`: `pill`, `thermometer`, `ispindel`, `tilt`,
  `laser-level`). A new kind of
  device gets a new value. Existing devices keep theirs; settings saved without one are pills. A version that doesn't know a kind
  lists the device but records nothing for it and doesn't change its kind.
- **One set of tables.** A new kind's readings go in `readings` and `rollups` like everything else, with NULL for what
  it doesn't measure, so history, retention, backups and exports work for it without anything new.
- **Decoding.** Adding a decoder must not change how existing devices' broadcasts are decoded: the captured payloads
  (`CAPTURED` in [helpers.ts](../src/server/test/helpers.ts)) must decode exactly as before. Add captures from the new
  device (`CAPTURED_ISPINDEL` has real iSpindel posts). A RAPT Laser Level's adverts share the pill's "PT" prefix and
  are told apart by their type byte (A1), checked before a pill's.
- **Bluetooth.** A Tilt's and a Laser Level's id come from their Bluetooth address, like a pill's (the colour in a
  Tilt's beacon isn't unique: two Tilts can be the same colour).
- **Not Bluetooth.** A device that isn't heard over Bluetooth still needs an `address` that's unique and never
  changes, prefixed so it can't clash with a Bluetooth address. An iSpindel's is `ISPINDEL:` and its chip id in hex
  (`ISPINDEL:64983F`), and its id `ispindel-64983f`: the chip id is part of the ESP8266, so it survives a new name,
  new firmware or a reset.
- **Hub-held secrets.** The token iSpindels send with each reading is an API token with the `ispindel` scope, kept
  in `meta` (`ispindelToken`) so the owner can see it again; `ispindelPending` remembers for 2 hours which iSpindels
  the hub has just set up, so it adds them when their first reading comes, even after a restart.
- **Kegs.** A beer kegged up under a Laser Level is a row in `kegs` (migration 8): the device's id, when it was kegged
  and emptied, and the rest (name, style, ABV, the brew it came from) as JSON. How much went in is worked out from the
  readings and kept in the JSON (`startDistance`, mm) once its 6 hours are up, so it survives the readings being
  rolled up. Like a reading, it's the distance that's kept, not litres, so it follows the keg's settings. A version
  from before kegs ignores the table. Deleting a device deletes its kegs, as it does its brews.
- **A brew's own alerts and profiles** (migration 10). A brew's alerts are rows in `brew_alerts` (the brew's id and an
  alert rule's settings as JSON, without pills), kept apart from `alert_rules` so a version from before them ignores
  them rather than firing them for every brew; their state goes in `alert_state` like a rule's. Deleting a brew deletes
  them; a version from before them leaves them behind when it deletes a brew, and they do nothing without it. Profiles
  are JSON rows in `brew_profiles`, read through `ProfileService.parse`, which fills in what's missing. New alert kinds
  (`fermentation_started`, `attenuation_reached`, `brew_day`) are kept in rules' JSON like any kind: a version that
  doesn't know a kind never fires it (`AlertService.check` falls through) and shows it as the first kind.
- **Reminders** (migration 10) are `brew_events.remind` (0 for every event before, and for one an older version adds),
  and `reminded_at` and `reminded_end`, the start and end times a reminder went out for. Keeping the time rather than a
  flag means an event an older version moves reminds again at its new time, and never twice for the same one.
  `brew_events.alert_id` is the alert that noted an event on the timeline (NULL for every event before, and for ones
  people add, whichever version adds them).

## Settings saved as JSON

Devices, webhooks, alert rules, channels and brews keep their settings as JSON, and hub settings are JSON in `meta`.

- **Read through the upgrade functions** that fill in what older saves don't have: `upgradeConfig` (devices),
  `upgradeWebhook`, `Settings.read`, `BrewService.upgrade`, `upgradeScreen`. A new field gets its default there; never
  assume it's present. A Laser Level's `vessel` defaults to KegLand's 19 L keg, and a missing `servingUnit` (its own
  unit for showing what's left) means it has none.
- **Keep what you don't know.** Save by spreading the saved object (`{ ...saved, ...changes }`), not field by field,
  so going back a version and forward again loses nothing.
- **Don't rename a field or change its meaning or unit.** Add a new one.

## What people have built on

People's own setups depend on these, and changes break them silently:

- **The API** ([api.md](./api.md)): add fields; don't remove or rename them or change their types or units. A field
  that can now be null (for a new kind of device) goes in the changelog.
- **Webhook template variables and presets** ([variables.ts](../src/shared/variables.ts)): never rename or remove a
  variable. Saved webhooks use them.
- **MQTT** ([mqtt.ts](../src/server/mqtt.ts)): topics, payload fields and Home Assistant unique ids. Changing them
  leaves people with duplicate entities and loses Home Assistant's history.
- **CSV exports**: for an existing kind of device, new columns go at the end.
- **The config file** (`rapthooker.config.json`): new keys get defaults. Unknown keys are ignored, so older versions
  cope with newer files.
- **Backups**: a backup from any version must restore on any other. One from an older version is upgraded like the
  live database; one from a newer version (taken on a beta, say) is used as it is, as after going back.
- **The web app's saved choices** (`localStorage` keys): renaming one forgets what people picked.
- **Screens' firmware** ([firmware/screen](../firmware/screen/README.md)): screens in people's homes run whatever
  firmware they last got, and a hub may be put back to an older version. The screens' HTTP API only gains things (a new
  call, a new field, a new name in `features`); nothing changes meaning or goes away, and `FW_API` goes up when the hub
  needs to know. The hub checks `api` or `features` before using anything newer, and the firmware ignores what it
  doesn't know in a request. Screens' settings (in their own flash) keep keys an older firmware doesn't know.
- **ESP32 boards' flash layout** ([partitions-esp32.csv](../firmware/screen/partitions-esp32.csv)) is written once,
  over USB, and can't be changed by an update: every later firmware has to fit its app partitions and read its
  settings from the `rhscreen` partition, in the same sector format the hub writes.

## Tests

- [storage.test.ts](../src/server/test/storage.test.ts) builds a database as a release left it (`schema3Database`, with
  something in every table), upgrades it and checks every row and value came through, and that the release's own SQL
  still works on the upgraded database. When a release changes the schema, add a fixture for it the same way and keep
  the old ones.
- [compatibility.test.ts](../src/server/test/compatibility.test.ts) checks that every release tag's migrations are
  still the first ones in `MIGRATIONS`, unchanged, and that nothing sets `minSchema`. CI checks out with the tags
  (`fetch-depth: 0`) so it can.
- `npm run test:compat` ([release-compat.mjs](../scripts/release-compat.mjs), after `npm run build`) runs every
  published release, betas included, on one data folder with the current build: the release sets up a hub and records,
  the current build upgrades it, the release runs on it again (going back), then the current build again. Each has to
  start, show the devices and the brew, and record; after each, every table, column, reading, device, brew and hub
  setting must still be there, unchanged. CI runs it, and the release workflow runs it before publishing anything.
- Never change a fixture or an expectation to make an upgrade test pass: fix the change.

## Before a release

- The changelog says what's stored differently.
- `npm run build && npm run test:compat` passes (the release workflow won't publish otherwise).
- Try the new version on a copy of a real hub's database: download one from Settings → Backups, put it in an empty
  folder as `rapthooker.db` and start the development server on it (`RAPTHOOKER_DATA_DIR=<folder> npm run dev:server`,
  with `npm run dev:web` to look at it). Check the log says it upgraded and kept a copy, and that the dashboard, a long
  chart and a brew look as they did.
