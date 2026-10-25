#!/usr/bin/env bash
# Builds RaptHooker and installs it on a Raspberry Pi over SSH (macOS/Linux; Windows users: deploy.ps1).
#   ./deploy/deploy.sh raspberrypi.local --setup      first time (also runs setup.sh, renaming the Pi to rapthooker)
#   ./deploy/deploy.sh                                updates (to rapthooker.local)
# Options: --user NAME (default pi), --setup, --setup-args "--keep-hostname", --skip-build
set -euo pipefail

PI_HOST="rapthooker.local"
PI_USER="pi"
SETUP=0
SETUP_ARGS=""
BUILD=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) PI_USER="$2"; shift 2 ;;
    --setup) SETUP=1; shift ;;
    --setup-args) SETUP_ARGS="$2"; shift 2 ;;
    --skip-build) BUILD=0; shift ;;
    -*) echo "Unknown option $1" >&2; exit 1 ;;
    *) PI_HOST="$1"; shift ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if [[ $BUILD -eq 1 ]]; then npm run build; fi

STAGE="$ROOT/release/rapthooker"
rm -rf "$STAGE"
mkdir -p "$STAGE/server" "$STAGE/web" "$STAGE/deploy"
cp src/server/dist/*.cjs "$STAGE/server/"
cp -R src/web/dist "$STAGE/web/dist"
cp -R deploy/pi "$STAGE/deploy/pi"
# The app's "Switch to release" runs this (through update.sh), as on a hub set up with the installer.
cp deploy/install.sh "$STAGE/deploy/install.sh"
tar -czf "$ROOT/release/rapthooker.tgz" -C "$STAGE" .

TARGET="$PI_USER@$PI_HOST"
echo "Copying to $TARGET..."
scp "$ROOT/release/rapthooker.tgz" "$TARGET:/tmp/rapthooker.tgz"

# Runs on the Pi, so its $d is expanded there. A development build isn't a release: the installer's marker goes and
# .dev-build goes in, so the app says it's a development build and doesn't offer updates (only a switch back to the
# latest release, if you ask for it).
# shellcheck disable=SC2016
REMOTE='set -e; sudo mkdir -p /opt/rapthooker; sudo rm -rf /opt/rapthooker.new; sudo mkdir /opt/rapthooker.new;
sudo tar -xzf /tmp/rapthooker.tgz -C /opt/rapthooker.new --no-same-owner --no-same-permissions; rm /tmp/rapthooker.tgz;
sudo chown -R root:root /opt/rapthooker.new; sudo chmod -R u=rwX,go=rX /opt/rapthooker.new;
for d in server web deploy; do sudo rm -rf /opt/rapthooker/$d.old; if [ -e /opt/rapthooker/$d ]; then sudo mv /opt/rapthooker/$d /opt/rapthooker/$d.old; fi; sudo mv /opt/rapthooker.new/$d /opt/rapthooker/$d; done;
sudo rm -rf /opt/rapthooker.new /opt/rapthooker/server.old /opt/rapthooker/web.old /opt/rapthooker/deploy.old;
sudo rm -f /opt/rapthooker/.installer /opt/rapthooker/VERSION;
echo deployed from source by deploy.sh, not a release | sudo tee /opt/rapthooker/.dev-build >/dev/null;'
if [[ $SETUP -eq 1 ]]; then REMOTE+=" sudo bash /opt/rapthooker/deploy/pi/setup.sh $SETUP_ARGS;"; fi
REMOTE+=' if [ -f /etc/systemd/system/rapthooker.service ]; then sudo systemctl restart rapthooker; sleep 4; systemctl --no-pager --lines=12 status rapthooker; else echo "Run with --setup first"; fi'
ssh -t "$TARGET" "$REMOTE"
