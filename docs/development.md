# Development

Requires Node.js 22.13+ (the built-in `node:sqlite` is used).

```bash
npm install
npm run seed         # optional: the simulated pills, thermometer and Laser Level with a few days of history, brews and kegs
npm run dev:server   # http://localhost:8080 with simulated pills (no config file = development mode)
npm run dev:web      # Vite dev server with hot reload, proxies /api to the server
npm test
npm run typecheck
npm run build        # src/web/dist and src/server/dist/rapthooker.cjs (one file; the Pi only needs Node)
```

Without a `rapthooker.config.json`, the server runs in development mode: simulated pills (they behave like real ones,
including re-sending their previous reading), a simulated "Smart weather clock" on its stock firmware to set up as a
screen (with pretend Wi-Fi: `screens.wifi` is `mock`), a pretend iSpindel in setup mode to set up from **Add device**
(it knows the Wi-Fi `Brewery`), a pretend ESP32 board on USB (`screens.usb` is `mock`), data in `./data`, and this
computer treated as the owner.

`npm run seed -- laser` (or `pills`, `thermometer`) adds just those, to the database in `./data` (or
`RAPTHOOKER_DATA_DIR`). Stop the server first.

| Path                                  | What                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [src/shared](../src/shared)           | Types, units, webhook template engine, variables and presets (used by both sides)                                   |
| [src/server](../src/server)           | Bluetooth (BlueZ over D-Bus) and the RAPT decoder, SQLite store, pills, brews, webhooks, alerts, MQTT, screens, API |
| [src/web](../src/web)                 | React + Vite web app (uPlot charts, PWA)                                                                            |
| [firmware/screen](../firmware/screen) | Firmware for the screens RaptHooker sets up (PlatformIO); its built image ships in the hub                          |
| [deploy](../deploy)                   | Installer and updater, Pi setup script, systemd units, deploy and packaging scripts, Pi image stage, Docker config  |
| [docs](.)                             | Guides: the list is in [docs/README.md](./README.md)                                                                |

To check what the Pi hears, run the probe tool there: `node /opt/rapthooker/server/rapthooker-probe.cjs 120`.

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
npm run firmware     # the screens' firmware (needs PlatformIO); see firmware/screen/README.md
```

Screens are simulated in tests and development (`src/server/screens/simulator.ts`: a stock screen that becomes a
RaptHooker one, and pretend Wi-Fi). To try a real one from a Windows PC with a Wi-Fi adapter, run the built server with
a config that has `"screens": { "wifi": "netsh" }`: the PC joins the screen's hotspot while its wired connection keeps
the hub reachable.

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

## Releasing

1. Update the version in `package.json` and `src/*/package.json`
   (`npm version <x.y.z> --workspaces --include-workspace-root --no-git-tag-version`) and add a `## [x.y.z] - date`
   section to [CHANGELOG.md](../CHANGELOG.md).
2. Commit, then tag and push: `git tag vx.y.z && git push origin vx.y.z`.
3. The [release workflow](../.github/workflows/release.yml) checks the tag matches `package.json`, runs the checks,
   builds `rapthooker-<version>.tar.gz` with [deploy/package.mjs](../deploy/package.mjs) (try it with
   `npm run package`), and publishes the release with that CHANGELOG section as its notes, the archive, `SHA256SUMS`
   and `install.sh`. Then it builds the Raspberry Pi image (experimental) and attaches it.

Hubs see the new release within a day.

## Pictures in the README

The screenshots in [images](./images) are taken by `node scripts/screenshots.mjs` (after `npm run build`): it starts
a hub with the simulated pills and thermometer and seeded history in a temporary folder and photographs it with Playwright,
and saves the example pictures for small screens as the hub draws them. Name some (`node scripts/screenshots.mjs kiosk
screen-tv`) to take only those. The diagram
is drawn by `node scripts/flowchart.mjs` (it reuses the app's icons), which writes `images/how-it-works.svg` and `.png`.
