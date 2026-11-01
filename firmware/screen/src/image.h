#pragma once
#include <Arduino.h>

// Checks an ESP8266 Arduino firmware image as it streams in: the boot loader and app headers, the
// segments and their checksum, the exact length, and (for builds that have one) the CRC elf2bin puts at
// 0x1010. The Updater on its own only checks the first byte and the flash size.
class ImageCheck {
 public:
  void begin(size_t size);
  void add(const uint8_t* p, size_t n);
  bool finish(String& error);
  bool hasCrc() const { return crcLen == expect; }

 private:
  enum Stage : uint8_t { Boot, Pad, AppHeader, SegHeader, SegData, Tail, Done, Bad };
  void fail(const char* why);
  void feedCrc(const uint8_t* p, size_t n);

  size_t expect = 0, pos = 0;
  Stage stage = Boot;
  uint8_t hdr[8];
  uint8_t fill = 0, segs = 0, seg = 0, sum = 0xEF, mode = 0, sizeCode = 0, crcXor = 0;
  bool inApp = false;
  uint32_t segLeft = 0, crc = 0xFFFFFFFF, crcLen = 0, crcVal = 0;
  const char* problem = nullptr;
};
