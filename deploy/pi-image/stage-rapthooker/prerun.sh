#!/bin/bash -e
# pi-gen stage set-up: start from the previous stage's root filesystem (Raspberry Pi OS Lite, stage2).
if [ ! -d "${ROOTFS_DIR}" ]; then
  copy_previous
fi
