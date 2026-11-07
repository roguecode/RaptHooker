#!/usr/bin/env bash
# One-time (and safe to re-run) Raspberry Pi setup for RaptHooker. Run on the Pi after the files are in place:
#   sudo bash /opt/rapthooker/deploy/pi/setup.sh [--hostname NAME | --keep-hostname] [--tailscale] [--no-bluetooth | --bluetooth]
#
# Supported: Raspberry Pi 3/4/5 and Zero 2 W running Raspberry Pi OS (64-bit recommended). The original Pi Zero W
# (ARMv6) isn't supported: current Node.js releases aren't built for it.
#
# --no-bluetooth (for a machine without Bluetooth, like a container) sets bluetooth.enabled to false in the config, so the
# app never uses Bluetooth and later runs (updates) skip setting it up too. --bluetooth switches it back on. A new hub in
# a container starts with it off without being asked.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "Run with sudo" >&2; exit 1; fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG=/etc/rapthooker/rapthooker.config.json
NODE_MAJOR=24
PI_HOSTNAME="rapthooker"
SET_HOSTNAME=1
WITH_TAILSCALE=0
BLUETOOTH_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hostname) PI_HOSTNAME="$2"; shift 2 ;;
    --keep-hostname) SET_HOSTNAME=0; shift ;;
    --tailscale) WITH_TAILSCALE=1; shift ;;
    --bluetooth) BLUETOOTH_ARG=on; shift ;;
    --no-bluetooth) BLUETOOTH_ARG=off; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

step() { echo -e "\n==> $*"; }

arch="$(uname -m)"
if [[ "$arch" == "armv6l" ]]; then
  echo "This looks like an original Pi Zero / Pi 1 (ARMv6). RaptHooker needs a Pi 3, 4, 5 or Zero 2 W." >&2
  exit 1
fi

if [[ $SET_HOSTNAME -eq 1 ]]; then
  step "Setting the hostname to ${PI_HOSTNAME}"
  old="$(hostname)"
  if [[ "$old" != "$PI_HOSTNAME" ]]; then
    hostnamectl set-hostname "$PI_HOSTNAME"
    if grep -qE "^127\.0\.1\.1\s" /etc/hosts; then
      sed -i -E "s/^127\.0\.1\.1\s.*/127.0.1.1\t${PI_HOSTNAME}/" /etc/hosts
    else
      printf '127.0.1.1\t%s\n' "$PI_HOSTNAME" >> /etc/hosts
    fi
    # cloud-init would put the old name back on the next boot.
    if [[ -d /etc/cloud/cloud.cfg.d ]]; then
      printf 'preserve_hostname: true\nmanage_etc_hosts: false\n' > /etc/cloud/cloud.cfg.d/99-rapthooker-hostname.cfg
    fi
    if [[ -f /boot/firmware/user-data ]]; then
      sed -i -E "s/^hostname: .*/hostname: ${PI_HOSTNAME}/" /boot/firmware/user-data
    fi
    systemctl restart avahi-daemon 2>/dev/null || true
    echo "Renamed from '${old}': the Pi is now ${PI_HOSTNAME}.local"
  fi
fi

step "Installing packages"
apt-get update
# BlueZ even with Bluetooth off: it provides the bluetooth group the service runs in.
apt-get install -y ca-certificates curl gnupg bluez avahi-daemon rfkill systemd-timesyncd

step "Node.js"
current="$(node -p 'process.versions.node' 2>/dev/null || echo 0.0.0)"
major="${current%%.*}"
minor="$(echo "$current" | cut -d. -f2)"
if (( major < 22 )) || (( major == 22 && minor < 13 )); then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
node --version

step "Service user and folders"
id rapthooker &>/dev/null || useradd --system --home-dir /var/lib/rapthooker --shell /usr/sbin/nologin rapthooker
usermod -aG bluetooth rapthooker
install -d -o rapthooker -g rapthooker -m 750 /var/lib/rapthooker
install -d -o root -g rapthooker -m 750 /etc/rapthooker
NEW_CONFIG=0
if [[ ! -f /etc/rapthooker/rapthooker.config.json ]]; then
  install -o root -g rapthooker -m 640 "$HERE/rapthooker.config.example.json" /etc/rapthooker/rapthooker.config.json
  echo "Created /etc/rapthooker/rapthooker.config.json"
  NEW_CONFIG=1
fi

# A new hub in a container (an LXC on Proxmox, say), where Bluetooth usually can't be used, starts with it off as if
# installed with --no-bluetooth. Only where systemd is running: not while building the Pi image (a chroot, maybe in
# Docker). Existing hubs keep what their config says.
if [[ -z "$BLUETOOTH_ARG" && $NEW_CONFIG -eq 1 && -d /run/systemd/system ]] &&
  container="$(systemd-detect-virt --container 2>/dev/null)"; then
  echo "This is a container (${container}), where Bluetooth usually can't be used: switching it off. The installer's --bluetooth switches it on."
  BLUETOOTH_ARG=off
fi

# --bluetooth / --no-bluetooth go in the config, which the app reads and later runs (updates don't pass them) follow.
if [[ -n "$BLUETOOTH_ARG" ]]; then
  rm -f "$CONFIG.rapthooker-new"
  node -e '
    const fs = require("fs");
    const [path, want] = [process.argv[1], process.argv[2] === "on"];
    const config = JSON.parse(fs.readFileSync(path, "utf8"));
    if ((config.bluetooth?.enabled !== false) === want) process.exit(0);
    config.bluetooth = { ...config.bluetooth, enabled: want };
    fs.writeFileSync(path + ".rapthooker-new", JSON.stringify(config, null, 2) + "\n");
  ' "$CONFIG" "$BLUETOOTH_ARG"
  if [[ -f "$CONFIG.rapthooker-new" ]]; then
    chown --reference="$CONFIG" "$CONFIG.rapthooker-new"
    chmod --reference="$CONFIG" "$CONFIG.rapthooker-new"
    mv "$CONFIG.rapthooker-new" "$CONFIG"
    echo "Bluetooth switched $BLUETOOTH_ARG (bluetooth.enabled in $CONFIG)"
  fi
fi
BLUETOOTH_ON="$(node -e 'try{const c=require(process.argv[1]);process.stdout.write(c.bluetooth?.enabled===false?"0":"1")}catch{process.stdout.write("1")}' "$CONFIG")"

step "Bluetooth"
if [[ $BLUETOOTH_ON -eq 1 ]]; then
  install -m 644 "$HERE/rapthooker-dbus.conf" /etc/dbus-1/system.d/rapthooker.conf
  systemctl reload dbus || true
  rfkill unblock bluetooth || true
  # Bluetooth not starting mustn't stop setting up (or an update, which would then go back to the version before): the
  # hub still hears relays and Wi-Fi devices, and says Bluetooth isn't working.
  if ! systemctl enable --now bluetooth; then
    echo "Warning: Bluetooth didn't start (see: journalctl -u bluetooth -n 20). Carrying on: relays and Wi-Fi devices still work." >&2
    echo "On a machine without Bluetooth (a container, say), switch it off: sudo bash /opt/rapthooker/deploy/install.sh --no-bluetooth" >&2
  fi
else
  echo "Off (bluetooth.enabled is false in $CONFIG): not setting it up. The installer's --bluetooth switches it back on."
fi

step "Network time (the Pi has no clock battery)"
systemctl enable --now systemd-timesyncd || true

step "Keeping logs in RAM to spare the SD card"
install -d /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/rapthooker.conf <<'EOF'
[Journal]
Storage=volatile
RuntimeMaxUse=50M
EOF
systemctl restart systemd-journald

step "Turning off Wi-Fi power saving (it shares a radio with Bluetooth)"
if [[ -d /etc/NetworkManager/conf.d ]]; then
  printf '[connection]\nwifi.powersave = 2\n' > /etc/NetworkManager/conf.d/rapthooker-wifi-powersave.conf
  systemctl reload NetworkManager || true
fi

step "Service"
install -m 644 "$HERE/rapthooker.service" /etc/systemd/system/rapthooker.service
backup_dir="$(node -e 'try{const c=require("/etc/rapthooker/rapthooker.config.json");process.stdout.write((c.backup&&c.backup.dir)||"")}catch{}')"
rm -f /etc/systemd/system/rapthooker.service.d/backup.conf
if [[ -n "$backup_dir" && -L "$backup_dir" ]]; then
  echo "The backup folder $backup_dir is a symlink: not touching it (use the real path in the config)" >&2
elif [[ -n "$backup_dir" ]]; then
  install -d -o rapthooker -g rapthooker -m 750 "$backup_dir"
  mkdir -p /etc/systemd/system/rapthooker.service.d
  printf '[Service]\nReadWritePaths=%s\n' "$backup_dir" > /etc/systemd/system/rapthooker.service.d/backup.conf
  echo "Backups go to $backup_dir"
fi

# Optional parts (Bluetooth extras, USB backups, self-updates...), run in name order. They can use step and $HERE.
for part in "$HERE"/setup.d/*.sh; do
  [[ -e "$part" ]] || continue
  # Bluetooth's own parts (setup.d/*-bluetooth-*.sh) are left out while it's off.
  if [[ $BLUETOOTH_ON -eq 0 && "$(basename "$part")" == *-bluetooth-* ]]; then continue; fi
  # shellcheck source=/dev/null
  source "$part"
done

systemctl daemon-reload
systemctl enable rapthooker

if [[ $WITH_TAILSCALE -eq 1 ]]; then
  step "Tailscale"
  command -v tailscale &>/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
fi

cat <<EOF

Setup complete. Open http://$(hostname).local:8080 and create your owner PIN.

For HTTPS (needed for notifications and installing the app) and access away from home, use Tailscale:
  sudo tailscale up
  sudo tailscale serve --bg http://127.0.0.1:8080

EOF
