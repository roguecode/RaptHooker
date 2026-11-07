# RaptHooker

A local hub for RAPT Pills, RAPT Bluetooth Thermometers and other brewing devices: a Node/TypeScript server
([src/server](src/server)) and a React web app ([src/web](src/web)) that run on a Raspberry Pi. The layout and how to
run it are in [docs/development.md](docs/development.md).

## Never break people's data

People record real brews with RaptHooker, some for years, and update in place. They also go back: the installer puts
the previous version back if an update doesn't start, and owners try betas and return to the release. So every change,
including adding or changing a device, must keep working with what's already on their hubs, in both directions:

- Readings, rollups, brews, settings and devices must come through every update unchanged. No change may lose
  history, orphan it (by changing a device's id or address) or change what stored values mean.
- **Any release ↔ any release.** Every release, betas included, must run on the data any other release has left, older
  or newer, and hand it back intact. Older releases must still start, show and record on a database this code has
  upgraded. Never set `minSchema` or do anything else that stops an older version opening the data.
- Schema changes only as a new migration at the end of `MIGRATIONS` in [db.ts](src/server/db.ts). Never edit, reorder or
  remove a released one, and a published beta's migrations are released. Add tables and nullable or defaulted columns;
  never drop, rename or reinterpret a column that holds data. A table rebuild copies every row.
- What a device doesn't measure is NULL, never 0. A new kind of device gets a new `kind` and uses the same tables;
  existing devices' ids, kinds and decoding never change.
- Saved JSON settings: new fields get defaults in the upgrade functions, and fields a version doesn't know are kept
  when it saves.
- Don't rename or remove API fields, webhook variables, MQTT topics or unique ids, CSV columns or config keys: add new
  ones.
- Prove it, and never weaken a fixture or expectation to make a test pass:
  - [storage.test.ts](src/server/test/storage.test.ts) upgrades a database as a release left it. Extend it for schema
    changes.
  - [compatibility.test.ts](src/server/test/compatibility.test.ts) checks no released migration changed (it needs the
    git tags) and nothing sets `minSchema`.
  - `npm run build && npm run test:compat` runs every published release on the data this code leaves, and back. Run it
    for any change to stored data, the API, settings, the updater or the installer.

The details, and the checklist for new devices: [docs/data-compatibility.md](docs/data-compatibility.md). For the steps,
use the skills in [.github/skills](.github/skills): `data-compatibility` before changing anything stored or relied on,
`release` to publish a release or a beta. If something can't be done without breaking existing data or going back,
stop and ask.

## Build and test

```bash
npm run format && npm run lint && npm run i18n:check && npm run typecheck && npm test
npm run build && npm run test:e2e && npm run test:compat
```

- Text in the web app goes through `t()`/`tk()`/`tp()` and needs a translation in every locale
  ([docs/translations.md](docs/translations.md)); `npm run i18n` updates the list.
- Note changes people will notice in [CHANGELOG.md](CHANGELOG.md) under `[Unreleased]`.
