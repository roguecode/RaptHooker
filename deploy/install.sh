#!/usr/bin/env bash
# Installs RaptHooker on a Raspberry Pi from a GitHub release, or updates it. Safe to run again: it reinstalls or
# upgrades, keeping your data and settings.
#
#   curl -fsSL https://raw.githubusercontent.com/roguecode/RaptHooker/main/deploy/install.sh | sudo bash
#   curl -fsSL https://raw.githubusercontent.com/roguecode/RaptHooker/main/deploy/install.sh | sudo bash -s -- --version 0.3.0 --hostname rapthooker --tailscale
#
# Supported: Raspberry Pi 3, 4, 5 and Zero 2 W with Raspberry Pi OS (64-bit recommended), or another Debian-based Linux
# with systemd and Bluetooth. Not the original Pi Zero W / Pi 1 (ARMv6).
set -euo pipefail

REPO="${RAPTHOOKER_REPO:-roguecode/RaptHooker}"
APP_DIR="/opt/rapthooker"
WORK_DIR="/opt/rapthooker.work"
CONFIG="/etc/rapthooker/rapthooker.config.json"
# What a release puts in APP_DIR, plus the installer's marker, and deploy.ps1/deploy.sh's marker for a development build
# (which a release replaces, and a rollback brings back). They move to APP_DIR/previous on each update.
ITEMS=(server web deploy LICENSE README.md CHANGELOG.md attribution.md VERSION .installer .dev-build)

VERSION=""
FROM=""
HOSTNAME_ARG=""
WITH_TAILSCALE=0
ARCHIVE=""
UPDATE=0
ROLLBACK=0
HAD_PREVIOUS=0

say() { echo -e "\n==> $*"; }
warn() { echo "Warning: $*" >&2; }
die() {
  echo "Error: $*" >&2
  exit 1
}

usage() {
  cat <<EOF
Installs or updates RaptHooker from https://github.com/$REPO/releases

  curl -fsSL https://raw.githubusercontent.com/$REPO/main/deploy/install.sh | sudo bash -s -- [options]
  sudo bash /opt/rapthooker/deploy/install.sh [options]

Options:
  --version X.Y.Z   install this release instead of the latest one
  --hostname NAME   rename the Pi (it's then NAME.local); by default its name is left alone
  --tailscale       also install Tailscale (for HTTPS and access away from home)
  --file PATH       install a rapthooker-X.Y.Z.tar.gz you downloaded (checked against SHA256SUMS next to it)
  --rollback        go back to the version that was installed before the last update
  --update          used by the in-app updater: quieter, and does nothing if that version is already running
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --version)
        [[ $# -ge 2 ]] || die "--version needs a version, e.g. --version 0.3.0"
        VERSION="${2#v}"
        shift 2
        ;;
      --hostname)
        [[ $# -ge 2 ]] || die "--hostname needs a name"
        HOSTNAME_ARG="$2"
        shift 2
        ;;
      --keep-hostname)
        HOSTNAME_ARG=""
        shift
        ;;
      --tailscale)
        WITH_TAILSCALE=1
        shift
        ;;
      --file)
        [[ $# -ge 2 ]] || die "--file needs the path of a rapthooker-X.Y.Z.tar.gz"
        ARCHIVE="$2"
        shift 2
        ;;
      --update)
        UPDATE=1
        shift
        ;;
      --rollback)
        ROLLBACK=1
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) die "Unknown option: $1 (see --help)" ;;
    esac
  done
  if [[ -n "$VERSION" && ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
    die "'$VERSION' isn't a version number like 0.3.0"
  fi
  if [[ -n "$HOSTNAME_ARG" && ! "$HOSTNAME_ARG" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$ ]]; then
    die "'$HOSTNAME_ARG' isn't a valid hostname (letters, digits and hyphens)"
  fi
}

check_system() {
  if [[ $EUID -ne 0 ]]; then
    die "Run this as root: curl -fsSL https://raw.githubusercontent.com/$REPO/main/deploy/install.sh | sudo bash"
  fi
  local arch
  arch="$(uname -m)"
  case "$arch" in
    aarch64 | arm64) ;;
    armv7l) warn "32-bit Raspberry Pi OS works, but the 64-bit version is recommended." ;;
    armv6l)
      die "This looks like an original Pi Zero W or Pi 1 (ARMv6). Current Node.js doesn't run on those, so RaptHooker needs a Pi 3, 4, 5 or Zero 2 W."
      ;;
    x86_64) warn "This isn't a Raspberry Pi. RaptHooker should still work on Debian-based Linux with Bluetooth." ;;
    *) die "Unsupported processor ($arch). RaptHooker needs a Raspberry Pi 3, 4, 5 or Zero 2 W." ;;
  esac
  if [[ ! -r /etc/os-release ]] || ! command -v apt-get >/dev/null || ! command -v systemctl >/dev/null; then
    die "RaptHooker installs on Raspberry Pi OS or another Debian-based Linux with systemd."
  fi
  local id like
  # shellcheck source=/dev/null
  id="$(. /etc/os-release && echo "${ID:-}")"
  # shellcheck source=/dev/null
  like="$(. /etc/os-release && echo "${ID_LIKE:-}")"
  if [[ "$id" != "debian" && "$id" != "raspbian" && " $like " != *" debian "* ]]; then
    warn "This isn't Raspberry Pi OS or Debian ($id). Carrying on, but it hasn't been tried."
  fi
}

ensure_tools() {
  local missing=()
  command -v curl >/dev/null || missing+=(curl)
  [[ -e /etc/ssl/certs/ca-certificates.crt ]] || missing+=(ca-certificates)
  command -v tar >/dev/null || missing+=(tar)
  command -v gzip >/dev/null || missing+=(gzip)
  command -v sha256sum >/dev/null || missing+=(coreutils)
  command -v flock >/dev/null || missing+=(util-linux)
  if [[ ${#missing[@]} -gt 0 ]]; then
    say "Installing ${missing[*]}"
    apt-get update </dev/null
    apt-get install -y "${missing[@]}" </dev/null
  fi
}

lock() {
  exec 9>/run/rapthooker-install.lock
  flock -n 9 || die "Another RaptHooker install or update is running. Try again when it has finished."
}

# GitHub's API first; the releases page's redirect if the API is rate limited.
latest_version() {
  local json tag="" url
  json="$(curl -fsSL --retry 2 --connect-timeout 15 -H 'Accept: application/vnd.github+json' -H 'User-Agent: rapthooker-installer' \
    "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null || true)"
  tag="$(printf '%s' "$json" | grep -o '"tag_name": *"[^"]*"' | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/' || true)"
  if [[ -z "$tag" ]]; then
    url="$(curl -fsSL --retry 2 --connect-timeout 15 -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" 2>/dev/null || true)"
    if [[ "$url" == */releases/tag/* ]]; then tag="${url##*/releases/tag/}"; fi
  fi
  [[ -n "$tag" ]] || die "Couldn't find the latest release of $REPO. Is the Pi online? (Releases: https://github.com/$REPO/releases)"
  echo "${tag#v}"
}

installed_version() {
  if [[ -f "$APP_DIR/VERSION" ]]; then
    tr -d '[:space:]' <"$APP_DIR/VERSION"
  elif [[ -f "$APP_DIR/.installer" ]]; then
    sed -n 's/^version=//p' "$APP_DIR/.installer" | head -n 1
  fi
}

verify() {
  local file="$1" sums="$2" name expected actual
  name="$(basename "$file")"
  expected="$(awk -v f="$name" '$2 == f || $2 == "*" f { print $1; exit }' "$sums")"
  [[ -n "$expected" ]] || die "$name isn't listed in $(basename "$sums")."
  actual="$(sha256sum "$file" | awk '{ print $1 }')"
  [[ "$expected" == "$actual" ]] || die "$name is damaged or isn't the real release (its checksum doesn't match). Nothing was changed."
  echo "Checksum OK"
}

download() {
  local name="rapthooker-$VERSION.tar.gz" base="https://github.com/$REPO/releases/download/v$VERSION"
  say "Downloading RaptHooker $VERSION"
  curl -fSL --retry 3 --connect-timeout 15 -o "$WORK_DIR/$name" "$base/$name" ||
    die "Couldn't download $name. Does release v$VERSION exist? See https://github.com/$REPO/releases"
  curl -fsSL --retry 3 --connect-timeout 15 -o "$WORK_DIR/SHA256SUMS" "$base/SHA256SUMS" ||
    die "Couldn't download the checksums for v$VERSION."
  verify "$WORK_DIR/$name" "$WORK_DIR/SHA256SUMS"
  ARCHIVE="$WORK_DIR/$name"
}

unpack() {
  local into="$WORK_DIR/new" packaged=""
  say "Unpacking"
  rm -rf "$into"
  mkdir -p "$into"
  tar -xzf "$ARCHIVE" -C "$into" --no-same-owner --no-same-permissions
  [[ -f "$into/server/rapthooker.cjs" && -d "$into/web/dist" && -f "$into/deploy/pi/setup.sh" ]] ||
    die "$(basename "$ARCHIVE") doesn't look like a RaptHooker release."
  rm -f "$into/.installer"
  chown -R root:root "$into"
  chmod -R u=rwX,go=rX "$into"
  if [[ -f "$into/VERSION" ]]; then packaged="$(tr -d '[:space:]' <"$into/VERSION")"; fi
  if [[ -z "$VERSION" ]]; then
    VERSION="$packaged"
  elif [[ -n "$packaged" && "$packaged" != "$VERSION" ]]; then
    die "The archive holds version $packaged, not $VERSION."
  fi
}

# Moves the running version to previous/ and the new one in, folder by folder (as deploy.ps1 does), so the hub is
# down for as short a time as possible: it keeps running until it's restarted.
swap_in() {
  local item
  mkdir -p "$APP_DIR"
  if [[ -e "$APP_DIR/server" ]]; then
    HAD_PREVIOUS=1
    rm -rf "$APP_DIR/previous"
    mkdir "$APP_DIR/previous"
    for item in "${ITEMS[@]}"; do
      if [[ -e "$APP_DIR/$item" ]]; then mv "$APP_DIR/$item" "$APP_DIR/previous/$item"; fi
    done
  fi
  for item in "${ITEMS[@]}"; do
    if [[ -e "$WORK_DIR/new/$item" ]]; then mv "$WORK_DIR/new/$item" "$APP_DIR/$item"; fi
  done
}

# Puts previous/ back, and keeps what it replaced in previous/ (so a rollback can be undone the same way).
swap_back() {
  local item
  [[ -d "$APP_DIR/previous/server" ]] || return 1
  rm -rf "$WORK_DIR/back"
  mkdir -p "$WORK_DIR/back"
  for item in "${ITEMS[@]}"; do
    if [[ -e "$APP_DIR/$item" ]]; then mv "$APP_DIR/$item" "$WORK_DIR/back/$item"; fi
    if [[ -e "$APP_DIR/previous/$item" ]]; then mv "$APP_DIR/previous/$item" "$APP_DIR/$item"; fi
  done
  rm -rf "$APP_DIR/previous"
  mv "$WORK_DIR/back" "$APP_DIR/previous"
}

run_setup() {
  local args=()
  if [[ -n "$HOSTNAME_ARG" ]]; then args+=(--hostname "$HOSTNAME_ARG"); else args+=(--keep-hostname); fi
  if [[ $WITH_TAILSCALE -eq 1 ]]; then args+=(--tailscale); fi
  bash "$APP_DIR/deploy/pi/setup.sh" "${args[@]}" </dev/null
}

# Tells the app it was installed this way, so it may update itself.
mark_installed() {
  printf 'version=%s\ninstalled=%s\nrepo=%s\n' "$VERSION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$REPO" >"$APP_DIR/.installer"
  chmod 644 "$APP_DIR/.installer"
}

config_value() {
  if [[ -f "$CONFIG" ]] && command -v node >/dev/null; then
    node -e 'try{const c=require(process.argv[1]);const v=c[process.argv[2]];if(v!==undefined)process.stdout.write(String(v))}catch{}' \
      "$CONFIG" "$1" 2>/dev/null || true
  fi
}

hub_port() {
  local port
  port="$(config_value port)"
  echo "${port:-8080}"
}

status_url() {
  local host
  host="$(config_value host)"
  case "$host" in
    "" | "::" | "0.0.0.0" | "::0") host="127.0.0.1" ;;
    *:*) host="[$host]" ;;
  esac
  echo "http://$host:$(hub_port)/api/status"
}

running_version_is() {
  local pattern="\"version\":\"$1"
  if [[ -n "$1" ]]; then pattern+='"'; fi
  curl -fsS --max-time 3 "$(status_url)" 2>/dev/null | grep -qF "$pattern"
}

# Restarts the hub and waits until the new process answers with the expected version (any version if that's unknown).
# --no-block: the service is Type=notify, so a blocking restart would wait up to its own start timeout instead of ours.
restart_and_wait() {
  local expect="$1" seconds="$2" waited=0 old_pid pid
  systemctl daemon-reload
  old_pid="$(main_pid)"
  systemctl restart --no-block rapthooker || return 1
  while ((waited < seconds)); do
    pid="$(main_pid)"
    # Until the old process has gone, it could still be the one answering.
    if [[ -z "$pid" || ("$pid" != "0" && "$pid" != "$old_pid") ]] && running_version_is "$expect"; then return 0; fi
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

main_pid() {
  systemctl show --property MainPID --value rapthooker 2>/dev/null || true
}

rollback() {
  local reason="$1" back
  if [[ $HAD_PREVIOUS -ne 1 ]] || ! swap_back; then
    die "$reason See: journalctl -u rapthooker -n 50"
  fi
  back="$(installed_version)"
  warn "$reason Going back to ${back:-the previous version}."
  bash "$APP_DIR/deploy/pi/setup.sh" --keep-hostname </dev/null || warn "Setting up the previous version again didn't finish."
  if restart_and_wait "$back" 60; then
    die "$reason RaptHooker ${back:-(the previous version)} is running again."
  fi
  die "$reason Went back to the previous version, but it didn't answer either. See: journalctl -u rapthooker -n 50"
}

print_addresses() {
  local port ip
  port="$(hub_port)"
  echo
  echo "RaptHooker ${VERSION} is running. Open it in a browser on the same network:"
  echo "  http://$(hostname).local:$port"
  for ip in $(hostname -I 2>/dev/null || true); do
    if [[ "$ip" != *:* ]]; then echo "  http://$ip:$port"; fi
  done
  if command -v tailscale >/dev/null; then
    echo "Through Tailscale (HTTPS, and away from home), after: sudo tailscale up && sudo tailscale serve --bg http://127.0.0.1:$port"
  fi
  if [[ -z "$FROM" ]]; then
    echo
    echo "Next: create your owner PIN under Settings, then put your RAPT Pill in Bluetooth mode (see the README)."
  fi
}

do_rollback() {
  [[ -d "$APP_DIR/previous/server" ]] || die "There's no previous version in $APP_DIR/previous to go back to."
  HAD_PREVIOUS=1
  swap_back
  VERSION="$(installed_version)"
  say "Going back from ${FROM:-this version} to ${VERSION:-the previous version}"
  bash "$APP_DIR/deploy/pi/setup.sh" --keep-hostname </dev/null
  restart_and_wait "$VERSION" 90 || die "RaptHooker didn't start. See: journalctl -u rapthooker -n 50"
  print_addresses
}

main() {
  parse_args "$@"
  check_system
  ensure_tools
  lock
  rm -rf "$WORK_DIR"
  mkdir -p "$WORK_DIR"
  trap 'rm -rf "$WORK_DIR"' EXIT
  FROM="$(installed_version)"

  if [[ $ROLLBACK -eq 1 ]]; then
    do_rollback
    return
  fi

  if [[ -n "$ARCHIVE" ]]; then
    [[ -f "$ARCHIVE" ]] || die "No such file: $ARCHIVE"
    if [[ -f "$(dirname "$ARCHIVE")/SHA256SUMS" ]]; then
      verify "$ARCHIVE" "$(dirname "$ARCHIVE")/SHA256SUMS"
    else
      warn "No SHA256SUMS next to $(basename "$ARCHIVE"): installing it without checking."
    fi
  else
    if [[ -z "$VERSION" ]]; then VERSION="$(latest_version)"; fi
    if [[ $UPDATE -eq 1 && "$FROM" == "$VERSION" ]] && running_version_is "$VERSION"; then
      echo "RaptHooker $VERSION is already installed and running."
      return
    fi
    download
  fi
  unpack

  if [[ -n "$FROM" && "$FROM" != "$VERSION" ]]; then
    say "Updating RaptHooker from $FROM to ${VERSION:-a new version}"
  else
    say "Installing RaptHooker ${VERSION}"
  fi
  swap_in
  if ! run_setup; then rollback "Setting up RaptHooker ${VERSION} didn't finish."; fi
  mark_installed
  say "Starting RaptHooker"
  local limit=90
  if [[ $UPDATE -eq 1 ]]; then limit=60; fi
  if ! restart_and_wait "$VERSION" "$limit"; then
    rollback "RaptHooker ${VERSION} didn't start within $limit seconds."
  fi
  if [[ $UPDATE -eq 1 ]]; then
    echo "RaptHooker $VERSION is running."
  else
    print_addresses
  fi
}

# Everything runs from here, so a partly downloaded script (curl | bash) does nothing, and replacing this file while
# it runs can't change what it does.
main "$@"
