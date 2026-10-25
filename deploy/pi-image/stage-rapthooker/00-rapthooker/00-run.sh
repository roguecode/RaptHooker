#!/bin/bash -e
# Runs on the build machine: copies the release (downloaded by .github/workflows/pi-image.yml into files/) and the
# first-boot unit into the image. 01-run-chroot.sh installs them.
if [ ! -f files/rapthooker.tar.gz ]; then
  echo "files/rapthooker.tar.gz is missing: the workflow downloads it from the release" >&2
  exit 1
fi
install -d "${ROOTFS_DIR}/opt/rapthooker.image"
install -m 644 files/rapthooker.tar.gz "${ROOTFS_DIR}/opt/rapthooker.image/rapthooker.tar.gz"
install -m 644 files/rapthooker-firstboot.service "${ROOTFS_DIR}/etc/systemd/system/rapthooker-firstboot.service"
