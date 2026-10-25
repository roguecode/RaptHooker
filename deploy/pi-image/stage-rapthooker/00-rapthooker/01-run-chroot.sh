#!/bin/bash -e
# Runs inside the image (a chroot, with no systemd running): installs RaptHooker much as install.sh would, except
# that services are enabled but not started. rapthooker-firstboot.service runs setup.sh once more on the first boot,
# for anything that needs a running system.
release=/opt/rapthooker.image/rapthooker.tar.gz

mkdir -p /opt/rapthooker
tar -xzf "$release" -C /opt/rapthooker --no-same-owner --no-same-permissions
chown -R root:root /opt/rapthooker
chmod -R u=rwX,go=rX /opt/rapthooker
version="$(tr -d '[:space:]' </opt/rapthooker/VERSION)"

# systemctl can enable units here but not start, stop or reload them: skip those, and drop --now.
shim=/opt/rapthooker.image/bin
mkdir -p "$shim"
cat >"$shim/systemctl" <<'EOF'
#!/bin/bash
for arg in "$@"; do
  case "$arg" in
    start | stop | restart | reload | try-restart | reload-or-restart | daemon-reload)
      echo "(building the image) skipped: systemctl $*"
      exit 0
      ;;
  esac
done
args=()
for arg in "$@"; do
  if [[ "$arg" != "--now" ]]; then args+=("$arg"); fi
done
exec /usr/bin/systemctl "${args[@]}"
EOF
chmod 755 "$shim/systemctl"

PATH="$shim:$PATH" bash /opt/rapthooker/deploy/pi/setup.sh --keep-hostname </dev/null

node --version
test -f /etc/systemd/system/rapthooker.service
systemctl enable rapthooker.service rapthooker-firstboot.service

# Installed from a release, as install.sh does it, so the app may update itself.
printf 'version=%s\ninstalled=%s\nrepo=%s\nimage=yes\n' "$version" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "roguecode/RaptHooker" \
  >/opt/rapthooker/.installer
chmod 644 /opt/rapthooker/.installer

rm -rf /opt/rapthooker.image
echo "RaptHooker ${version} is in the image"
