#!/usr/bin/env bash
# One-time (and safe to re-run) Raspberry Pi setup for RaptHooker. Run on the Pi after the files are in place:
#   sudo bash /opt/rapthooker/deploy/pi/setup.sh [--hostname NAME | --keep-hostname] [--tailscale]
#
# Supported: Raspberry Pi 3/4/5 and Zero 2 W running Raspberry Pi OS (64-bit recommended). The original Pi Zero W
# (ARMv6) isn't supported: current Node.js releases aren't built for it.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "Run with sudo" >&2; exit 1; fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_MAJOR=24
PI_HOSTNAME="rapthooker"
SET_HOSTNAME=1
WITH_TAILSCALE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hostname) PI_HOSTNAME="$2"; shift 2 ;;
    --keep-hostname) SET_HOSTNAME=0; shift ;;
    --tailscale) WITH_TAILSCALE=1; shift ;;
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
if [[ ! -f /etc/rapthooker/rapthooker.config.json ]]; then
  install -o root -g rapthooker -m 640 "$HERE/rapthooker.config.example.json" /etc/rapthooker/rapthooker.config.json
  echo "Created /etc/rapthooker/rapthooker.config.json"
fi

step "Bluetooth"
install -m 644 "$HERE/rapthooker-dbus.conf" /etc/dbus-1/system.d/rapthooker.conf
systemctl reload dbus || true
rfkill unblock bluetooth || true
systemctl enable --now bluetooth

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
