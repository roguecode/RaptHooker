---
description: 'Use when changing anything RaptHooker stores or other things rely on: database schema or MIGRATIONS, saved JSON settings, devices and device kinds, API fields, webhook variables, MQTT topics, CSV columns, config keys, backups and restore, the updater or installer. Every release, betas included, must keep working with the data any other release has left, in both directions.'
applyTo: 'src/server/db.ts,src/server/restore.ts,src/server/backup/**,src/server/settings.ts,src/server/config.ts,src/server/pills.ts,src/server/brews.ts,src/server/kegs.ts,src/server/webhooks.ts,src/server/alerts.ts,src/server/channels.ts,src/server/tokens.ts,src/server/mqtt.ts,src/server/updates.ts,src/server/ispindel/**,src/server/screens/**,src/server/ble/**,src/server/routes/**,src/shared/**,deploy/**,firmware/screen/**'
---

# Keeping people's data, both ways

People switch between any two releases in either direction: updates, the installer putting the previous version back,
trying a beta and going back to the release. Whatever you change here has to work with data that any older or newer
release left, and leave data they can all still use. Full rules: [docs/data-compatibility.md](../../docs/data-compatibility.md).
Step by step: the `data-compatibility` skill ([SKILL.md](../skills/data-compatibility/SKILL.md)).

- Schema: only a new migration at the end of `MIGRATIONS`. Never edit, reorder or remove a released one (betas are
  releases). Only add tables, and columns that are nullable or have a default that's right for rows older releases
  write. Never set `minSchema`.
- Stored JSON (devices, brews, webhooks, alerts, channels, screens, hub settings): defaults for new fields in the
  upgrade functions; save by spreading what was saved so fields other versions added survive.
- Identity and contracts: device ids and addresses, `kind` values, decoding of existing devices, API fields, webhook
  variables, MQTT topics and unique ids, CSV columns, config keys and `localStorage` keys only ever gain things.
- What a device doesn't measure is NULL, never 0.
- Prove it, without weakening any fixture or expectation: extend
  [storage.test.ts](../../src/server/test/storage.test.ts) for schema changes, then run
  `npx vitest run src/server/test/storage.test.ts src/server/test/compatibility.test.ts` and
  `npm run build && npm run test:compat`.
- If it can't be done without breaking that, stop and ask.
