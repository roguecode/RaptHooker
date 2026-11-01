#include "display.h"

#include <TFT_eSPI.h>

#include "hw.h"
#include "jpeg.h"
#include "log.h"
#include "logo.h"

static TFT_eSPI tft;
static bool started = false;

static const int BANNER_H = 18;

static bool pushBlock(int16_t x, int16_t y, uint16_t w, uint16_t h, uint16_t* data) {
  if (y >= SCREEN_H || x >= SCREEN_W) return true;
  tft.pushImage(x, y, w, h, data);
  return true;
}

static void replayPanelInit() {
  const uint8_t* p = PANEL_INIT;
  uint8_t count = pgm_read_byte(p++);
  while (count--) {
    uint8_t cmd = pgm_read_byte(p++);
    uint8_t args = pgm_read_byte(p++);
    tft.writecommand(cmd);
    for (uint8_t i = 0; i < (args & 0x7F); i++) tft.writedata(pgm_read_byte(p++));
    if (args & 0x80) {
      uint8_t ms = pgm_read_byte(p++);
      delay(ms == 255 ? 500 : ms);
    }
  }
}

static String fit(const String& s, int width) {
  if (tft.textWidth(s) <= width) return s;
  String t = s;
  while (t.length() && tft.textWidth(t + "...") > width) t.remove(t.length() - 1);
  return t + "...";
}

void display::begin(uint8_t brightness) {
  pinMode(PIN_BACKLIGHT, OUTPUT);
  digitalWrite(PIN_BACKLIGHT, HIGH);  // off while the panel starts
  analogWriteRange(1023);
  analogWriteFreq(1000);
  tft.init();
  tft.writecommand(0x01);  // SWRESET, then the stock set-up from a clean slate
  delay(150);
  replayPanelInit();
  tft.setRotation(0);
  tft.fillScreen(TFT_BLACK);
  started = true;
  setBrightness(brightness);
  logf("display: ready");
}

bool display::ready() { return started; }

void display::setBrightness(uint8_t percent) {
  if (!started) return;
  percent = constrain(percent, 1, 100);
  if (percent >= 100) {
    analogWrite(PIN_BACKLIGHT, 0);
    digitalWrite(PIN_BACKLIGHT, LOW);
  } else {
    analogWrite(PIN_BACKLIGHT, 1023 - (uint32_t)percent * 1023 / 100);
  }
}

static void drawStatus(const String& text, uint16_t color) {
  tft.fillRect(0, SCREEN_H - BANNER_H, SCREEN_W, BANNER_H, 0x10A2);
  if (!text.length()) return;
  tft.setTextFont(2);
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(color, 0x10A2);
  tft.drawString(fit(text, SCREEN_W - 8), SCREEN_W / 2, SCREEN_H - BANNER_H / 2);
  tft.setTextDatum(TL_DATUM);
}

void display::showInfo(const String& title, const Line* lines, size_t count, const String& status, uint16_t statusColor) {
  if (!started) return;
  tft.fillScreen(TFT_BLACK);
  jpeg::draw(LOGO_JPG, sizeof(LOGO_JPG), 12, 10, pushBlock);
  tft.setTextDatum(TL_DATUM);
  tft.setTextFont(4);
  tft.setTextColor(WHITE, TFT_BLACK);
  tft.drawString("RaptHooker", 86, 16);
  tft.setTextFont(2);
  tft.setTextColor(GREY, TFT_BLACK);
  tft.drawString(fit(title, SCREEN_W - 90), 86, 46);
  tft.drawFastHLine(12, 82, SCREEN_W - 24, DIM);
  int y = 90;
  for (size_t i = 0; i < count && y <= SCREEN_H - BANNER_H - 18; i++, y += 20) {
    tft.setTextColor(GREY, TFT_BLACK);
    tft.drawString(lines[i].label, 12, y);
    tft.setTextColor(WHITE, TFT_BLACK);
    tft.drawString(fit(lines[i].value, SCREEN_W - 84), 76, y);
  }
  drawStatus(status, statusColor);
}

bool display::drawJpeg(const uint8_t* data, size_t len, String& error) {
  if (!started) {
    error = "display off";
    return false;
  }
  if (len < 4 || data[0] != 0xFF || data[1] != 0xD8 || data[len - 2] != 0xFF || data[len - 1] != 0xD9) {
    error = "not a complete JPEG";
    return false;
  }
  uint16_t w = 0, h = 0;
  if (jpeg::size(data, len, w, h) != 0 || !w || !h) {
    error = "can't read the JPEG";
    return false;
  }
  if (w > SCREEN_W || h > SCREEN_H) {
    error = String("picture is ") + w + "x" + h + ", want " + SCREEN_W + "x" + SCREEN_H;
    return false;
  }
  if (w < SCREEN_W || h < SCREEN_H) tft.fillScreen(TFT_BLACK);
  int r = jpeg::draw(data, len, (SCREEN_W - w) / 2, (SCREEN_H - h) / 2, pushBlock);
  if (r != 0) {
    error = String("JPEG error ") + r;
    return false;
  }
  return true;
}

void display::showBanner(const String& text, uint16_t color) {
  if (!started) return;
  drawStatus(text, color);
}

void display::showProgress(const String& title, const String& detail, int percent) {
  if (!started) return;
  static String shown;
  if (shown != title) {
    shown = title;
    tft.fillScreen(TFT_BLACK);
    jpeg::draw(LOGO_JPG, sizeof(LOGO_JPG), (SCREEN_W - LOGO_SIZE) / 2, 30, pushBlock);
    tft.setTextDatum(MC_DATUM);
    tft.setTextFont(4);
    tft.setTextColor(WHITE, TFT_BLACK);
    tft.drawString(fit(title, SCREEN_W - 16), SCREEN_W / 2, 124);
    tft.drawRect(20, 150, SCREEN_W - 40, 14, GREY);
  }
  int p = constrain(percent, 0, 100);
  tft.fillRect(22, 152, (SCREEN_W - 44) * p / 100, 10, VIOLET);
  tft.setTextDatum(MC_DATUM);
  tft.setTextFont(2);
  tft.setTextColor(GREY, TFT_BLACK);
  tft.fillRect(0, 172, SCREEN_W, 18, TFT_BLACK);
  tft.drawString(fit(detail, SCREEN_W - 16), SCREEN_W / 2, 180);
  tft.setTextDatum(TL_DATUM);
  if (p >= 100) shown = "";
}

void display::showIdentify(const String& name) {
  if (!started) return;
  tft.fillScreen(VIOLET);
  tft.setTextDatum(MC_DATUM);
  tft.setTextFont(4);
  tft.setTextColor(WHITE, VIOLET);
  tft.drawString("This screen", SCREEN_W / 2, SCREEN_H / 2 - 20);
  tft.drawString(fit(name.length() ? name : String("RaptHooker"), SCREEN_W - 16), SCREEN_W / 2, SCREEN_H / 2 + 14);
  tft.setTextDatum(TL_DATUM);
}

void display::showPairing(const String& code) {
  if (!started) return;
  tft.fillScreen(TFT_BLACK);
  jpeg::draw(LOGO_JPG, sizeof(LOGO_JPG), (SCREEN_W - LOGO_SIZE) / 2, 20, pushBlock);
  tft.setTextDatum(MC_DATUM);
  tft.setTextFont(2);
  tft.setTextColor(GREY, TFT_BLACK);
  tft.drawString("Pairing code", SCREEN_W / 2, 108);
  tft.setTextFont(4);
  tft.setTextSize(2);
  tft.setTextColor(WHITE, TFT_BLACK);
  tft.drawString(code, SCREEN_W / 2, 150);
  tft.setTextSize(1);
  tft.setTextFont(2);
  tft.setTextColor(GREY, TFT_BLACK);
  tft.drawString("Type it into RaptHooker", SCREEN_W / 2, 200);
  tft.setTextDatum(TL_DATUM);
}
