# shellcheck shell=bash
# Resetting a stuck Bluetooth adapter (sourced by setup.sh, which provides `step` and $HERE). Safe to re-run.
#
# Bluetooth can get stuck below BlueZ, so that nothing is heard until the radio is switched off and on (rfkill), which
# needs root. The app can't write outside /var/lib/rapthooker, so when the pills it records go unheard for a long while
# it creates /var/lib/rapthooker/bt-reset-request. rapthooker-bt-reset.path notices the file and starts
# rapthooker-bt-reset.service, which runs bt-reset.sh as root. Without these units the app only logs how to do it by hand.

step "Bluetooth: resetting the adapter if it gets stuck"
install -m 644 "$HERE/rapthooker-bt-reset.service" /etc/systemd/system/rapthooker-bt-reset.service
install -m 644 "$HERE/rapthooker-bt-reset.path" /etc/systemd/system/rapthooker-bt-reset.path
systemctl daemon-reload
systemctl enable rapthooker-bt-reset.path
# Restarting picks up a changed unit. Building an image (no systemd running) it can't start; it will at boot.
if systemctl restart rapthooker-bt-reset.path 2>/dev/null; then
  echo "Watching for Bluetooth reset requests (rapthooker-bt-reset.path)"
else
  echo "rapthooker-bt-reset.path starts at the next boot"
fi
