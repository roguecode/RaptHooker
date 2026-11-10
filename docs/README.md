# Documentation

The [README](../README.md) says what RaptHooker is and has the short version of the install. Everything else is here.

## Setting up and running it

- [Raspberry Pi setup](pi-setup.md): the install step by step, HTTPS and access away from home, Bluetooth range, and
  what to do when something doesn't work
- [Updating](updating.md): from the app or by hand, and going back to the version before
- [Backups](backups.md): the nightly copies, a USB stick, S3, and restoring
- [Configuration](configuration.md): the few settings that live in a file on the Pi
- [Docker](docker.md): running it in a container (untested)

## Devices

- [Switch a RAPT Pill to Bluetooth](../README.md#switch-a-rapt-pill-to-bluetooth)
- [iSpindels](ispindel.md)
- [Tilt hydrometers](tilt.md) (experimental)
- [RAPT Laser Levels](laser-level.md) (experimental)
- [Bluetooth relays](relay.md): an ESP32 next to a fermenter the Pi can't hear

## Brewing

- [Features](features.md): everything RaptHooker does
- [Brewing](brewing.md): brews, OG, ABV, predictions, events and the batch summary
- [Calibration](calibration.md): where the numbers come from, and the calibration wizard
- [Alerts](alerts.md): what can trigger one, and getting them on your phone

## Sending your data elsewhere

- [Webhooks](webhooks.md): Brewfather, Grainfather, BrewSpy and the rest, or your own
- [Home Assistant and MQTT](home-assistant.md)
- [API](api.md): for your own scripts and dashboards

## Screens

- [Small screens](screens.md): a picture of your pills at a web address, for any screen that can load one
- [RaptHooker screens](rapthooker-screens.md) (experimental): the hub puts its own firmware on a weather clock (Smart
  weather clock or GeekMagic Ultra) or an ESP32 board and looks after it

## Working on RaptHooker

- [Development](development.md): running it on your computer, the tests, deploying your own build and releasing
- [Translations](translations.md)
- [Keeping people's data](data-compatibility.md): read this before changing how anything is stored

## Other

- [Alternatives and related projects](alternatives.md)
