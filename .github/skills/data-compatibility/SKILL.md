---
name: data-compatibility
description: 'Use before and while changing anything RaptHooker stores or others rely on: adding a database migration or table or column, changing MIGRATIONS or the schema, saved JSON settings (devices, brews, webhooks, alerts, channels, screens, hub settings), adding a device kind, API fields, webhook variables, MQTT topics or Home Assistant ids, CSV columns, config keys, backups/restore, the updater or installer. Gives the steps and the checks that prove every release, betas included, still works with the data any other release left, in both directions.'
---

# Changing what RaptHooker stores, without breaking any release

People switch between any two releases, either way: updates, the installer putting the previous version back, trying a
beta and going back to the release. Every release has to run on the data any other release left, older or newer, and
hand it on intact. The rules are in [docs/data-compatibility.md](../../../docs/data-compatibility.md); this is the
procedure.

## 1. Say what the change touches

Before writing code, list which of these it changes, and read that part of the doc:

| Touches                                              | Doc section                                    |
| ---------------------------------------------------- | ---------------------------------------------- |
| Tables, columns, `MIGRATIONS`, `readings`/`rollups`  | The database                                   |
| A device's id, address, `kind` or decoding           | Devices                                        |
| JSON saved in the database (settings of anything)    | Settings saved as JSON                         |
| API, webhooks, MQTT, CSV, config, backups, firmware  | What people have built on                      |
| `deploy/` (install.sh, update.sh, setup), updates.ts | All of the above: it moves people between them |

## 2. Make the change so every release copes

- **Schema**: append one migration to `MIGRATIONS` in `src/server/db.ts`, with a comment saying what older versions do
  with it. Only `CREATE TABLE`, `ADD COLUMN` (nullable, or a `DEFAULT` that's right for rows an older release inserts
  without naming the column), new indexes, and table rebuilds that copy every row. Never edit, reorder or remove an
  existing migration: if one that's been released (any `v*` tag, betas too) is wrong, fix it with a new one.
- **Never shut older releases out**: no `minSchema`, no renamed or dropped column or table, no changed meaning or unit,
  nothing that makes an older release's SQL fail (they insert and update with their own column lists).
- **Readings**: what a device doesn't measure is NULL. A new measurement is a new nullable column plus its rollup sum and
  count (see the doc for `_missing` vs `_n`).
- **JSON**: give new fields defaults in the upgrade function (`upgradeConfig`, `upgradeWebhook`, `Settings.read`,
  `BrewService.upgrade`, `upgradeScreen`...). Save with `{ ...saved, ...changes }` so fields a newer release added
  survive an older one, and the other way round.
- **Contracts** (API, webhook variables, MQTT topics and unique ids, CSV columns, config keys, `localStorage` keys,
  screen firmware API): only add. A field that can now be null goes in the changelog.
- **Updater/installer**: an older release's `install.sh`/`update.sh` must still install newer releases, and a newer
  one older releases (going back). Keep the request and status file formats.

If it can't be done this way, stop and ask the user before going further.

## 3. Prove it

Never weaken a fixture or an expectation to make a test pass: fix the change instead.

1. Schema change: in `src/server/test/storage.test.ts`, add a fixture for the database as the last release left it
   (like `schema5Database`, with something in every table) and keep the old fixtures. Test that upgrading keeps every
   row and value, and that the last release's own SQL (its inserts and updates, copied from its tag) still works on the
   upgraded database and stays right (like "stays right when 0.8.0 is put back and records into it").
2. JSON change: test that a save by this version keeps fields it doesn't know (like "keeps what a newer version saved in
   a rule when it is edited"), and that what older versions saved gets the new defaults.
3. Run the focused tests:

   ```bash
   npx vitest run src/server/test/storage.test.ts src/server/test/compatibility.test.ts
   ```

   `compatibility.test.ts` compares `MIGRATIONS` with every release tag, so the tags must be fetched
   (`git fetch --tags`).

4. Run every published release against what this code leaves, and back:

   ```bash
   npm run build && npm run test:compat
   ```

   It must end with "All N release(s) switch to and from this version without losing or changing anything." On a
   failure it prints what was lost or changed, and the logs; `--keep` keeps the data folders, `--releases 0.8.0` tries
   one.

5. Then the full checks from [AGENTS.md](../../../AGENTS.md#build-and-test).

## 4. Say so

In `CHANGELOG.md` under `[Unreleased]`: what's stored differently, what older versions do with it if people go back,
and any API field that can now be null.
