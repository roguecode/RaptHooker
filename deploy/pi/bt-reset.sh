#!/usr/bin/env bash
# Switches the Bluetooth radio off and on, for when it's stuck, and tells the app how it went.
# rapthooker-bt-reset.service runs it as root when the app asks: the app creates /var/lib/rapthooker/bt-reset-request
# (when the pills it records go unheard for a long while), which rapthooker-bt-reset.path watches. You can also run it
# yourself:
#   sudo bash /opt/rapthooker/deploy/pi/bt-reset.sh
#
# Bluetooth can get stuck below BlueZ: on a Pi 3, restarting bluetoothd during active discovery left the controller
# refusing to scan while the kernel believed it was scanning, so nothing was heard. Blocking and unblocking the radio
# (rfkill) clears that. bluetoothd switches the adapter back on by itself, and RaptHooker sets up its scanning again.
# The result goes to /var/lib/rapthooker/bt-reset-status.json as { at, ok, error }.
set -euo pipefail

DATA_DIR="/var/lib/rapthooker"
REQUEST="$DATA_DIR/bt-reset-request"
STATUS="$DATA_DIR/bt-reset-status.json"
WAIT_SECONDS=20

json_string() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/ }"
  s="${s//$'\r'/ }"
  s="${s//$'\t'/ }"
  printf '"%s"' "$s"
}

# The data folder belongs to the service user, who could put symlinks in it: everything in it is read and written as
# that user, never as root.
as_service() {
  runuser -u rapthooker -- "$@"
}

# Writes stdin to the file in $1 (through a temporary file). $1 is expanded by the sh that runs it, not here.
# shellcheck disable=SC2016
WRITE_FILE='umask 027 && cat >"$1.tmp" && mv -f "$1.tmp" "$1"'

write_status() {
  local ok="$1" error="$2" error_json="null"
  [[ -d "$DATA_DIR" ]] || return 0
  if [[ -n "$error" ]]; then error_json="$(json_string "$error")"; fi
  printf '{"at":%s,"ok":%s,"error":%s}\n' "$(date +%s%3N)" "$ok" "$error_json" |
    as_service sh -c "$WRITE_FILE" _ "$STATUS" || echo "Couldn't write $STATUS" >&2
}

powered() {
  local shown=""
  shown="$(timeout 5 bluetoothctl show 2>/dev/null || true)"
  [[ "$shown" == *"Powered: yes"* ]]
}

fail() {
  echo "Error: $1" >&2
  write_status false "$1"
  exit 1
}

main() {
  if [[ $EUID -ne 0 ]]; then
    echo "Run with sudo" >&2
    exit 1
  fi
  local reason=""
  if [[ -e "$REQUEST" || -L "$REQUEST" ]]; then
    reason="$(as_service cat "$REQUEST" 2>/dev/null | grep -o '"reason" *: *"[^"]*"' | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/' || true)"
    # Taken. Removing it straight away means the path unit can't start this again and again.
    as_service rm -f "$REQUEST"
  fi
  echo "Resetting the Bluetooth adapter${reason:+ (RaptHooker: $reason)}"

  echo "rfkill block bluetooth"
  rfkill block bluetooth || fail "rfkill couldn't switch Bluetooth off"
  sleep 2
  echo "rfkill unblock bluetooth"
  rfkill unblock bluetooth || fail "rfkill couldn't switch Bluetooth on again"

  local deadline=$((SECONDS + WAIT_SECONDS)) nudge_at=$((SECONDS + 5)) nudged=0
  while ((SECONDS < deadline)); do
    if powered; then
      echo "The Bluetooth adapter is on again"
      write_status true ""
      return 0
    fi
    # bluetoothd normally switches it back on within a second or two.
    if [[ $nudged -eq 0 ]] && ((SECONDS >= nudge_at)); then
      echo "bluetoothctl power on"
      timeout 5 bluetoothctl power on || true
      nudged=1
    fi
    sleep 1
  done
  if powered; then
    write_status true ""
    return 0
  fi
  fail "The Bluetooth adapter didn't come back on within ${WAIT_SECONDS} seconds. On the Pi: bluetoothctl show, rfkill list"
}

main "$@"
