# shellcheck shell=bash
# bluetoothd restarting itself after a crash (sourced by setup.sh, which provides `step`). Safe to re-run.
#
# Nothing is heard while bluetoothd is down. RaptHooker starts it again when it retries (asking BlueZ for its objects
# starts bluetooth.service through D-Bus, as dbus-org.bluez.service), and this drop-in has systemd restart it after a
# crash too. Bluetooth isn't restarted for it.
#
# To undo: sudo rm /etc/systemd/system/bluetooth.service.d/rapthooker-restart.conf && sudo systemctl daemon-reload

step "Bluetooth: restarting bluetoothd if it crashes"

rapthooker_bluetooth_restart() {
  local dir=/etc/systemd/system/bluetooth.service.d
  local dropin="${dir}/rapthooker-restart.conf"
  local want
  want="$(printf '%s\n' '# RaptHooker: start bluetoothd again if it crashes (setup.d/21-bluetooth-restart.sh).' \
    '[Service]' 'Restart=on-failure' 'RestartSec=5')"
  if [[ -f "$dropin" && "$(<"$dropin")" == "$want" ]]; then
    echo "Already set up (${dropin})"
    return 0
  fi
  install -d -m 755 "$dir"
  printf '%s\n' "$want" >"${dropin}.rapthooker-new"
  chmod 644 "${dropin}.rapthooker-new"
  mv "${dropin}.rapthooker-new" "$dropin"
  systemctl daemon-reload
  echo "bluetoothd restarts by itself after a crash (${dropin})"
}

rapthooker_bluetooth_restart
unset -f rapthooker_bluetooth_restart
