#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>

#if defined(ESP8266)
#include <ESP8266WiFi.h>
#elif defined(ESP32)
#include <WiFi.h>
#if defined(RH_BOARD_SDC2)
#include <esp_mac.h>
#endif
#else
#error "ESP8266 or ESP32 only"
#endif

// What differs between the chips, apart from the Wi-Fi, web and update code (net.cpp, web.cpp), which keeps its
// differences in place.
namespace plat {

// Counts crashes in a row across restarts (three start in safe mode). On the ESP32, new firmware from an update starts
// "on trial": unless it works (markGood) within 10 minutes, or if it crashes first, the boot loader goes back to the
// firmware it replaced.
void begin();
bool safeMode();
void clearCrashes();  // the next start is a normal one, not safe mode
void markGood();      // this firmware works: crashes cleared, and on the ESP32 it stays installed
bool onTrial();
const char* resetReason();

const char* chip();       // "esp8266", "esp32"
uint32_t maxBlock();      // the biggest block that can be allocated
uint32_t random32();
String hmacSha256(const String& key, const String& message);  // hex
void systemInfo(JsonObject s);

// The station's MAC address, which names the screen: its id, hotspot and host name. Arduino 3 (the SDC2's) leaves the
// buffer as it was until Wi-Fi has started, so there it's read from the chip.
#if defined(RH_BOARD_SDC2)
inline void stationMac(uint8_t* mac) { esp_read_mac(mac, ESP_MAC_WIFI_STA); }
#else
inline void stationMac(uint8_t* mac) { WiFi.macAddress(mac); }
#endif

#if defined(RH_BOARD_SDC2)
// The crash this start followed, short enough for the set-up screen (empty if it didn't follow one). The whole of it
// is in the log, and in /api/info's system.crash until the next.
struct Crash {
  String what, task, at, stack;
};
const Crash& crash();
#endif

}  // namespace plat
