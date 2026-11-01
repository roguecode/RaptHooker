#pragma once
#include <Arduino.h>

namespace display {

static const uint16_t WHITE = 0xFFFF;
static const uint16_t GREY = 0x9CF3;
static const uint16_t DIM = 0x4208;
static const uint16_t AMBER = 0xFD20;
static const uint16_t RED = 0xF9A6;
static const uint16_t GREEN = 0x5EAB;
static const uint16_t VIOLET = 0x8B3E;

struct Line {
  const char* label;
  String value;
};

void begin(uint8_t brightness);
bool ready();
void setBrightness(uint8_t percent);

// The screen's own details: the logo, a title, a few label and value lines and a status line.
void showInfo(const String& title, const Line* lines, size_t count, const String& status, uint16_t statusColor);
// Draws a JPEG over the whole screen. Checks it first, so a bad picture leaves the last one up.
bool drawJpeg(const uint8_t* data, size_t len, String& error);
// A small line over the bottom of the picture, for when something's wrong.
void showBanner(const String& text, uint16_t color);
void showProgress(const String& title, const String& detail, int percent);
void showIdentify(const String& name);
void showPairing(const String& code);

}  // namespace display
