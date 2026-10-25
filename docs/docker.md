# Docker

> Docker support hasn't been tested on real hardware yet. The Raspberry Pi install ([pi-setup.md](pi-setup.md)) is
> the tested way to run RaptHooker.

RaptHooker can run in a container on a Linux machine with Bluetooth (x86-64 or 64-bit ARM). The container doesn't
touch the Bluetooth hardware itself: it talks to the **host's BlueZ** over the host's system D-Bus socket, which is
mounted into the container.

## Host

The host needs BlueZ running (`systemctl status bluetooth`) with the adapter switched on (`bluetoothctl show`).

## Run

```bash
docker compose up -d --build
```

with [docker-compose.yml](../docker-compose.yml):

- the app on port `8080`
- data (database, keys, nightly backups) in `./docker-data`
- `/run/dbus/system_bus_socket` from the host, for Bluetooth

The container runs as root so the host's D-Bus policy lets it talk to BlueZ. If you run it as another user, give that
user access to `org.bluez` on the host (see [rapthooker-dbus.conf](../deploy/pi/rapthooker-dbus.conf)).

The config is [deploy/docker/rapthooker.config.json](../deploy/docker/rapthooker.config.json); mount your own over
`/app/rapthooker.config.json` to change it, or set `RAPTHOOKER_PORT`.

## Notes

- RaptHooker shares BlueZ happily with other programs (e.g. Home Assistant): each D-Bus client gets its own discovery
  session.
- In a container the host's clock is trusted as it is, so make sure the host keeps network time.
