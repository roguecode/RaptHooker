# RaptHooker

A local hub for RAPT Pills, RAPT Bluetooth Thermometers and other brewing devices: a Node/TypeScript server
([src/server](src/server)) and a React web app ([src/web](src/web)) that run on a Raspberry Pi. The layout and how to
run it are in [docs/development.md](docs/development.md).

## Never break people's data

People record real brews with RaptHooker, some for years, and update in place. Every change, including adding or
changing a device, must keep working with what's already on their hubs:

- Readings, rollups, brews, settings and devices must come through every update unchanged. No change may lose
  history, orphan it (by changing a device's id or address) or change what stored values mean.
- Schema changes only as a new migration at the end of `MIGRATIONS` in [db.ts](src/server/db.ts). Never edit, reorder or
  remove a released one. Add tables and nullable or defaulted columns; never drop, rename or reinterpret a column that
  holds data. A table rebuild copies every row.
- The previous release must still run on the upgraded database: the installer puts it back if an update doesn't
  start.
- What a device doesn't measure is NULL, never 0. A new kind of device gets a new `kind` and uses the same tables;
  existing devices' ids, kinds and decoding never change.
- Saved JSON settings: new fields get defaults in the upgrade functions, and fields a version doesn't know are kept
  when it saves.
- Don't rename or remove API fields, webhook variables, MQTT topics or unique ids, CSV columns or config keys: add new
  ones.
- Prove it: [storage.test.ts](src/server/test/storage.test.ts) upgrades a database as a release left it. Extend it for
  schema changes, and never weaken a fixture or expectation to make a test pass.

The details, and the checklist for new devices: [docs/data-compatibility.md](docs/data-compatibility.md). If something
can't be done without breaking existing data, stop and ask.

## Build and test

```bash
npm run format && npm run lint && npm run i18n:check && npm run typecheck && npm test
npm run build && npm run test:e2e
```

- Text in the web app goes through `t()`/`tk()`/`tp()` and needs a translation in every locale
  ([docs/translations.md](docs/translations.md)); `npm run i18n` updates the list.
- Note changes people will notice in [CHANGELOG.md](CHANGELOG.md) under `[Unreleased]`.
