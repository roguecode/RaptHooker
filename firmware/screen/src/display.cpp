#include "display.h"

#include <TFT_eSPI.h>

#include "hw.h"
#include "jpeg.h"
#include "log.h"
#include "logo.h"
#include "store.h"

static TFT_eSPI tft;
static bool started = false;
static char controllerId[8] = "st7789";

static const int BANNER_H = 18;

static bool pushBlock(int16_t x, int16_t y, uint16_t w, uint16_t h, uint16_t* data) {
  if (y >= SCREEN_H || x >= SCREEN_W) return true;
  tft.pushImage(x, y, w, h, data);
  return true;
}

static void replayPanelInit(const uint8_t* p) {
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

#if defined(RH_BOARD_SDPRO)

void display::begin(uint8_t brightness) {
  pinMode(PIN_BACKLIGHT, OUTPUT);
  digitalWrite(PIN_BACKLIGHT, HIGH);  // off while the panel starts
  analogWriteRange(1023);
  analogWriteFreq(1000);
  tft.init();
  tft.writecommand(0x01);  // SWRESET, then the stock set-up from a clean slate
  delay(150);
  replayPanelInit(PANEL_INIT);
  tft.setRotation(0);
  tft.fillScreen(TFT_BLACK);
  started = true;
  setBrightness(brightness);
  logf("display: ready");
}

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

void display::setPanel(uint8_t) {}
const char* display::profile() { return "sdpro"; }

#elif defined(RH_BOARD_CYD)

#include <SPI.h>

static const uint8_t BACKLIGHT_CHANNEL = 0;
static PanelProfile panel = PANEL_ILI9341;
static uint8_t corrections = 0;

// Reads the controller's ID before TFT_eSPI starts, slowly, on a bus of its own: RDDID (04h, after a dummy bit) and
// the ILI9341's RDID4 (D3h).
static void readController(uint32_t& rddid, uint32_t& rdid4) {
  SPIClass spi(HSPI);
  spi.begin(TFT_SCLK, TFT_MISO, TFT_MOSI, -1);
  pinMode(TFT_CS, OUTPUT);
  pinMode(TFT_DC, OUTPUT);
  auto command = [&](uint8_t c, uint8_t* out, size_t n) {
    spi.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
    digitalWrite(TFT_CS, LOW);
    digitalWrite(TFT_DC, LOW);
    spi.transfer(c);
    digitalWrite(TFT_DC, HIGH);
    for (size_t i = 0; i < n; i++) out[i] = spi.transfer(0);
    digitalWrite(TFT_CS, HIGH);
    spi.endTransaction();
  };
  uint8_t b[4];
  command(0x01, b, 0);  // SWRESET
  delay(150);
  command(0x04, b, 4);
  rddid = (((uint32_t)b[0] << 24 | (uint32_t)b[1] << 16 | (uint32_t)b[2] << 8 | b[3]) >> 7) & 0xFFFFFF;
  command(0xD3, b, 4);
  rdid4 = (uint32_t)b[1] << 16 | (uint32_t)b[2] << 8 | b[3];
  spi.end();
}

// The XPT2046 touch controller: one command with power-down bits 00 leaves its pen interrupt on, which is all the
// firmware reads (a tap anywhere shows the details).
static void touchInterruptOn() {
  pinMode(PIN_TOUCH_CS, OUTPUT);
  pinMode(PIN_TOUCH_CLK, OUTPUT);
  pinMode(PIN_TOUCH_MOSI, OUTPUT);
  digitalWrite(PIN_TOUCH_CLK, LOW);
  digitalWrite(PIN_TOUCH_CS, LOW);
  const uint8_t c = 0x90;
  for (int i = 7; i >= 0; i--) {
    digitalWrite(PIN_TOUCH_MOSI, (c >> i) & 1);
    digitalWrite(PIN_TOUCH_CLK, HIGH);
    digitalWrite(PIN_TOUCH_CLK, LOW);
  }
  for (int i = 0; i < 16; i++) {
    digitalWrite(PIN_TOUCH_CLK, HIGH);
    digitalWrite(PIN_TOUCH_CLK, LOW);
  }
  digitalWrite(PIN_TOUCH_CS, HIGH);
}

static void applyPanel() {
  uint8_t m = panel.madctl;
  if (corrections & PANEL_FLIP) m ^= MADCTL_MX | MADCTL_MY;
  if (corrections & PANEL_MIRROR) m ^= MADCTL_MY;
  if (corrections & PANEL_SWAP) m ^= MADCTL_BGR;
  tft.writecommand(0x36);
  tft.writedata(m);
  tft.invertDisplay(panel.invert != ((corrections & PANEL_INVERT) != 0));
}

void display::begin(uint8_t brightness) {
  for (uint8_t pin : {PIN_LED_R, PIN_LED_G, PIN_LED_B}) {
    pinMode(pin, OUTPUT);
    digitalWrite(pin, HIGH);  // off
  }
  ledcSetup(BACKLIGHT_CHANNEL, 5000, 10);
  ledcAttachPin(PIN_BACKLIGHT, BACKLIGHT_CHANNEL);
  ledcWrite(BACKLIGHT_CHANNEL, 0);  // off while the panel starts
  uint32_t rddid = 0, rdid4 = 0;
  readController(rddid, rdid4);
  if (rdid4 == 0x9341) {
    panel = PANEL_ILI9341;
    strcpy(controllerId, "9341");
  } else {
    snprintf(controllerId, sizeof(controllerId), "%06x", (unsigned)rddid);
    panel = rddid == 0x8181B3 ? PANEL_8181B3 : (rddid >> 8) == 0x8585 ? PANEL_ST7789 : PANEL_ILI9341;
  }
  tft.init();
  if (panel.init) {
    tft.writecommand(0x01);  // SWRESET: from a clean slate, without TFT_eSPI's ILI9341 set-up
    delay(150);
    replayPanelInit(panel.init);
  }
  tft.setRotation(1);  // TFT_eSPI's idea of the size: 320x240. applyPanel sets the real way round.
  corrections = store::settings().panel;
  applyPanel();
  tft.fillScreen(TFT_BLACK);
  touchInterruptOn();
  started = true;
  setBrightness(brightness);
  logf("display: controller %s, profile %s, corrections %u", controllerId, panel.name, corrections);
}

void display::setBrightness(uint8_t percent) {
  if (!started) return;
  percent = constrain(percent, 1, 100);
  ledcWrite(BACKLIGHT_CHANNEL, (uint32_t)percent * 1023 / 100);
}

void display::setPanel(uint8_t c) {
  corrections = c & 0x0F;
  if (!started) return;
  applyPanel();
  logf("display: corrections %u", corrections);
}

const char* display::profile() { return panel.name; }

#endif

bool display::ready() { return started; }
const char* display::controller() { return controllerId; }

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

void display::showTest() {
  if (!started) return;
  // Three bars, each named for its colour, then a black band with words that read the right way round only when the
  // panel is. A corner mark shows which way is up.
  static const uint16_t BAR_COLORS[3] = {0xF800, 0x07E0, 0x001F};
  static const char* const BAR_NAMES[3] = {"Red", "Green", "Blue"};
  int bar = (SCREEN_H - 90) / 3;
  tft.fillScreen(TFT_BLACK);
  tft.setTextDatum(MC_DATUM);
  tft.setTextFont(4);
  for (int i = 0; i < 3; i++) {
    tft.fillRect(0, i * bar, SCREEN_W, bar, BAR_COLORS[i]);
    tft.setTextColor(WHITE, BAR_COLORS[i]);
    tft.drawString(BAR_NAMES[i], SCREEN_W / 2, i * bar + bar / 2);
  }
  tft.fillTriangle(0, 0, 28, 0, 0, 28, WHITE);
  tft.setTextColor(WHITE, TFT_BLACK);
  tft.drawString("RaptHooker", SCREEN_W / 2, SCREEN_H - 66);
  tft.setTextFont(2);
  tft.setTextColor(GREY, TFT_BLACK);
  tft.drawString("Red at the top, words left to right,", SCREEN_W / 2, SCREEN_H - 38);
  tft.drawString("and this band black? Then it's right.", SCREEN_W / 2, SCREEN_H - 20);
  tft.setTextDatum(TL_DATUM);
}
