#pragma once
#include <Arduino.h>

namespace fetch {

void begin(const String& id);
void loop();
void soon();               // fetch as soon as it can, unless one was fetched moments ago (a request from the hub)
void now();                // fetch now: the picture isn't on the screen (unless the last try failed: then it backs off)
void pause(bool paused);   // while the firmware updates
bool shown();              // a picture is on the screen
uint32_t sinceGood();      // ms since the last picture was drawn (or since boot)
uint32_t failures();       // fetches that failed in a row
String error();            // why the last one failed
String brief();            // the same, short enough for the screen
uint32_t bytes();          // size of the last picture
uint32_t interval();       // seconds between pictures, from the hub's X-Refresh if it sent one
uint32_t draws();          // pictures drawn since boot
void forget();             // the picture address changed

}  // namespace fetch
