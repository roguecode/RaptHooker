# Backups

RaptHooker keeps everything it records in one SQLite database on the Pi. Every night it saves a copy of it, and it can
copy those backups off the Pi too: to a USB stick plugged into the Pi, and to S3-compatible cloud storage. You can also
download a copy at any time, and restore one from the web app.

Everything here is under **Settings → Backups**. Only the owner can download, restore or change the settings; anyone
else sees when the last backups were made.

## What's in a backup

A backup is a complete copy of the database (`rapthooker-YYYY-MM-DD.db`), made while the hub keeps recording:

- your pills, their names, colours and calibration
- every reading (and the 15-minute averages), brews and brew events
- webhooks and their delivery log, alerts, notification channels and API tokens
- hub settings, including the MQTT and backup settings and the owner PIN (stored hashed)

Not included: the config file (`/etc/rapthooker/rapthooker.config.json`) and the keys kept next to the database
(`vapid.json` for push notifications and `cookie-secret` for sign-ins). After restoring onto a **new** Pi, sign in again
and switch notifications back on in each browser.

A backup holds secrets (webhook URLs with their tokens, the MQTT password, the S3 secret key), so keep the files and the
bucket private.

The file is a standard SQLite database, so you can also open it with tools like
[DB Browser for SQLite](https://sqlitebrowser.org/) or the `sqlite3` command.

## On the hub

Every night at 03:15 (the hub's local time) a backup goes to `backups/` in the data folder
(`/var/lib/rapthooker/backups` on a Pi installed with `setup.sh`, `./docker-data/backups` with Docker). The newest 7 are
kept. A backup made again on the same day (with **Back up now**) replaces that day's file.

The time, the folder and how many are kept can be changed in the config file:

```json
"backup": { "dir": "", "time": "03:15", "keep": 7 }
```

An empty `dir` means `<dataDir>/backups`. If you point it somewhere else on a Pi, re-run `setup.sh` so the service is
allowed to write there.

These copies live on the same SD card as the database, so they protect against mistakes and a damaged database, not a
dead SD card. For that, copy them off the Pi too (USB stick or S3, below), or download one now and then.

### Download a copy

- **Download a copy now** makes a fresh backup there and then and downloads it.
- The list under **Saved on the hub** has every nightly backup (and the copies kept from before a restore) to download.

### Weekly CSV export

With **Weekly CSV export** on, every Sunday the hub also saves each brew from the last 60 days and every pill's readings
from the last 7 days as CSV files (one file each, the same columns as the CSV download on a brew or pill page) in
`backups/csv/YYYY-MM-DD/`. They're copied to the USB stick and S3 too when those are on. The last 8 weeks are kept
everywhere. CSV files open in any spreadsheet, so they're handy even without RaptHooker.

## Restore

**Restore…** under Settings → Backups replaces the hub's data with a backup:

1. Upload a backup file (from **Download a copy now**, the USB stick or your bucket; up to 500 MB), or pick one of the
   backups on the hub.
2. The hub checks it's a RaptHooker database it can use: an SQLite file with RaptHooker's tables, not from a newer
   version of RaptHooker, that passes SQLite's integrity check. Anything else is turned away and nothing changes.
3. Confirm, and the hub restarts (it takes about half a minute). At start-up, before opening the database, it moves the
   current database aside as `pre-restore-<date and time>.db`, puts the backup in its place and brings it up to date if
   it came from an older version. The page reloads by itself once the hub is back.

Nothing is lost by restoring: the data from just before the restore shows up in the backups list as **From before a
restore**, so you can download it or restore it to go back. The last 3 of these are kept. Readings recorded after the
backup was made aren't in the restored data, and the settings (including the owner PIN) are the ones in the backup.

If anything goes wrong at start-up, the hub carries on with the current database and the backup is kept as
`restore-failed-<date and time>.db` next to it; the hub's log says why.

In development (no config file, not running as a service) the hub can't restart itself: restart it and the backup is
swapped in then.

### Restoring by hand

On the Pi, put the backup in the data folder as `restore-pending.db` and restart; the hub swaps it in as above:

```bash
sudo install -o rapthooker -g rapthooker -m 640 rapthooker-2026-10-24.db /var/lib/rapthooker/restore-pending.db
sudo systemctl restart rapthooker
journalctl -u rapthooker -n 20   # "backup restored"
```

## USB stick

1. Format a USB stick as **FAT32** or **exFAT** (most sticks come like this) and name it (the volume label)
   **RAPTHOOKER**.
2. Plug it into the Pi.
3. Switch on **Copy to a USB stick** under Settings → Backups (it's on unless you've switched it off).

Each nightly backup (and the weekly CSV files) is then copied onto the stick, and the last 30 backups are kept there.
When no stick is plugged in, the hub simply says so and carries on. Wait a minute after a backup before pulling the
stick out (it's unmounted after a minute of not being used), or check that the backups list shows the copy.

How it works: `setup.sh` (through `deploy/pi/setup.d/30-usb-backups.sh`) adds this line to `/etc/fstab`, so systemd
mounts a stick labelled RAPTHOOKER at `/mnt/rapthooker` when RaptHooker uses it, and lets the service write there:

```
LABEL=RAPTHOOKER /mnt/rapthooker auto nofail,noauto,x-systemd.automount,x-systemd.device-timeout=5s,x-systemd.idle-timeout=60,uid=rapthooker,gid=rapthooker,umask=0027 0 0
```

The `uid`, `gid` and `umask` options give the files to the `rapthooker` user, and only work for FAT32, exFAT and NTFS.
An **ext4** stick won't mount with them: reformat it as FAT32 or exFAT, or edit that line to take out
`,uid=rapthooker,gid=rapthooker,umask=0027`, run `sudo systemctl daemon-reload`, and with the stick plugged in run
`ls /mnt/rapthooker` (to mount it) then `sudo chown rapthooker:rapthooker /mnt/rapthooker`.

On a Pi installed before USB backups existed, re-run setup once:

```bash
sudo bash /opt/rapthooker/deploy/pi/setup.sh --keep-hostname
sudo systemctl restart rapthooker
```

USB copies only work on a Pi set up with `setup.sh` (not in Docker).

## S3-compatible storage

With **Upload to cloud storage (S3)** on, each nightly backup is uploaded as `<folder>/rapthooker-YYYY-MM-DD.db` (and
the weekly CSV files as `<folder>/csv/YYYY-MM-DD/…`). The hub then lists the folder and deletes all but the newest 30
backups and 8 weeks of CSV files, so the key needs permission to **upload, list and delete** in the bucket. If it can
only upload, the uploads still work and the hub says it couldn't tidy up: set a lifecycle rule on the bucket to expire
old files instead.

Use **Test** to check the settings: it uploads a small `rapthooker-connection-test.txt` to the folder, lists the folder
and deletes the file again, and says in plain words what went wrong (wrong secret, no such bucket, wrong region...).

| Setting               | What to put                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| Endpoint              | The service's S3 address (see below). Empty for Amazon S3: the region picks it.                |
| Region                | The bucket's region. `auto` for Cloudflare R2, `us-east-1` for MinIO unless you changed it.    |
| Bucket                | The bucket's name. Make it private.                                                            |
| Folder in the bucket  | Where the files go, e.g. `rapthooker/`. Empty for the top of the bucket.                       |
| Access key ID, secret | A key for this bucket only, ideally. The secret is never shown again once saved.               |
| Path-style addresses  | `endpoint/bucket` instead of `bucket.endpoint`. On for MinIO, NAS boxes and R2; S3 takes both. |

Examples (use your own region and account):

| Service             | Endpoint                                        | Region         | Path-style |
| ------------------- | ----------------------------------------------- | -------------- | ---------- |
| Amazon S3           | empty, or `https://s3.eu-west-2.amazonaws.com`  | `eu-west-2`    | either     |
| Cloudflare R2       | `https://<account id>.r2.cloudflarestorage.com` | `auto`         | on         |
| Backblaze B2        | `https://s3.us-west-004.backblazeb2.com`        | `us-west-004`  | on         |
| Wasabi              | `https://s3.eu-central-1.wasabisys.com`         | `eu-central-1` | either     |
| MinIO / NAS at home | `http://nas.local:9000`                         | `us-east-1`    | on         |

- **Amazon S3:** create a bucket (block all public access) and an IAM user or role with `s3:PutObject`,
  `s3:ListBucket` and `s3:DeleteObject` on it.
- **Cloudflare R2:** R2 → Manage API tokens → create an _Object Read & Write_ token for the bucket; it shows the access
  key ID, the secret and the endpoint.
- **Backblaze B2:** create an application key for the bucket; the endpoint (and the region inside it) is shown on the
  bucket's page.
- **MinIO:** create an access key with read/write access to the bucket. Plain `http://` is fine on your own network.

Uploads are signed with AWS Signature Version 4 and carry the file's SHA-256, so the storage service checks the whole
file arrived intact. The hub's clock must be right for the signature to be accepted (it is once it has synced from the
network).

## Where things are

| What                     | Where                                                             |
| ------------------------ | ----------------------------------------------------------------- |
| The database             | `/var/lib/rapthooker/rapthooker.db`                               |
| Nightly backups          | `/var/lib/rapthooker/backups/rapthooker-YYYY-MM-DD.db` (last 7)   |
| Weekly CSV files         | `/var/lib/rapthooker/backups/csv/YYYY-MM-DD/` (last 8 weeks)      |
| Data from before restore | `/var/lib/rapthooker/pre-restore-YYYY-MM-DDTHH-MM-SS.db` (last 3) |
| USB stick                | `/mnt/rapthooker/rapthooker-YYYY-MM-DD.db` (last 30) and `csv/`   |
| S3                       | `<folder>/rapthooker-YYYY-MM-DD.db` (last 30) and `<folder>/csv/` |
