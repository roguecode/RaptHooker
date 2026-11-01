#pragma once
#include <Arduino.h>

// Worked out from the stock "SD Pro" firmware. The panel is an ST7789 on HSPI (SCLK 14, MOSI 13) with
// CS 15, DC 0 and RST 2, SPI mode 3 at 40 MHz: those are set for TFT_eSPI in platformio.ini.
static const uint8_t PIN_BACKLIGHT = 5;  // PWM, low is on
static const uint8_t PIN_BUTTON = 4;     // pulled up, reads low when pressed
static const uint16_t SCREEN_W = 240;
static const uint16_t SCREEN_H = 240;

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
