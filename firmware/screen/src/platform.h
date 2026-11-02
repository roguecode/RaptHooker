#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>

#if defined(ESP8266)
#include <ESP8266WiFi.h>
#elif defined(ESP32)
#include <WiFi.h>
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

}  // namespace plat
