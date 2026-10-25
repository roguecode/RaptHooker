# Configuration

Almost everything (pills, brews, webhooks, alerts, MQTT, backups, the hub's name and units) is set up in the app. A
few settings that the hub needs before it starts live in a small file on the Pi,
`/etc/rapthooker/rapthooker.config.json` (example:
[deploy/pi/rapthooker.config.example.json](../deploy/pi/rapthooker.config.example.json)). You rarely need to touch it.

To change it, log in to the Pi and run:

```bash
sudo nano /etc/rapthooker/rapthooker.config.json   # edit, then Ctrl+O, Enter to save and Ctrl+X to leave
sudo systemctl restart rapthooker                  # recording pauses for a few seconds
```

If the hub doesn't start afterwards, `journalctl -u rapthooker -n 30` says which setting it didn't like.

## Settings

| Key                            | Default                         | Meaning                                                           |
| ------------------------------ | ------------------------------- | ----------------------------------------------------------------- |
| `port`, `host`                 | `8080`, `::`                    | Web server (`::` is every IPv6 and IPv4 address)                  |
| `dataDir`                      | `./data`                        | Database, keys                                                    |
| `bluetooth.adapters`           | `[]` (every adapter found)      | BlueZ adapters to listen with, e.g. `["hci0", "hci1"]`            |
| `bluetooth.adapter`            | `""`                            | Older single-adapter setting, used when `adapters` is empty       |
| `bluetooth.scanMode`           | `auto`                          | `passive`, `active`, or `auto` (passive when BlueZ allows it)     |
| `bluetooth.mock`               | `false`                         | Simulated pills instead of Bluetooth                              |
| `rawRetentionDays`             | `0` (keep)                      | Delete raw readings older than this (15-minute averages are kept) |
| `auth.allowedTailscaleUsers`   | `[]` (anyone)                   | Tailscale logins that count as the owner                          |
| `backup.dir` / `time` / `keep` | `""` / `03:15` / `7`            | Nightly database backup (empty `dir`: `<dataDir>/backups`)        |
| `push.subject`                 | `mailto:rapthooker@example.com` | Contact sent to push services: set your own                       |
| `clock.maxSyncWaitMin`         | `10`                            | How long to hold readings waiting for network time after boot     |

Environment variables `RAPTHOOKER_CONFIG`, `RAPTHOOKER_PORT` and `RAPTHOOKER_DATA_DIR` override the file.
