# BlueZ experimental features, for passive Bluetooth scanning (sourced by setup.sh, which provides `step`). Safe to
# re-run: Bluetooth is only restarted when something changed, and then RaptHooker is stopped first and the radio is
# switched off (rfkill) while bluetoothd restarts (see rapthooker_restart_bluetooth).
#
# RaptHooker listens for RAPT Pills passively when it can: an advertisement monitor asks BlueZ to report only adverts
# that carry RAPT manufacturer data, and the radio never transmits scan requests. On a Pi 3 or Zero 2 W, where Wi-Fi
# and Bluetooth share one radio, that leaves Wi-Fi much more air time than ordinary (active) scanning. BlueZ only offers
# advertisement monitors (org.bluez.AdvertisementMonitorManager1) with its experimental D-Bus interfaces switched on,
# which is what this does: "Experimental = true" in the [General] section of /etc/bluetooth/main.conf (BlueZ 5.60 and
# later), or bluetoothd --experimental through a systemd drop-in for older versions.
#
# To undo: set Experimental = false in /etc/bluetooth/main.conf (or delete
# /etc/systemd/system/bluetooth.service.d/rapthooker-experimental.conf and run sudo systemctl daemon-reload), then
# sudo systemctl restart bluetooth. RaptHooker then scans actively, as it does when passive scanning isn't available.

step "Bluetooth: BlueZ experimental features (for passive scanning, kinder to Wi-Fi)"

rapthooker_version_at_least() {
  [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)" == "$2" ]]
}

rapthooker_bluetooth_on() {
  local shown=""
  shown="$(timeout 5 bluetoothctl show 2>/dev/null || true)"
  [[ "$shown" == *"Powered: yes"* ]]
}

# Waits up to $1 seconds for the adapter to be on. bluetoothd switches it back on by itself; if it hasn't after a few
# seconds, it's asked to.
rapthooker_wait_bluetooth_on() {
  local deadline=$((SECONDS + $1)) nudge_at=$((SECONDS + 5)) nudged=0
  while ((SECONDS < deadline)); do
    if rapthooker_bluetooth_on; then return 0; fi
    if [[ $nudged -eq 0 ]] && ((SECONDS >= nudge_at)); then
      timeout 5 bluetoothctl power on >/dev/null 2>&1 || true
      nudged=1
    fi
    sleep 1
  done
  rapthooker_bluetooth_on
}

# Restarting bluetoothd while RaptHooker was in the middle of active discovery once left a Pi 3's controller stuck: the
# kernel believed it was scanning, the controller refused ("Command Disallowed") and nothing was heard until the radio
# was switched off and on. So RaptHooker stops first, the radio stays blocked (rfkill) while bluetoothd restarts, and
# RaptHooker starts again once the adapter is back on.
rapthooker_restart_bluetooth() {
  local state="" was_running=0
  state="$(systemctl is-active rapthooker 2>/dev/null || true)"
  if [[ "$state" == "active" || "$state" == "activating" || "$state" == "reloading" ]]; then
    was_running=1
    echo "Stopping RaptHooker while Bluetooth restarts"
    systemctl stop rapthooker || true
  fi
  rfkill block bluetooth 2>/dev/null || true
  if systemctl restart bluetooth; then
    echo "Restarted bluetooth"
  else
    echo "Couldn't restart bluetooth: reboot to switch the experimental features on"
  fi
  sleep 2
  rfkill unblock bluetooth 2>/dev/null || true
  if systemctl is-active --quiet bluetooth 2>/dev/null; then
    if rapthooker_wait_bluetooth_on 20; then
      echo "The Bluetooth adapter is on"
    else
      echo "The Bluetooth adapter isn't on yet (check with: bluetoothctl show)"
    fi
  fi
  if [[ $was_running -eq 1 ]]; then
    systemctl daemon-reload || true
    systemctl start --no-block rapthooker || true
    echo "Started RaptHooker again"
  fi
}

rapthooker_bluez_experimental() {
  local bluetoothd="" version="" conf=/etc/bluetooth/main.conf changed=0 candidate
  bluetoothd="$(systemctl show -p ExecStart --value bluetooth.service 2>/dev/null | sed -n 's/.*path=\([^ ;]*\).*/\1/p' | head -n 1 || true)"
  if [[ -z "$bluetoothd" || ! -x "$bluetoothd" ]]; then
    for candidate in /usr/libexec/bluetooth/bluetoothd /usr/lib/bluetooth/bluetoothd /usr/sbin/bluetoothd; do
      if [[ -x "$candidate" ]]; then
        bluetoothd="$candidate"
        break
      fi
    done
  fi
  if [[ -z "$bluetoothd" || ! -x "$bluetoothd" ]]; then
    echo "bluetoothd not found: skipped (RaptHooker will scan actively)"
    return 0
  fi
  version="$("$bluetoothd" --version 2>/dev/null | head -n 1 | tr -d '[:space:]' || true)"
  echo "BlueZ ${version:-(version unknown)} (${bluetoothd})"

  if [[ "$version" =~ ^[0-9]+\.[0-9]+ ]] && rapthooker_version_at_least "$version" 5.60; then
    # Already on? (an uncommented "Experimental = true" in [General])
    if [[ -f "$conf" ]] && awk '
        BEGIN { found = 1 }
        /^[ \t]*\[.*\][ \t]*$/ { general = ($0 ~ /^[ \t]*\[General\][ \t]*$/); next }
        general && /^[ \t]*Experimental[ \t]*=[ \t]*[Tt][Rr][Uu][Ee][ \t]*$/ { found = 0 }
        END { exit found }' "$conf"; then
      echo "Already switched on in ${conf}"
    else
      local backup=""
      if [[ -f "$conf" ]]; then
        [[ -e "${conf}.before-rapthooker" ]] || cp -p "$conf" "${conf}.before-rapthooker"
        backup=" (the original is ${conf}.before-rapthooker)"
        # Sets "Experimental = true" in [General]: after its commented-out default, in place of an existing setting, or
        # at the end of the section (adding [General] if there isn't one).
        awk '
          function put() { if (!done) { print "Experimental = true"; done = 1 } }
          /^[ \t]*\[.*\][ \t]*$/ {
            if (general) put()
            general = ($0 ~ /^[ \t]*\[General\][ \t]*$/)
            if (general) seen = 1
            print
            next
          }
          general && /^[ \t]*#[ \t]*Experimental[ \t]*=/ { print; put(); next }
          general && /^[ \t]*Experimental[ \t]*=/ { put(); next }
          { print }
          END {
            if (general) put()
            if (!seen) { print ""; print "[General]"; print "Experimental = true" }
          }' "$conf" > "${conf}.rapthooker-new"
      else
        install -d -m 755 "$(dirname "$conf")"
        printf '[General]\nExperimental = true\n' > "${conf}.rapthooker-new"
      fi
      chmod 644 "${conf}.rapthooker-new"
      mv "${conf}.rapthooker-new" "$conf"
      echo "Set Experimental = true in ${conf}${backup}"
      changed=1
    fi
  else
    # Older BlueZ: start bluetoothd with --experimental instead, keeping whatever else it's started with.
    local dropin_dir=/etc/systemd/system/bluetooth.service.d
    local dropin="${dropin_dir}/rapthooker-experimental.conf"
    local argv=""
    argv="$(systemctl show -p ExecStart --value bluetooth.service 2>/dev/null | sed -n 's/.*argv\[\]=\([^;]*\);.*/\1/p' | head -n 1 | sed 's/[[:space:]]*$//' || true)"
    if [[ " $argv " == *" --experimental "* || " $argv " == *" -E "* ]]; then
      echo "bluetoothd already starts with --experimental"
    else
      [[ -n "$argv" ]] || argv="$bluetoothd"
      install -d -m 755 "$dropin_dir"
      printf '[Service]\n# RaptHooker: BlueZ experimental features, for passive Bluetooth scanning.\nExecStart=\nExecStart=%s --experimental\n' \
        "$argv" > "$dropin"
      chmod 644 "$dropin"
      systemctl daemon-reload
      echo "bluetoothd now starts with --experimental (${dropin})"
      changed=1
    fi
  fi

  if [[ $changed -eq 1 ]]; then
    rapthooker_restart_bluetooth
  fi

  # Report what RaptHooker will find.
  local adapters="" adapter="" members=""
  adapters="$(busctl --system --list tree org.bluez 2>/dev/null | grep -E '^/org/bluez/hci[0-9]+$' || true)"
  if [[ -z "$adapters" ]]; then
    echo "No Bluetooth adapter showing yet (check with: bluetoothctl list)"
    return 0
  fi
  for adapter in $adapters; do
    members="$(busctl --system introspect org.bluez "$adapter" 2>/dev/null || true)"
    if [[ "$members" == *org.bluez.AdvertisementMonitorManager1* ]]; then
      echo "${adapter##*/}: passive scanning available"
    else
      echo "${adapter##*/}: no passive scanning (RaptHooker scans actively there; see the Bluetooth section of docs/pi-setup.md)"
    fi
  done
}

rapthooker_bluez_experimental
unset -f rapthooker_bluez_experimental rapthooker_version_at_least rapthooker_restart_bluetooth rapthooker_wait_bluetooth_on \
  rapthooker_bluetooth_on
