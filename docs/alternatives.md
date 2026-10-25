# Alternatives and related projects

While we have no idea why someone would want to avoid being locked into the Kegland subscriptions after purchasing full-priced hardware, below is an incomplete list of related open-source projects.

## Projects

- **[Home Assistant `rapt_ble`](https://www.home-assistant.io/integrations/rapt_ble)**
  ([source](https://github.com/home-assistant/core/tree/dev/homeassistant/components/rapt_ble), Apache-2.0). Bluetooth.
  Built into Home Assistant: pills are discovered automatically and appear as gravity, temperature and battery sensors.
  Uses [rapt-ble](#bluetooth-decoders-and-libraries).
- **[BrewSignal](https://github.com/machug/brewsignal)** (MIT according to its README, no licence file). Bluetooth. Web
  dashboard for fermentation hydrometers on a Raspberry Pi. Supports Tilt, iSpindel and GravityMon, and its scanner also
  decodes RAPT Pills.
- **[Brewblox RAPT Pill service](https://gitlab.com/core_dumped/brewblox-raptpill)** (GitLab, GPL-3.0). Bluetooth. A
  fork of the Brewblox Tilt service that also tracks RAPT Pills, for people already running
  [Brewblox](https://brewblox.com).
- **[BrewPiLess](https://github.com/vitotai/BrewPiLess)** (no licence). Bluetooth. ESP8266/ESP32 fermentation temperature
  controller firmware ("BrewPi without the Pi"). On an ESP32 it can read a RAPT Pill
  ([docs](http://www.vito.tw/BrewPiLess/D1.RaptPillHydrometerSupport.html)).
  [BrewPiLessGx](https://github.com/vitotai/BrewPiLessGx) is the touchscreen version.
- **[Chamber Controller](https://github.com/mp-se/chamber-controller)** (GPL-3.0). Bluetooth. ESP32 fermentation chamber
  controller that can use a RAPT Pill, Tilt or GravityMon as the beer temperature sensor.
- **[FermentDial](https://github.com/lichuu/fermentdial)** (MIT). Bluetooth. Fermentation temperature controller firmware
  for the M5Stack Dial (ESP32-S3). It reads Tilt and RAPT Pill hydrometers and has a web dashboard. Its README says the
  first physical build is still in progress.
- **[SPINDELMATE](https://github.com/kbaggen/SPINDELMATE)** (no licence). Bluetooth. ESP32 hub that collects Tilt and RAPT
  Pill readings over Bluetooth and iSpindel readings over Wi-Fi, then uploads them to the SPINDELMATE cloud service.
- **[PillRepeater](https://github.com/diyhomebrewers/PillRepeater)** (no licence, README in Spanish). Bluetooth. ESP32
  receiver with a display and web page. It forwards readings to MQTT (Home Assistant, CraftBeerPi, Brewblox), BrewSpy and
  Brewfather.
- **[RAPT-Mate](https://github.com/kasperg3/RaptMate)** (no licence). Bluetooth. An ESP32 that scans for a pill and serves
  a React dashboard.
- **[kogerr/brewery](https://github.com/kogerr/brewery)** (no licence). Bluetooth. Homebrew toolkit that includes a
  Raspberry Pi relay for several pills, with a Brewfather custom stream and a web dashboard with gravity graphs.
- **[Pill Monitor](https://github.com/matt1719/RaptPillBluetoothTelemetry)** (no licence). Bluetooth. Android app that
  listens to a pill from your phone, logs the readings and charts them.
- **[goddardduncan/rapt](https://github.com/goddardduncan/rapt)** (no licence). Bluetooth. A Web Bluetooth page that reads
  a pill straight from the browser, plus ESP32 sketches that forward readings to Sinric Pro (Google Home).
- **[ArduinoRaptPillBLE](https://github.com/keit/ArduinoRaptPillBLE)** (no licence). Bluetooth. Arduino project that uses
  a pill's temperature to control a heater pad.

## Bluetooth decoders and libraries

For building your own. KegLand documents the format on its
[public GitLab wiki](https://gitlab.com/rapt.io/public/-/wikis/Pill-Hydrometer-Bluetooth-Transmissions).

- **[rapt-ble](https://github.com/sairon/rapt-ble)** (MIT, [PyPI](https://pypi.org/project/rapt-ble/)). Python parser for
  the Pill's Bluetooth adverts, used by Home Assistant.
- **[RAPT-Pill-Bluetooth-Decoder](https://github.com/TravisEvashkevich/RAPT-Pill-Bluetooth-Decoder)** (MIT). Python
  decoder for the adverts.
- **[PILL_Capture](https://github.com/TravisEvashkevich/PILL_Capture)** (no licence). C++ for the ESP32 that captures the
  adverts.

## Bluetooth to MQTT bridges

- **[ferm2mqtt](https://github.com/sgoadhouse/ferm2mqtt)** (Apache-2.0). Python script that scans for RAPT Pill and Tilt
  broadcasts and publishes them to MQTT. The same author's older
  [raptpill2mqtt](https://github.com/sgoadhouse/raptpill2mqtt) handles RAPT Pills only.
- **[Rapt-Pill-BLE2MQTT](https://github.com/jcres104/Rapt-Pill-BLE2MQTT)** (MIT). ESP32 firmware that decodes pills and
  publishes them to MQTT.
- [PillRepeater](https://github.com/diyhomebrewers/PillRepeater), listed above, also publishes to MQTT.

## Home Assistant

These add to or replace the built-in `rapt_ble` integration.

- **[RAPT Brewing](https://github.com/sbaird123/rapt-brewing-hacs)** (MIT, HACS). Bluetooth or RAPT cloud. Adds brewing
  sessions on top of a pill: original gravity detection, session history, and alerts for stuck fermentation,
  temperature and low battery. Gets its data directly over Bluetooth, from existing Home Assistant entities or from the
  RAPT cloud API.
- **[RAPT Cloud](https://github.com/berra200/home-assistant-rapt-cloud-link)** (MIT, HACS). RAPT cloud. Pills, BrewZillas
  and other RAPT devices.
- **[ha-rapt-brewing](https://github.com/tobiasvilen/ha-rapt-brewing)** (MIT). RAPT cloud. Polls the RAPT API for pill
  telemetry.
- **[ha-rapt-package](https://github.com/thewolf-oz/ha-rapt-package)** (no licence). RAPT cloud. YAML package for a Pill,
  BrewZilla and temperature controller. Last updated in 2022.
- **[raptio](https://github.com/duarte-hub/raptio)** (MIT). RAPT cloud. Polls the RAPT API and publishes each device to
  MQTT for Home Assistant.
- **[rapt-pill-HA](https://github.com/scottpancakes/rapt-pill-HA)** (no licence). RAPT cloud. A guide to getting RAPT
  webhooks into Home Assistant.
- **[Brewfather for Home Assistant](https://github.com/MvdDonk/brewfather)** (MIT). Brewfather integration that can push
  a Home Assistant gravity sensor, such as a RAPT Pill, to Brewfather.
- **[Fermentation tracker card](https://github.com/agentgonzo/homeassistant-fermentation-tracker)** (MIT). Dashboard card
  for following a fermentation from any gravity sensor. Designed with the RAPT Pill, Tilt and iSpindel in mind.
- **[brauhelfer-ha](https://github.com/Matti198/brauhelfer-ha)** (GPL-3.0, README in German). Brings Kleiner Brauhelfer 2
  brews into Home Assistant and charts fermentation from the `rapt_ble` integration.
- **[BrewAssistant](https://github.com/Jocke1970/brewassistant-beta)** (MIT, README in Swedish, beta). Brew-day assistant
  covering BrewZilla/RAPT, Brewfather and fermentation.
- **[RAPT Keg Laser](https://github.com/splitice/homeassistant-rapt-keglaser)** (MIT). Not for the Pill: a local
  Bluetooth integration for KegLand's RAPT Laser Level Sensor keg lid.
  [rapt-laser-level-display](https://github.com/YDraig/rapt-laser-level-display) (no licence) is a standalone display for
  the same sensor.

## RAPT cloud API clients and tools

These all need a RAPT account and an API secret.

- **[rapt-mqtt-bridge](https://github.com/sgoadhouse/rapt-mqtt-bridge)** (MIT). Python script that reads pills from the
  RAPT API and publishes new readings to MQTT. Last updated in 2022.
- **[kegland_rapt_api_client](https://github.com/fkolacek/kegland_rapt_api_client)** (MIT). Python client library for the
  RAPT API. Last updated in 2023.
- **[Power.RAPT](https://github.com/themuzzvolta/power.rapt)** (MIT). PowerShell module for the RAPT API: hydrometers,
  BrewZillas and temperature controllers.
- **[node-red-rapt-pull](https://github.com/tonymacdonald2008/node-red-rapt-pull)** (MIT,
  [npm](https://www.npmjs.com/package/@tonymacdonald/node-red-rapt-pull)). Node-RED node that pulls data from the RAPT
  cloud.
- **[raptio-mcp](https://github.com/emsnicket/raptio-mcp)** (no licence). MCP server that lets AI assistants read RAPT
  pills and fermentation chambers. It is read-only unless you allow control.
- **[rapt_exporter](https://github.com/ebirn/rapt_exporter)** (no licence). Pushes pill readings to a Prometheus
  Pushgateway.
- **[rapt-predict](https://github.com/billw2012/rapt-predict)** (no licence). Predicts final gravity from a pill's recent
  history and plots it.
- **[rapt-brewfather](https://github.com/jacobludriks/rapt-brewfather)** (no licence, C#). Azure template that sends a
  pill's readings to a Brewfather custom stream.
  [brewfather-rapt-pill](https://github.com/JoelBrenstrum/brewfather-rapt-pill) (no licence, TypeScript) does the same
  and is based on it. Both were last updated in 2022.

## Dashboards and apps that accept RAPT data

- **[RaptDash](https://github.com/javinator/rapt-dash)** (no licence). Angular dashboard for fermentation sessions, fed by
  RAPT cloud webhooks or Home Assistant.
- **[RAPT Pill Diacetyl Rest Monitor](https://github.com/geovanefc-jpg/rapt-monitor)** (no licence, README in
  Portuguese). Watches fermentation, sends Telegram alerts when it's time for a diacetyl rest, and predicts final
  gravity.
- **[MeadTools](https://github.com/ljreaux/MeadTools)** (MIT, [meadtools.com](https://meadtools.com)). Mead-making
  calculators and logging, with an endpoint RAPT Pills can post readings to.
  [RaptPill-To-MeadTools](https://github.com/TravisEvashkevich/RaptPill-To-MeadTools) (MIT) sends a pill's Bluetooth
  readings to it.
- **[Wine Cellar](https://github.com/rdrake/wine-cellar)** (ISC). Winemaking batch tracker (a web app for phones) that
  takes RAPT Pill readings by webhook and alerts on stalls and temperature excursions.
- **[FermentOS](https://github.com/highaltidude/FermentOS)** (MIT). Self-hosted homebrewing platform for recipes, brew
  sessions and fermentation monitoring. Its sensor registry is built for iSpindel, Tilt and RAPT Pill.

## Firmware and hardware

- **[OpenPill](https://github.com/keredson/openpill)** (GPL-3.0). Open-source replacement firmware and app for the
  original ESP32-based RAPT Pill. It reports gravity, temperature and battery over Bluetooth, or posts JSON over Wi-Fi to
  a URL you choose, without a cloud account. It replaces KegLand's firmware, so read its README first.
- **[BestEnemies/pill](https://github.com/BestEnemies/pill)** (no licence). Teardown notes and the Pill's local web
  endpoints, collected as groundwork for firmware that doesn't depend on the cloud.
- **[GravityMon](https://github.com/mp-se/gravitymon)** (custom licence). Not for the Pill: firmware for a DIY
  iSpindel-style hydrometer that can broadcast in the RAPT Pill v1/v2 Bluetooth format.
  [GravityMon Gateway](https://github.com/mp-se/gravitymon-gateway) (MIT) receives and displays RAPT Pill data but doesn't
  forward it.
- **[KegLand's public GitLab](https://gitlab.com/rapt.io/public)**. Not a project, but its wiki documents the Pill's
  Bluetooth format, the RAPT API and device error codes.
