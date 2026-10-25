# USB stick backups (sourced by setup.sh, which provides `step`). Safe to re-run.
#
# A stick named RAPTHOOKER is mounted by systemd at /mnt/rapthooker whenever RaptHooker uses it (and unmounted again
# a minute later), and the service is allowed to write there. Switch "Copy to a USB stick" on under Settings > Backups.
#
# The uid/gid/umask mount options make the files belong to the rapthooker user. They only work for FAT32, exFAT and
# NTFS sticks, which is how sticks come from the shop. An ext4 stick won't mount with them: either reformat it as
# FAT32/exFAT, or take ",uid=rapthooker,gid=rapthooker,umask=0027" out of the line in /etc/fstab and, with the stick
# mounted, run: sudo chown rapthooker:rapthooker /mnt/rapthooker

step "USB stick backups (a stick named RAPTHOOKER)"
usb_mnt=/mnt/rapthooker
usb_line="LABEL=RAPTHOOKER ${usb_mnt} auto nofail,noauto,x-systemd.automount,x-systemd.device-timeout=5s,x-systemd.idle-timeout=60,uid=rapthooker,gid=rapthooker,umask=0027 0 0"

if [[ ! -d "$usb_mnt" ]]; then
  # Owned by root while no stick is mounted, so nothing can land on the SD card by mistake.
  install -d -o root -g root -m 755 "$usb_mnt"
  echo "Created ${usb_mnt}"
fi

if grep -qE "^[[:space:]]*LABEL=RAPTHOOKER[[:space:]]|^[^#]*[[:space:]]${usb_mnt}[[:space:]]" /etc/fstab; then
  echo "/etc/fstab already mounts something at ${usb_mnt}: left as it is"
else
  [[ -e /etc/fstab.before-rapthooker ]] || cp /etc/fstab /etc/fstab.before-rapthooker
  printf '\n# RaptHooker USB backups: a stick named RAPTHOOKER (FAT32/exFAT), mounted when used\n%s\n' "$usb_line" >> /etc/fstab
  echo "Added the RAPTHOOKER stick to /etc/fstab (the old file is /etc/fstab.before-rapthooker)"
fi

install -d -m 755 /etc/systemd/system/rapthooker.service.d
usb_dropin=/etc/systemd/system/rapthooker.service.d/usb-backup.conf
usb_conf="$(printf '[Service]\n# The leading "-" ignores the folder if it is missing.\nReadWritePaths=-%s\n' "$usb_mnt")"
if [[ -f "$usb_dropin" && "$(cat "$usb_dropin")" == "$usb_conf" ]]; then
  echo "The service may already write to ${usb_mnt}"
else
  printf '%s\n' "$usb_conf" > "$usb_dropin"
  chmod 644 "$usb_dropin"
  echo "The service may now write to ${usb_mnt} (${usb_dropin})"
fi

systemctl daemon-reload
usb_unit="$(systemd-escape -p --suffix=automount "$usb_mnt")"
if systemctl start "$usb_unit" 2>/dev/null; then
  echo "Watching for the stick (${usb_unit})"
else
  echo "Couldn't start ${usb_unit} now; it starts at the next boot"
fi
if [[ -e /dev/disk/by-label/RAPTHOOKER ]]; then
  echo "A RAPTHOOKER stick is plugged in"
else
  echo "No RAPTHOOKER stick plugged in right now (that's fine: plug one in whenever you like)"
fi
