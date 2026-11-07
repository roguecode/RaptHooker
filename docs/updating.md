# Updating RaptHooker

Updates replace the app only: your pills, brews, readings, webhooks and settings stay, and a running brew carries on.
The hub is down for the minute or so it takes to restart; a pill's broadcast in that minute may be missed.

## From the app

Once a day the hub asks GitHub whether there's a new release (Settings can turn this off; **Check now** under
Settings → Updates asks straight away). When there is one, a banner says so, with **What's new**.

On a hub set up with the [one-line installer](../README.md#install) (or the Raspberry Pi image), the owner can click
**Update now**. The hub then:

1. downloads the release and checks it against its published checksums,
2. puts the new version in place, keeping the one it had in `/opt/rapthooker/previous`,
3. runs the setup again (for new packages or settings the new version needs) and restarts,
4. checks that the new version answers within a minute. If it doesn't, it goes back to the previous version and the
   banner says what went wrong.

The page reconnects by itself and loads the new version, then shows what's new.

When a new version changes how the data is stored, it keeps a copy of the database from before first (listed under
Settings → Backups as **From before an update**; see [Backups](./backups.md#before-an-update)).

## Trying a beta

Betas are early versions, for trying out what's coming before it's released. They're published on GitHub as
pre-releases, with versions like `0.9.0-beta.1` (or `0.9.0-tilt.1` for one that tries out one thing). A hub never
installs one by itself.

Under Settings → Updates → **Beta versions**, the owner sees the betas there are, newest first, with what's in each,
and picks one with **Try this beta**. It installs the same way as **Update now**: if it doesn't start, the hub goes back
to the version it had. While the hub runs a beta:

- the top bar says **Beta**, and Settings → Updates says which one, and when a later beta of it is out;
- **Go back to release x.y.z** under Settings → Updates installs the latest release again, whenever you like;
- when the release the beta leads up to comes out, it's offered as an ordinary update.

Your brews, readings and settings stay whichever way you go: every release keeps working with the data any other has
left, older or newer, and that's tested against every published release before a new one is made (see
[Keeping people's data](./data-compatibility.md)). Anything only the beta has (a new kind of device, say) is kept, unused
by a version that doesn't know it, and is back when the hub is on one that does. A backup taken on a beta can be
restored after going back.

Only betas newer than the latest release are listed: once a release has what a beta was trying out, the beta goes.

To point someone at a beta, tell them its version: they'll find it under Settings → Updates → **Beta versions**.

### How it works

The app runs as the `rapthooker` user and can't change its own files (that's on purpose). To ask for an update it
creates `/var/lib/rapthooker/update-request`, naming the version (a release, or a beta when you try one or go back from
one). `rapthooker-update.path`, a systemd unit installed by setup, notices the
file and starts `rapthooker-update.service`, which runs [update.sh](../deploy/pi/update.sh) as root. That runs
[install.sh](../deploy/install.sh) `--update` and leaves the result in `/var/lib/rapthooker/update-status.json`, which
the app reads.

**Update now** only appears when `/opt/rapthooker/.installer` exists (written by the installer) and the updater is
installed (the path unit and `/opt/rapthooker/deploy/install.sh`). A hub deployed from a PC with
`deploy.ps1`/`deploy.sh` runs your own build, so it isn't offered updates: see [Development builds](#development-builds).

## Development builds

`deploy.ps1` and `deploy.sh` leave `/opt/rapthooker/.dev-build` on the Pi. The app then shows **Development build** in
the top bar, and Settings → Updates shows the commit it was built from (and whether it had uncommitted changes), since
its version number doesn't say what it runs. It doesn't offer updates, so a build you're trying out isn't replaced
behind your back.

To go back to releases, the owner clicks **Switch to release x.y.z** under Settings → Updates. That installs the latest
release in place of the development build, in the same way as **Update now** (if the release doesn't start, the hub goes
back to the development build), and from then on the hub updates from releases. Running the installer again does the
same.

## By hand

Run the installer again. It installs the latest release over the old one (or the one you ask for with `--version`):

```bash
curl -fsSL https://raw.githubusercontent.com/roguecode/RaptHooker/main/deploy/install.sh | sudo bash
curl -fsSL https://raw.githubusercontent.com/roguecode/RaptHooker/main/deploy/install.sh | sudo bash -s -- --version 0.3.0
```

A hub installed with `--no-bluetooth` keeps Bluetooth off through updates, by hand or from the app: there's no need to
give it again.

or use the copy on the Pi, which does the same as **Update now**:

```bash
sudo bash /opt/rapthooker/deploy/pi/update.sh                          # the latest release
sudo bash /opt/rapthooker/deploy/pi/update.sh --version 0.3.0          # a given one
sudo bash /opt/rapthooker/deploy/pi/update.sh --version 0.9.0-beta.1   # a beta
```

Without internet access on the Pi, download `rapthooker-<version>.tar.gz` and `SHA256SUMS` from
[Releases](https://github.com/roguecode/RaptHooker/releases) on another computer, copy both to the Pi and run
`sudo bash /opt/rapthooker/deploy/install.sh --file rapthooker-<version>.tar.gz`.

If you deploy from a PC with `deploy.ps1`/`deploy.sh`, update by pulling the new code and deploying again, or
[switch to releases](#development-builds). In Docker, rebuild the image from the new code ([docs/docker.md](docker.md)).

## Going back

From a beta, use **Go back to release x.y.z** under Settings → Updates ([Trying a beta](#trying-a-beta)). Otherwise:

```bash
sudo bash /opt/rapthooker/deploy/install.sh --rollback
```

swaps back to the version in `/opt/rapthooker/previous` (and keeps the newer one there, so running it again undoes the
rollback). Your data isn't touched. A newer version may have added to the database; older versions ignore what they
don't know about, and the newer one finds it all again when you update. No release changes the data in a way an older
one can't use (that's tested against every release). If a development build ever did, the older version won't start
rather than damage it: update again, or restore the copy from before the update.

## When something goes wrong

- What the updater did: `journalctl -u rapthooker-update`
- The hub itself: `journalctl -u rapthooker -n 100`
- Is the updater watching? `systemctl status rapthooker-update.path`. If it isn't installed, run the installer again
  (it reinstalls in place and sets it up).
- "GitHub is limiting how often it can be asked": GitHub allows 60 questions an hour from one internet address without
  an account, shared by everything on your network. The hub tries again later by itself.
- "Setting up RaptHooker x.y.z didn't finish", with `Job for bluetooth.service failed` in
  `journalctl -u rapthooker-update`: Bluetooth couldn't start (in a container, say), which stopped updates to 0.9.1
  and earlier. Switch Bluetooth off by running the installer once with `--no-bluetooth`
  ([By hand](#by-hand), and [Without Bluetooth](pi-setup.md#without-bluetooth)); later updates keep it off. Updates
  to later versions carry on without Bluetooth instead.
