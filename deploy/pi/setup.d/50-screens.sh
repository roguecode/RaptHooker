# shellcheck shell=bash
# Screens (sourced by setup.sh, which provides `step` and $HERE). Safe to re-run.
#
# To set up a screen, the app joins the screen's own Wi-Fi hotspot for about a minute, then goes back to the hub's
# network. It asks NetworkManager over D-Bus, so the rapthooker user needs polkit's leave for just these actions:
# changing networks, scanning, and adding the temporary (in-memory) connection for the hotspot. Reading the hub's
# saved Wi-Fi password, to give it to the screen, comes under settings.modify.system too.

step "Screens (Wi-Fi set-up)"
if ! command -v nmcli &>/dev/null && [[ ! -d /etc/NetworkManager ]]; then
  echo "NetworkManager isn't used here: screens can still be set up from a browser"
elif [[ -d /etc/polkit-1/rules.d ]]; then
  cat > /etc/polkit-1/rules.d/50-rapthooker-screens.rules <<'EOF'
// RaptHooker sets up screens by joining their Wi-Fi hotspot for a minute (deploy/pi/setup.d/50-screens.sh).
polkit.addRule(function (action, subject) {
  if (subject.user != "rapthooker") return polkit.Result.NOT_HANDLED;
  if (action.id == "org.freedesktop.NetworkManager.network-control" ||
      action.id == "org.freedesktop.NetworkManager.wifi.scan" ||
      action.id == "org.freedesktop.NetworkManager.settings.modify.system") {
    return polkit.Result.YES;
  }
  return polkit.Result.NOT_HANDLED;
});
EOF
  echo "The app may switch Wi-Fi networks to set screens up (polkit rule)"
elif [[ -d /etc/polkit-1/localauthority ]]; then
  install -d /etc/polkit-1/localauthority/50-local.d
  cat > /etc/polkit-1/localauthority/50-local.d/50-rapthooker-screens.pkla <<'EOF'
[RaptHooker screens]
Identity=unix-user:rapthooker
Action=org.freedesktop.NetworkManager.network-control;org.freedesktop.NetworkManager.wifi.scan;org.freedesktop.NetworkManager.settings.modify.system
ResultAny=yes
ResultInactive=yes
ResultActive=yes
EOF
  echo "The app may switch Wi-Fi networks to set screens up (polkit local authority)"
else
  echo "No polkit found: screens can still be set up from a browser"
fi
