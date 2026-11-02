#pragma once
#include <Arduino.h>
#include <IPAddress.h>

namespace net {

enum class State : uint8_t { Setup, Connecting, Online, Offline };
// A Wi-Fi network being tried while the set-up hotspot stays up, so RaptHooker hears how it went.
enum class Trial : uint8_t { Idle, Testing, Connected, Failed };

void begin();
void loop();

State state();
const char* stateName();
bool online();
String apName();      // the set-up hotspot's name, RaptHooker-Screen-XXXXXX
bool apActive();
String hostname();
String reason();      // why the last connection attempt failed, if it did
uint32_t downFor();   // ms since the screen lost (or started looking for) its network; 0 when online

void startTrial(const String& ssid, const String& pass, int channel);
Trial trial();
const char* trialName();
String trialError();
IPAddress trialIp();
const char* phyName();  // the station's 802.11 mode, "g" or "n"

}  // namespace net
