#pragma once
#include <Arduino.h>

// State shared between the parts of the firmware.
namespace app {
extern bool safeMode;
extern String id;   // MAC address, lower-case hex without colons
extern String mac;  // MAC address as AA:BB:CC:DD:EE:FF
void rebootIn(uint32_t ms);
void clearCrashes();  // the next start is a normal one, not safe mode
void identify();
void showPairing(const String& code, uint32_t ms);
void endPairing();
bool screenBusy();
// network: the Wi-Fi details changed (it restarts). picture: what was on the screen is gone or out of date (a new
// picture address, or something covered it), so it shows its details until a new picture is drawn.
void settingsChanged(bool network, bool picture = false);
bool buttonDown();
const char* resetReason();
}  // namespace app

namespace web {
void begin();
void loop();
bool updating();
}  // namespace web
