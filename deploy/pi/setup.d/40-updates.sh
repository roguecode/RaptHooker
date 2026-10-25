# shellcheck shell=bash
# Updates from the app (sourced by setup.sh, which provides `step` and $HERE). Safe to re-run.
#
# The app can't write outside /var/lib/rapthooker, so it asks for an update by creating
# /var/lib/rapthooker/update-request. rapthooker-update.path notices the file and starts rapthooker-update.service,
# which runs update.sh as root. The app only offers updates on hubs set up with install.sh (/opt/rapthooker/.installer);
# on a development build (/opt/rapthooker/.dev-build, from deploy.ps1/deploy.sh) it only offers a switch to the latest
# release.

step "Updates from the app"
install -m 644 "$HERE/rapthooker-update.service" /etc/systemd/system/rapthooker-update.service
install -m 644 "$HERE/rapthooker-update.path" /etc/systemd/system/rapthooker-update.path
systemctl daemon-reload
systemctl enable rapthooker-update.path
# Restarting picks up a changed unit. Building an image (no systemd running) it can't start; it will at boot.
if systemctl restart rapthooker-update.path 2>/dev/null; then
  echo "Watching for update requests (rapthooker-update.path)"
else
  echo "rapthooker-update.path starts at the next boot"
fi
