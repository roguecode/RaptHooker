# Development

Requires Node.js 22.13+ (the built-in `node:sqlite` is used).

```bash
npm install
npm run seed         # optional: three simulated pills with a few days of history and brews
npm run dev:server   # http://localhost:8080 with simulated pills (no config file = development mode)
npm run dev:web      # Vite dev server with hot reload, proxies /api to the server
npm test
npm run typecheck
npm run build        # src/web/dist and src/server/dist/rapthooker.cjs (one file; the Pi only needs Node)
```

Without a `rapthooker.config.json`, the server runs in development mode: simulated pills (they behave like real ones,
including re-sending their previous reading), data in `./data`, and this computer treated as the owner.

| Path                        | What                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [src/shared](../src/shared) | Types, units, webhook template engine, variables and presets (used by both sides)                                  |
| [src/server](../src/server) | Bluetooth (BlueZ over D-Bus) and the RAPT decoder, SQLite store, pills, brews, webhooks, alerts, MQTT, API         |
| [src/web](../src/web)       | React + Vite web app (uPlot charts, PWA)                                                                           |
| [deploy](../deploy)         | Installer and updater, Pi setup script, systemd units, deploy and packaging scripts, Pi image stage, Docker config |
| [docs](.)                   | Guides, listed below                                                                                               |

To check what the Pi hears, run the probe tool there: `node /opt/rapthooker/server/rapthooker-probe.cjs 120`.

Guides: [Pi setup](./pi-setup.md), [configuration](./configuration.md), [features](./features.md),
[webhooks](./webhooks.md), [alerts](./alerts.md), [brewing](./brewing.md), [calibration](./calibration.md),
[Home Assistant](./home-assistant.md), [backups](./backups.md), [relays](./relay.md), [API](./api.md),
[small screens](./screens.md), [updating](./updating.md), [translations](./translations.md), [Docker](./docker.md).

Changing how anything is stored, identified or sent, or adding a kind of device? Read
[Keeping people's data](./data-compatibility.md) first: updates must never lose or change what's on people's hubs. The
same rules are in [AGENTS.md](../AGENTS.md) for coding agents.

## Testing

```bash
npm test             # unit and component tests (Vitest; components run in happy-dom)
npm run build        # the end-to-end tests use the built app
npx playwright install chromium   # once
npm run test:e2e     # Playwright: a real hub with simulated pills, on a desktop and a phone screen
npm run i18n:check   # every translatable string is extractable and every translation's placeholders match
```

## Build and deploy it yourself

From this repository on your PC (Node.js 22.13+ and the OpenSSH client):

```powershell
npm install
.\deploy\deploy.ps1 -PiHost raspberrypi.local -Setup   # first time (Windows); renames the Pi to "rapthooker"
.\deploy\deploy.ps1                                    # updates
```

```bash
npm install
./deploy/deploy.sh raspberrypi.local --setup           # first time (macOS/Linux)
./deploy/deploy.sh                                     # updates
```

A hub deployed this way runs your own build, so it doesn't update itself from the app. The app says it's a
**Development build** (in the top bar, and under Settings → Updates with the commit it was built from), and the owner
can **Switch to release x.y.z** there to go back to the latest release, which then updates as usual (see
[Updating](./updating.md#development-builds)). `npm run package` builds a release archive the same way the release
workflow does (`release/rapthooker-<version>.tar.gz`); install one with
`sudo bash install.sh --file rapthooker-<version>.tar.gz`.

Docker is also possible (for a Linux host with Bluetooth): see [Docker](./docker.md).

## Pictures in the README

The screenshots in [images](./images) are taken by `node scripts/screenshots.mjs` (after `npm run build`): it starts
a hub with the simulated pills and thermometer and seeded history in a temporary folder and photographs it with Playwright,
and saves the example pictures for small screens as the hub draws them. Name some (`node scripts/screenshots.mjs kiosk
screen-tv`) to take only those. The diagram
is drawn by `node scripts/flowchart.mjs` (it reuses the app's icons), which writes `images/how-it-works.svg` and `.png`.
