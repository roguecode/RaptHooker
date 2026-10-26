# Keeping people's data

People record real brews with RaptHooker, some of them for years. An update must never lose, change or orphan any of
it: not the readings, not the brews, not the settings, not the things people have set up around the hub (Home
Assistant, webhooks, scripts using the API). This page is the checklist for any change to how things are stored,
identified or sent, and for adding a new kind of device.

The version before an update matters too: if a new version doesn't start, the installer puts the previous one back,
and it carries on with the data the new one has already upgraded.

## Where the data is

Everything is in one SQLite database, `/var/lib/rapthooker/rapthooker.db` on a Pi (see [db.ts](../src/server/db.ts)):

| Table                                             | What                                                                                                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pills`                                           | Every device you've added (pills, thermometers and any kind to come), with its settings as JSON. "Pill" in table and column names means any device. |
| `readings`                                        | Every reading, one row per device and time. Raw readings older than `rawRetentionDays` are deleted.                                                 |
| `rollups`                                         | 15-minute sums of the readings. Once raw readings are deleted they're the only history left, so they're as precious as the readings.                |
| `brews`, `brew_events`                            | Brews and their timelines.                                                                                                                          |
| `webhooks`, `webhook_state`, `webhook_deliveries` | Webhooks, how far each has got, and their recent deliveries.                                                                                        |
| `alert_rules`, `alert_state`, `alert_events`      | Alerts.                                                                                                                                             |
| `channels`, `push_subs`, `api_tokens`             | Notification channels, browsers with notifications on, API tokens.                                                                                  |
| `meta`                                            | Hub settings (as JSON) and bookkeeping.                                                                                                             |

Outside the database: `rapthooker.config.json`, the push keys, and the backups (see [Backups](./backups.md)).

## The database

- **Only through migrations.** A schema change is a new entry at the end of `MIGRATIONS` in
  [db.ts](../src/server/db.ts). Never edit, reorder or remove one that has been released (`git tag` lists the
  releases). All the migrations an update brings run in one transaction, so if any of them fails nothing changes.
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
- **The previous release must still work on the upgraded database**, as the installer may put it back and it records
  with its own SQL. A new column needs a default that's right for the rows an older version writes without knowing
  the column. The rollups' `*_missing` counts are an example: counting the readings that lacked a measurement, rather
  than those that had it, keeps a bucket right when an older version adds a pill's reading (which has everything).
- **When older versions really can't cope**, the migration sets `minSchema` in `meta` (`MIN_SCHEMA_KEY`) to its own
  schema version. Versions that don't know that many migrations then refuse to open the database instead of damaging
  it, and say to update again or restore the pre-update copy. Releases from before this check was added don't check,
  so avoid it while people may still go back to one of them.
- **What a device doesn't measure is NULL**, never a made-up 0. A new kind of measurement is a new nullable column in
  `readings`, plus a sum and a `<name>_missing` count in `rollups` (see migration 4), written in `Store.addReading` and
  averaged in `Store.history` and `Store.prunedRollups`.
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
- **Kinds.** Each device's settings have a `kind` (`DeviceKind`: `pill`, `thermometer`). A new kind of device gets a
  new value. Existing devices keep theirs; settings saved without one are pills. A version that doesn't know a kind
  lists the device but records nothing for it and doesn't change its kind.
- **One set of tables.** A new kind's readings go in `readings` and `rollups` like everything else, with NULL for what
  it doesn't measure, so history, retention, backups and exports work for it without anything new.
- **Decoding.** Adding a decoder must not change how existing devices' broadcasts are decoded: the captured payloads
  (`CAPTURED` in [helpers.ts](../src/server/test/helpers.ts)) must decode exactly as before. Add captures from the new
  device.
- **Not Bluetooth.** A device that isn't heard over Bluetooth still needs an `address` that's unique and never
  changes, prefixed so it can't clash with a Bluetooth address.

## Settings saved as JSON

Devices, webhooks, alert rules, channels and brews keep their settings as JSON, and hub settings are JSON in `meta`.

- **Read through the upgrade functions** that fill in what older saves don't have: `upgradeConfig` (devices),
  `upgradeWebhook`, `Settings.read`, `BrewService.upgrade`. A new field gets its default there; never assume it's
  present.
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
- **Backups**: a backup from any earlier version must restore. It's upgraded like the live database.
- **The web app's saved choices** (`localStorage` keys): renaming one forgets what people picked.

## Tests

- [storage.test.ts](../src/server/test/storage.test.ts) builds a database as a release left it (`schema3Database`, with
  something in every table), upgrades it and checks every row and value came through, and that the release's own SQL
  still works on the upgraded database. When a release changes the schema, add a fixture for it the same way and keep
  the old ones.
- Never change a fixture or an expectation to make an upgrade test pass: fix the change.

## Before a release

- The changelog says what's stored differently.
- Try the new version on a copy of a real hub's database: download one from Settings → Backups, put it in an empty
  folder as `rapthooker.db` and start the development server on it (`RAPTHOOKER_DATA_DIR=<folder> npm run dev:server`,
  with `npm run dev:web` to look at it). Check the log says it upgraded and kept a copy, and that the dashboard, a long
  chart and a brew look as they did.
