#pragma once
#include <Arduino.h>

// The board each build is for (RH_BOARD_* from platformio.ini): its pins, screen size and panel set-up. The display
// pins themselves are TFT_eSPI's, set in platformio.ini too.

#if defined(RH_BOARD_SDPRO)

// Worked out from the stock "SD Pro" firmware. The panel is an ST7789 on HSPI (SCLK 14, MOSI 13) with
// CS 15, DC 0 and RST 2, SPI mode 3 at 40 MHz: those are set for TFT_eSPI in platformio.ini.
static const uint8_t PIN_BACKLIGHT = 5;  // PWM, low is on
static const uint8_t PIN_BUTTON = 4;     // pulled up, reads low when pressed
static const uint16_t SCREEN_W = 240;
static const uint16_t SCREEN_H = 240;
#define RH_HAS_PANEL 0

// The stock firmware's own panel set-up, replayed after TFT_eSPI's so the colours match it exactly.
// Format: count, then per command: cmd, args | 0x80 if a delay follows, args..., delay ms (255 = 500).
static const uint8_t PANEL_INIT[] PROGMEM = {
    20,
    0x11, 0x80, 255,                                     // SLPOUT
    0x3A, 0x81, 0x55, 10,                                // COLMOD 16-bit
    0x36, 0x01, 0x00,                                    // MADCTL
    0x2A, 0x04, 0x00, 0x00, 0x00, 0xF0,                  // CASET
    0x2B, 0x04, 0x00, 0x00, 0x00, 0xF0,                  // RASET
    0xB2, 0x05, 0x0C, 0x0C, 0x00, 0x33, 0x33,            // PORCTRL
    0xB7, 0x01, 0x35,                                    // GCTRL
    0xBB, 0x01, 0x1F,                                    // VCOMS
    0xC0, 0x01, 0x2C,                                    // LCMCTRL
    0xC2, 0x01, 0x01,                                    // VDVVRHEN
    0xC3, 0x01, 0x12,                                    // VRHS
    0xC4, 0x01, 0x20,                                    // VDVSET
    0xC6, 0x01, 0x0F,                                    // FRCTRL2
    0xD0, 0x02, 0xA4, 0xA1,                              // PWCTRL1
    0xE0, 0x0E, 0xD0, 0x08, 0x11, 0x08, 0x0C, 0x15, 0x39, 0x33, 0x50, 0x36, 0x13, 0x14, 0x29, 0x2D,
    0xE1, 0x0E, 0xD0, 0x08, 0x10, 0x08, 0x06, 0x06, 0x39, 0x44, 0x51, 0x0B, 0x16, 0x14, 0x2F, 0x31,
    0xE4, 0x03, 0x1D, 0x00, 0x00,                        // GATECTRL: 240 lines
    0x21, 0x80, 10,                                      // INVON
    0x13, 0x80, 10,                                      // NORON
    0x29, 0x80, 255,                                     // DISPON
};

#elif defined(RH_BOARD_CYD)

// ESP32-2432S028 ("Cheap Yellow Display"). Display on HSPI: SCLK 14, MOSI 13, MISO 12, CS 15, DC 2, reset tied to
// the ESP32's own. Touch is an XPT2046 on pins of its own; a tap anywhere (or the BOOT button) shows the details.
static const uint8_t PIN_BACKLIGHT = 21;  // PWM, high is on
static const uint8_t PIN_BUTTON = 0;      // BOOT: pulled up, reads low when pressed
static const uint8_t PIN_TOUCH_IRQ = 36;  // XPT2046 PENIRQ: low while touched
static const uint8_t PIN_TOUCH_CS = 33, PIN_TOUCH_CLK = 25, PIN_TOUCH_MOSI = 32;
static const uint8_t PIN_LED_R = 4, PIN_LED_G = 16, PIN_LED_B = 17;  // RGB LED, low is on
static const uint16_t SCREEN_W = 320;
static const uint16_t SCREEN_H = 240;
#define RH_HAS_PANEL 1

// Panel set-ups, replayed after a software reset. Format: count, then per command: cmd, args | 0x80 if a delay
// follows, args..., delay ms.

// Just enough to start: what the 81 81 B3 controller wants. It takes the ILI9341 set-up TFT_eSPI sends too, but then
// ignores the row/column exchange (MV), so landscape comes out transposed.
static const uint8_t MINIMAL_INIT[] PROGMEM = {
    4,
    0x11, 0x80, 120,                                     // SLPOUT
    0x3A, 0x81, 0x55, 10,                                // COLMOD 16-bit
    0x13, 0x80, 10,                                      // NORON
    0x29, 0x80, 120,                                     // DISPON
};

// A generic ST7789 set-up (320 lines).
static const uint8_t ST7789_INIT[] PROGMEM = {
    16,
    0x11, 0x80, 120,                                     // SLPOUT
    0x3A, 0x81, 0x55, 10,                                // COLMOD 16-bit
    0xB2, 0x05, 0x0C, 0x0C, 0x00, 0x33, 0x33,            // PORCTRL
    0xB7, 0x01, 0x35,                                    // GCTRL
    0xBB, 0x01, 0x28,                                    // VCOMS
    0xC0, 0x01, 0x0C,                                    // LCMCTRL
    0xC2, 0x02, 0x01, 0xFF,                              // VDVVRHEN
    0xC3, 0x01, 0x10,                                    // VRHS
    0xC4, 0x01, 0x20,                                    // VDVSET
    0xC6, 0x01, 0x0F,                                    // FRCTRL2
    0xD0, 0x02, 0xA4, 0xA1,                              // PWCTRL1
    0xE0, 0x0E, 0xD0, 0x00, 0x02, 0x07, 0x0A, 0x28, 0x32, 0x44, 0x42, 0x06, 0x0E, 0x12, 0x14, 0x17,
    0xE1, 0x0E, 0xD0, 0x00, 0x02, 0x07, 0x0A, 0x28, 0x31, 0x54, 0x47, 0x0E, 0x1C, 0x17, 0x1B, 0x1E,
    0x21, 0x80, 10,                                      // INVON
    0x13, 0x80, 10,                                      // NORON
    0x29, 0x80, 120,                                     // DISPON
};

// The panel's controller differs from batch to batch, and so does which way round it's mounted. Each one known is a
// profile, picked by the ID the controller reports: its set-up, its MADCTL for landscape with the USB socket on the
// right, and whether the colours need inverting. Anything unknown gets the ILI9341's. RaptHooker can turn, mirror and
// fix the colours on top of the profile (the "panel" setting) for batches nobody has seen yet.
struct PanelProfile {
  const char* name;
  const uint8_t* init;  // nullptr: TFT_eSPI's ILI9341 set-up
  uint8_t madctl;
  bool invert;
};
static const PanelProfile PANEL_ILI9341 = {"ili9341", nullptr, 0x28, false};      // MV | BGR: TFT_eSPI's rotation 1
static const PanelProfile PANEL_8181B3 = {"8181b3", MINIMAL_INIT, 0x60, false};  // MX | MV, RGB (seen 2026, CH340)
static const PanelProfile PANEL_ST7789 = {"st7789", ST7789_INIT, 0x60, true};    // MX | MV, RGB, inverted

// MADCTL bits the "panel" setting toggles. In landscape (MV set) MY mirrors left to right and MX top to bottom.
static const uint8_t MADCTL_MY = 0x80, MADCTL_MX = 0x40, MADCTL_BGR = 0x08;
static const uint8_t PANEL_FLIP = 1, PANEL_MIRROR = 2, PANEL_SWAP = 4, PANEL_INVERT = 8;

#else
#error "Set a board (RH_BOARD_SDPRO, RH_BOARD_CYD) in platformio.ini"
#endif
