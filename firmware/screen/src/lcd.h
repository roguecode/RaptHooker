#pragma once
#include <Arduino.h>

#if defined(RH_BOARD_SDC2)

// TFT_eSPI's names for what the drawing code shared with the other boards (display.cpp) uses.
static const uint16_t TFT_BLACK = 0x0000;
static const uint8_t TL_DATUM = 0, MC_DATUM = 4;

// An ST7789 on ESP-IDF's esp_lcd SPI transport, for boards TFT_eSPI doesn't support (the ESP32-C2). It has the part of
// TFT_eSPI's interface display.cpp uses, and draws TFT_eSPI's fonts 2 and 4 the same way, so every board's screens
// look alike. Colours are RGB565; pushImage takes pixels with their bytes swapped, as tjpgd gives them.
class Lcd {
 public:
  bool begin(int8_t sclk, int8_t mosi, int8_t dc, int8_t rst, uint8_t spiMode, uint32_t hz);
  void command(uint8_t cmd, const uint8_t* args = nullptr, size_t n = 0);
  // MADCTL, and whether rows are reversed (MY): then the picture sits 80 rows into the controller's 320.
  void setMadctl(uint8_t madctl, uint8_t rowOffset);
  void invertDisplay(bool on);

  void fillScreen(uint16_t color);
  void fillRect(int32_t x, int32_t y, int32_t w, int32_t h, uint16_t color);
  void drawRect(int32_t x, int32_t y, int32_t w, int32_t h, uint16_t color);
  void drawFastHLine(int32_t x, int32_t y, int32_t w, uint16_t color);
  void fillTriangle(int32_t x0, int32_t y0, int32_t x1, int32_t y1, int32_t x2, int32_t y2, uint16_t color);
  void pushImage(int32_t x, int32_t y, int32_t w, int32_t h, const uint16_t* data);

  void setTextFont(uint8_t font) { textFont = font == 4 ? 4 : 2; }
  void setTextSize(uint8_t size) { textSize = size ? size : 1; }
  void setTextDatum(uint8_t datum) { textDatum = datum; }
  void setTextColor(uint16_t fg, uint16_t bg) {
    textFg = fg;
    textBg = bg;
  }
  int16_t textWidth(const String& s);
  void drawString(const String& s, int32_t x, int32_t y);

 private:
  void window(int32_t x0, int32_t y0, int32_t x1, int32_t y1);
  void send(const void* data, size_t bytes);
  void* io = nullptr;
  uint16_t* buf = nullptr;  // a band of pixels, for fills and text
  uint8_t rowOffset = 0;
  uint8_t textFont = 2, textSize = 1, textDatum = TL_DATUM;
  uint16_t textFg = 0xFFFF, textBg = 0;
};

#endif
