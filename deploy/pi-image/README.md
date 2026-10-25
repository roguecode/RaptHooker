# Raspberry Pi image (experimental)

[.github/workflows/pi-image.yml](../../.github/workflows/pi-image.yml) builds a Raspberry Pi OS Lite (64-bit) image
with RaptHooker already installed, using [pi-gen](https://github.com/RPi-Distro/pi-gen) through
[usimd/pi-gen-action](https://github.com/usimd/pi-gen-action). It runs after each release (and can be started by hand
from the Actions tab), on GitHub's Arm runners, and attaches `*.img.xz` to the release.

[stage-rapthooker](stage-rapthooker) is a pi-gen stage added after stage2 (Raspberry Pi OS Lite):

- `prerun.sh` starts from stage2's root filesystem.
- `00-rapthooker/00-run.sh` (on the build machine) copies the release archive, which the workflow downloads into
  `00-rapthooker/files/`, and the first-boot unit into the image.
- `00-rapthooker/01-run-chroot.sh` (inside the image) unpacks the release into `/opt/rapthooker` and runs
  [setup.sh](../pi/setup.sh) with `systemctl` start/restart/reload skipped, since nothing is running while an image is
  built. Services are enabled to start at boot. It writes `/opt/rapthooker/.installer`, so the hub can update itself.
- `rapthooker-firstboot.service` runs setup.sh once more on the first boot (when there's a network), for anything that
  needs a running system.

The image is called `rapthooker` and has SSH enabled, but no usable login: the user (named `pi` until renamed) has no
password. Set a username and password (and Wi-Fi) with Raspberry Pi Imager's OS customisation when writing the card;
otherwise Raspberry Pi OS asks for them on the first boot, on a screen and keyboard. The locale, time zone and keyboard
default to British English (`en_GB.UTF-8`, Europe/London); Imager's customisation can change those too.

This can't be tested without the GitHub runners and a Pi. If it fails, the one-line installer is the way to go.
