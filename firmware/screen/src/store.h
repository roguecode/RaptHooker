#pragma once
#include <Arduino.h>

struct Settings {
  String ssid;
  String pass;
  String token;     // RaptHooker's key for this screen; empty until it's set up
  String hub;       // id of the RaptHooker hub that set it up
  String name;
  String imageUrl;  // empty: show the screen's details instead of a picture
  uint32_t interval = 60;   // seconds between pictures
  uint8_t brightness = 80;  // percent
  String phy = "g";         // 802.11 mode for the station, "b", "g" or "n": whichever last got an address
  uint8_t txPower = 0;      // dBm, 0 for the radio's default (20.5)

  bool configured() const { return ssid.length() > 0; }
};

// Settings live as JSON in the 4 KB flash sector between the file system and the EEPROM sector, which
// neither the stock firmware nor this one uses for anything else. So the stock file system and EEPROM are
// left exactly as they were, and putting the stock firmware back gives a working stock screen. The settings are
// wiped when other firmware goes on, so RaptHooker installed again later starts afresh, in set-up mode.
namespace store {
void begin();
Settings& settings();
bool save();   // writes settings(), keeping any keys a newer firmware wrote that this one doesn't know
void reset();  // forget everything
void wipe();   // forget everything, and write nothing more until the restart (other firmware is going on)
bool available();
}  // namespace store
