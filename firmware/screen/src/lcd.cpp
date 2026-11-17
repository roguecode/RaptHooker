#include "lcd.h"

#if defined(RH_BOARD_SDC2)

#include <driver/spi_master.h>
#include <esp_heap_caps.h>
#include <esp_lcd_panel_io.h>
#include <freertos/semphr.h>

#include "hw.h"

#include "fonts/font2.inc"
#include "fonts/font4.inc"

static const uint8_t FONT2_HEIGHT = 16, FONT4_HEIGHT = 26;
static const int32_t BAND_PIXELS = SCREEN_W * 16;
static SemaphoreHandle_t sent = nullptr;

static inline uint16_t swapped(uint16_t c) { return (c >> 8) | (c << 8); }

static bool IRAM_ATTR colorSent(esp_lcd_panel_io_handle_t, esp_lcd_panel_io_event_data_t*, void*) {
  BaseType_t woken = pdFALSE;
  xSemaphoreGiveFromISR(sent, &woken);
  return woken == pdTRUE;
}

bool Lcd::begin(int8_t sclk, int8_t mosi, int8_t dc, int8_t rst, uint8_t spiMode, uint32_t hz) {
  buf = (uint16_t*)heap_caps_malloc(BAND_PIXELS * 2, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
  sent = xSemaphoreCreateBinary();
  if (!buf || !sent) return false;
  spi_bus_config_t bus = {};
  bus.sclk_io_num = sclk;
  bus.mosi_io_num = mosi;
  bus.miso_io_num = -1;
  bus.quadwp_io_num = -1;
  bus.quadhd_io_num = -1;
  bus.max_transfer_sz = BAND_PIXELS * 2;
  if (spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO) != ESP_OK) return false;
  esp_lcd_panel_io_spi_config_t cfg = {};
  cfg.cs_gpio_num = -1;  // tied low on the board
  cfg.dc_gpio_num = dc;
  cfg.spi_mode = spiMode;
  cfg.pclk_hz = hz;
  cfg.trans_queue_depth = 4;
  cfg.on_color_trans_done = colorSent;
  cfg.lcd_cmd_bits = 8;
  cfg.lcd_param_bits = 8;
  esp_lcd_panel_io_handle_t h = nullptr;
  if (esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)SPI2_HOST, &cfg, &h) != ESP_OK) return false;
  io = h;
  if (rst >= 0) {
    pinMode(rst, OUTPUT);
    digitalWrite(rst, HIGH);
    delay(5);
    digitalWrite(rst, LOW);
    delay(20);
    digitalWrite(rst, HIGH);
    delay(150);
  }
  return true;
}

void Lcd::command(uint8_t cmd, const uint8_t* args, size_t n) {
  if (io) esp_lcd_panel_io_tx_param((esp_lcd_panel_io_handle_t)io, cmd, args, n);
}

void Lcd::setMadctl(uint8_t madctl, uint8_t offset) {
  rowOffset = offset;
  command(0x36, &madctl, 1);
}

void Lcd::invertDisplay(bool on) { command(on ? 0x21 : 0x20); }

void Lcd::window(int32_t x0, int32_t y0, int32_t x1, int32_t y1) {
  y0 += rowOffset;
  y1 += rowOffset;
  uint8_t c[4] = {(uint8_t)(x0 >> 8), (uint8_t)x0, (uint8_t)(x1 >> 8), (uint8_t)x1};
  uint8_t r[4] = {(uint8_t)(y0 >> 8), (uint8_t)y0, (uint8_t)(y1 >> 8), (uint8_t)y1};
  command(0x2A, c, 4);
  command(0x2B, r, 4);
}

// Pixels for the window just set (RAMWR), waiting until they've gone so the buffer can be used again.
void Lcd::send(const void* data, size_t bytes) {
  if (!io || !bytes) return;
  if (esp_lcd_panel_io_tx_color((esp_lcd_panel_io_handle_t)io, 0x2C, data, bytes) == ESP_OK)
    xSemaphoreTake(sent, pdMS_TO_TICKS(1000));
}

void Lcd::fillRect(int32_t x, int32_t y, int32_t w, int32_t h, uint16_t color) {
  if (x < 0) w += x, x = 0;
  if (y < 0) h += y, y = 0;
  if (x + w > SCREEN_W) w = SCREEN_W - x;
  if (y + h > SCREEN_H) h = SCREEN_H - y;
  if (w <= 0 || h <= 0 || !buf) return;
  int32_t rows = min(h, BAND_PIXELS / w);
  uint16_t c = swapped(color);
  for (int32_t i = 0; i < rows * w; i++) buf[i] = c;
  for (int32_t done = 0; done < h; done += rows) {
    int32_t n = min(rows, h - done);
    window(x, y + done, x + w - 1, y + done + n - 1);
    send(buf, n * w * 2);
  }
}

void Lcd::fillScreen(uint16_t color) { fillRect(0, 0, SCREEN_W, SCREEN_H, color); }

void Lcd::drawFastHLine(int32_t x, int32_t y, int32_t w, uint16_t color) { fillRect(x, y, w, 1, color); }

void Lcd::drawRect(int32_t x, int32_t y, int32_t w, int32_t h, uint16_t color) {
  fillRect(x, y, w, 1, color);
  fillRect(x, y + h - 1, w, 1, color);
  fillRect(x, y, 1, h, color);
  fillRect(x + w - 1, y, 1, h, color);
}

static int32_t edgeX(int32_t xa, int32_t ya, int32_t xb, int32_t yb, int32_t y) {
  return ya == yb ? xa : xa + (xb - xa) * (y - ya) / (yb - ya);
}

void Lcd::fillTriangle(int32_t x0, int32_t y0, int32_t x1, int32_t y1, int32_t x2, int32_t y2, uint16_t color) {
  if (y0 > y1) std::swap(y0, y1), std::swap(x0, x1);
  if (y1 > y2) std::swap(y1, y2), std::swap(x1, x2);
  if (y0 > y1) std::swap(y0, y1), std::swap(x0, x1);
  for (int32_t y = y0; y <= y2; y++) {
    int32_t a = edgeX(x0, y0, x2, y2, y);
    int32_t b = y < y1 ? edgeX(x0, y0, x1, y1, y) : edgeX(x1, y1, x2, y2, y);
    if (a > b) std::swap(a, b);
    fillRect(a, y, b - a + 1, 1, color);
  }
}

void Lcd::pushImage(int32_t x, int32_t y, int32_t w, int32_t h, const uint16_t* data) {
  if (w <= 0 || h <= 0) return;
  if (x >= 0 && y >= 0 && x + w <= SCREEN_W && y + h <= SCREEN_H) {
    window(x, y, x + w - 1, y + h - 1);
    send(data, w * h * 2);
    return;
  }
  int32_t x0 = max<int32_t>(x, 0), x1 = min<int32_t>(x + w, SCREEN_W);
  if (x0 >= x1) return;
  for (int32_t row = 0; row < h; row++) {
    if (y + row < 0 || y + row >= SCREEN_H) continue;
    window(x0, y + row, x1 - 1, y + row);
    send(data + row * w + (x0 - x), (x1 - x0) * 2);
  }
}

static const uint8_t* widthTable(uint8_t font) { return font == 4 ? widtbl_f32 : widtbl_f16; }

// Characters the fonts have; anything else (UTF-8 above ASCII, say) takes no room and isn't drawn.
static bool drawable(char c) { return c >= 32 && c <= 127; }

int16_t Lcd::textWidth(const String& s) {
  const uint8_t* widths = widthTable(textFont);
  int32_t w = 0;
  for (size_t i = 0; i < s.length(); i++)
    if (drawable(s[i])) w += widths[s[i] - 32];
  return w * textSize;
}

void Lcd::drawString(const String& s, int32_t x, int32_t y) {
  int32_t w = textWidth(s);
  int32_t h = (textFont == 4 ? FONT4_HEIGHT : FONT2_HEIGHT) * textSize;
  if (textDatum == MC_DATUM) {
    x -= w / 2;
    y -= h / 2;
  }
  int32_t cx0 = max<int32_t>(x, 0), cx1 = min<int32_t>(x + w, SCREEN_W);
  int32_t top = max<int32_t>(y, 0), bottom = min<int32_t>(y + h, SCREEN_H);
  if (!buf || cx0 >= cx1 || top >= bottom) return;
  int32_t cw = cx1 - cx0;
  int32_t bandRows = min(bottom - top, BAND_PIXELS / cw);
  uint16_t fg = swapped(textFg), bg = swapped(textBg);
  const uint8_t* widths = widthTable(textFont);
  for (int32_t by = top; by < bottom; by += bandRows) {
    int32_t rows = min(bandRows, bottom - by);
    for (int32_t i = 0; i < rows * cw; i++) buf[i] = bg;
    // One of the character's own pixels, scaled up by the text size, wherever it falls in this band.
    auto plot = [&](int32_t gx, int32_t px, int32_t py) {
      for (int32_t j = 0; j < textSize; j++) {
        int32_t oy = y + py * textSize + j - by;
        if (oy < 0 || oy >= rows) continue;
        for (int32_t i = 0; i < textSize; i++) {
          int32_t ox = gx + px * textSize + i - cx0;
          if (ox >= 0 && ox < cw) buf[oy * cw + ox] = fg;
        }
      }
    };
    int32_t gx = x;
    for (size_t n = 0; n < s.length(); n++) {
      char c = s[n];
      if (!drawable(c)) continue;
      uint8_t gw = widths[c - 32];
      if (textFont == 4) {
        // Run-length encoded: a byte with the top bit set is that many (+1) lit pixels, else that many unlit.
        const uint8_t* p = chrtbl_f32[c - 32];
        int32_t total = gw * FONT4_HEIGHT;
        for (int32_t pc = 0; pc < total;) {
          uint8_t b = *p++;
          if (b & 0x80) {
            for (int32_t k = (b & 0x7F) + 1; k > 0 && pc < total; k--, pc++) plot(gx, pc % gw, pc / gw);
          } else {
            pc += b + 1;
          }
        }
      } else {
        // A bitmap, most significant bit first, (width + 6) / 8 bytes a row: the width includes a column of spacing,
        // so pixels past the row's bytes are background.
        const uint8_t* p = chrtbl_f16[c - 32];
        int32_t perRow = (gw + 6) / 8;
        int32_t cols = min<int32_t>(gw, perRow * 8);
        for (int32_t py = 0; py < FONT2_HEIGHT; py++)
          for (int32_t px = 0; px < cols; px++)
            if (p[py * perRow + px / 8] & (0x80 >> (px % 8))) plot(gx, px, py);
      }
      gx += gw * textSize;
    }
    window(cx0, by, cx1 - 1, by + rows - 1);
    send(buf, rows * cw * 2);
  }
}

#endif
