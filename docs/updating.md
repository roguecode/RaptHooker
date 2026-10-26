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

### How it works

The app runs as the `rapthooker` user and can't change its own files (that's on purpose). To ask for an update it
creates `/var/lib/rapthooker/update-request`. `rapthooker-update.path`, a systemd unit installed by setup, notices the
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

or use the copy on the Pi, which does the same as **Update now**:

```bash
sudo bash /opt/rapthooker/deploy/pi/update.sh                    # the latest release
sudo bash /opt/rapthooker/deploy/pi/update.sh --version 0.3.0    # a given one
```

Without internet access on the Pi, download `rapthooker-<version>.tar.gz` and `SHA256SUMS` from
[Releases](https://github.com/roguecode/RaptHooker/releases) on another computer, copy both to the Pi and run
`sudo bash /opt/rapthooker/deploy/install.sh --file rapthooker-<version>.tar.gz`.

If you deploy from a PC with `deploy.ps1`/`deploy.sh`, update by pulling the new code and deploying again, or
[switch to releases](#development-builds). In Docker, rebuild the image from the new code ([docs/docker.md](docker.md)).

## Going back

```bash
sudo bash /opt/rapthooker/deploy/install.sh --rollback
```

swaps back to the version in `/opt/rapthooker/previous` (and keeps the newer one there, so running it again undoes the
rollback). Your data isn't touched. A newer version may have added to the database; older versions ignore what they
don't know about. In the rare case that a newer version has changed the data in a way the older one can't use, the
older one won't start rather than damage it: update again, or restore the copy from before the update.

## When something goes wrong

- What the updater did: `journalctl -u rapthooker-update`
- The hub itself: `journalctl -u rapthooker -n 100`
- Is the updater watching? `systemctl status rapthooker-update.path`. If it isn't installed, run the installer again
  (it reinstalls in place and sets it up).
- "GitHub is limiting how often it can be asked": GitHub allows 60 questions an hour from one internet address without
  an account, shared by everything on your network. The hub tries again later by itself.

## Releasing (for maintainers)

1. Update the version in `package.json` and `src/*/package.json` (`npm version <x.y.z> --workspaces --include-workspace-root --no-git-tag-version`)
   and add a `## [x.y.z] - date` section to [CHANGELOG.md](../CHANGELOG.md).
2. Commit, then tag and push: `git tag vx.y.z && git push origin vx.y.z`.
3. The [release workflow](../.github/workflows/release.yml) checks the tag matches `package.json`, runs the checks,
   builds `rapthooker-<version>.tar.gz` with [deploy/package.mjs](../deploy/package.mjs) (try it with
   `npm run package`), and publishes the release with that CHANGELOG section as its notes, the archive, `SHA256SUMS`
   and `install.sh`. Then it builds the Raspberry Pi image (experimental) and attaches it.

Hubs see the new release within a day.
