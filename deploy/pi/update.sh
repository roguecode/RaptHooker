#!/usr/bin/env bash
# Updates RaptHooker to a new release and tells the app how it went. rapthooker-update.service runs it as root when the
# app asks for an update: the app creates /var/lib/rapthooker/update-request, which rapthooker-update.path watches.
# You can also run it yourself:
#   sudo bash /opt/rapthooker/deploy/pi/update.sh [--version X.Y.Z]
#
# The work is done by deploy/install.sh --update: download and check the release, swap the folders (keeping the old
# version in /opt/rapthooker/previous), set up, restart, and go back to the old version if the new one doesn't answer
# within a minute. The result goes to /var/lib/rapthooker/update-status.json as { ok, version, from, at, error }.
set -euo pipefail

APP_DIR="/opt/rapthooker"
DATA_DIR="/var/lib/rapthooker"
REQUEST="$DATA_DIR/update-request"
STATUS="$DATA_DIR/update-status.json"

json_string() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/ }"
  s="${s//$'\r'/ }"
  s="${s//$'\t'/ }"
  printf '"%s"' "$s"
}

json_or_null() {
  if [[ -n "$1" ]]; then json_string "$1"; else printf 'null'; fi
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
  local ok="$1" version="$2" from="$3" error="$4"
  [[ -d "$DATA_DIR" ]] || return 0
  printf '{"ok":%s,"version":%s,"from":%s,"at":%s,"error":%s}\n' "$ok" "$(json_or_null "$version")" \
    "$(json_or_null "$from")" "$(date +%s%3N)" "$(json_or_null "$error")" |
    as_service sh -c "$WRITE_FILE" _ "$STATUS" || echo "Couldn't write $STATUS" >&2
}

installed_version() {
  if [[ -f "$APP_DIR/VERSION" ]]; then
    tr -d '[:space:]' <"$APP_DIR/VERSION"
  elif [[ -f "$APP_DIR/.installer" ]]; then
    sed -n 's/^version=//p' "$APP_DIR/.installer" | head -n 1
  fi
}

main() {
  if [[ $EUID -ne 0 ]]; then
    echo "Run with sudo" >&2
    exit 1
  fi
  local version="" requested=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --version)
        [[ $# -ge 2 ]] || { echo "--version needs a version, e.g. --version 0.3.0" >&2; exit 1; }
        version="${2#v}"
        shift 2
        ;;
      *)
        echo "Unknown option: $1" >&2
        exit 1
        ;;
    esac
  done

  if [[ -e "$REQUEST" || -L "$REQUEST" ]]; then
    requested="$(as_service cat "$REQUEST" 2>/dev/null | grep -o '"version" *: *"[^"]*"' | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/' || true)"
    # Taken. Removing it straight away means the path unit can't start this again and again.
    as_service rm -f "$REQUEST"
    if [[ -z "$version" ]]; then version="$requested"; fi
  fi
  if [[ -n "$version" && ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Ignoring the requested version '$version': updating to the latest release instead."
    version=""
  fi

  local from installer copy log code=0 now error
  from="$(installed_version)"
  installer="$APP_DIR/deploy/install.sh"
  if [[ ! -f "$installer" ]]; then
    error="This hub wasn't set up with the installer, so it can't update itself. See docs/updating.md."
    write_status false "$version" "$from" "$error"
    echo "Error: $error" >&2
    exit 1
  fi

  # Run a copy: the update moves the folder this script and install.sh live in.
  copy="/run/rapthooker-install.sh"
  log="/run/rapthooker-update.log"
  cp "$installer" "$copy"
  echo "Updating RaptHooker from ${from:-an unknown version} to ${version:-the latest release}"
  local args=(--update)
  if [[ -n "$version" ]]; then args+=(--version "$version"); fi
  bash "$copy" "${args[@]}" </dev/null 2>&1 | tee "$log" || code=$?

  now="$(installed_version)"
  if [[ $code -eq 0 ]]; then
    write_status true "${now:-$version}" "$from" ""
  else
    error="$(sed -n 's/^Error: //p' "$log" | tail -n 1)"
    if [[ -z "$error" ]]; then error="The update stopped with an error (code $code). On the Pi: journalctl -u rapthooker-update"; fi
    write_status false "$version" "$from" "$error"
  fi
  rm -f "$copy" "$log"
  return "$code"
}

main "$@"
