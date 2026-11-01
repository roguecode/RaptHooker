#include "image.h"

#include <coredecls.h>

static const size_t APP_AT = 0x1000;  // elf2bin pads the boot loader to 4 KB; the app follows
static const size_t CRC_AT = 0x1010;  // length and CRC words elf2bin writes (core 3.x builds)

static uint32_t le32(const uint8_t* b) {
  return b[0] | (b[1] << 8) | (b[2] << 16) | ((uint32_t)b[3] << 24);
}

void ImageCheck::begin(size_t size) {
  *this = ImageCheck();
  expect = size;
}

void ImageCheck::fail(const char* why) {
  if (stage == Bad) return;
  problem = why;
  stage = Bad;
}

void ImageCheck::feedCrc(const uint8_t* p, size_t n) {
  size_t start = pos, end = pos + n;
  for (size_t o = max(start, CRC_AT); o < min(end, CRC_AT + 8); o++) {
    size_t k = o - CRC_AT;
    uint32_t b = p[o - start];
    crcXor ^= b;
    if (k < 4) crcLen |= b << (8 * k);
    else crcVal |= b << (8 * (k - 4));
  }
  // The CRC covers the image with those two words as zero.
  static const uint8_t zero[8] = {0};
  if (end <= CRC_AT || start >= CRC_AT + 8) {
    crc = crc32(p, n, crc);
    return;
  }
  if (start < CRC_AT) crc = crc32(p, CRC_AT - start, crc);
  crc = crc32(zero, min(end, CRC_AT + 8) - max(start, CRC_AT), crc);
  if (end > CRC_AT + 8) crc = crc32(p + (CRC_AT + 8 - start), end - (CRC_AT + 8), crc);
}

void ImageCheck::add(const uint8_t* p, size_t n) {
  if (stage == Bad) {
    pos += n;
    return;
  }
  if (pos + n > expect) {
    fail("longer than its size");
    pos += n;
    return;
  }
  feedCrc(p, n);
  size_t i = 0;
  while (i < n && stage != Bad) {
    size_t at = pos + i;
    if (stage == Pad) {
      size_t k = min(n - i, APP_AT - at);
      i += k;
      if (pos + i == APP_AT) stage = AppHeader;
    } else if (stage == SegData) {
      size_t k = min<size_t>(n - i, segLeft);
      for (size_t j = 0; j < k; j++) sum ^= p[i + j];
      i += k;
      segLeft -= k;
      if (!segLeft) stage = ++seg == segs ? Tail : SegHeader;
    } else if (stage == Tail) {
      // Zero padding, then the checksum as the last byte of a 16-byte line. elf2bin works the app's
      // checksum out before it fills in the length and CRC words, so with those it's as if they were zero.
      if ((at + 1) % 16 == 0) {
        bool ok = p[i] == sum || (inApp && crcLen == expect && p[i] == (uint8_t)(sum ^ crcXor));
        if (!ok) fail(inApp ? "bad checksum" : "bad boot loader checksum");
        else if (inApp) stage = Done;
        else if (at >= APP_AT) fail("boot loader too big");
        else stage = at + 1 == APP_AT ? AppHeader : Pad;
      }
      i++;
    } else if (stage == Done) {
      fail("data after the image");
    } else {
      hdr[fill++] = p[i++];
      if (fill < 8) continue;
      fill = 0;
      size_t next = pos + i;
      uint32_t entry = le32(hdr + 4);
      if (stage == Boot) {
        // The boot loader runs from the top of IRAM, before the flash cache is on.
        if (hdr[0] != 0xE9) fail("not ESP8266 firmware");
        else if (hdr[2] > 3) fail("bad flash mode");
        else if (!hdr[1] || hdr[1] > 16) fail("bad boot loader");
        else if (entry < 0x40100000 || entry >= 0x40110000) fail("bad boot loader entry point");
        else {
          mode = hdr[2];
          sizeCode = hdr[3] >> 4;
          segs = hdr[1];
          seg = 0;
          sum = 0xEF;
          inApp = false;
          stage = SegHeader;
        }
      } else if (stage == AppHeader) {
        if (hdr[0] != 0xE9) fail("no app at 0x1000");
        else if (!hdr[1] || hdr[1] > 16) fail("bad segment count");
        else if (hdr[2] != mode || (hdr[3] >> 4) != sizeCode) fail("headers disagree");
        else if (entry < 0x40100000 || entry >= 0x4010C000) fail("bad entry point");
        else {
          segs = hdr[1];
          seg = 0;
          sum = 0xEF;
          inApp = true;
          stage = SegHeader;
        }
      } else {
        uint32_t addr = le32(hdr), len = le32(hdr + 4);
        uint32_t iramEnd = inApp ? 0x4010C000 : 0x40110000;
        bool irom = inApp && addr >= 0x40201010 && addr < 0x40300000 && len <= 0x40300000 - addr;
        bool iram = addr >= 0x40100000 && addr < iramEnd && len <= iramEnd - addr;
        bool dram = addr >= 0x3FFE8000 && addr < 0x40000000 && len <= 0x40000000 - addr;
        size_t limit = inApp ? expect : APP_AT;
        if (!irom && !iram && !dram) fail("segment out of range");
        else if (next > limit || len > limit - next) fail(inApp ? "segment past the end" : "boot loader too big");
        else if (len) {
          segLeft = len;
          stage = SegData;
        } else {
          stage = ++seg == segs ? Tail : SegHeader;
        }
      }
    }
  }
  pos += n;
}

bool ImageCheck::finish(String& error) {
  if (stage == Bad) error = problem;
  else if (pos != expect) error = "cut short";
  else if (stage != Done) error = "incomplete image";
  else if (hasCrc() && crc != crcVal) error = "CRC doesn't match";
  else if (ESP.magicFlashChipSize(sizeCode) > ESP.getFlashChipRealSize()) error = "built for a bigger flash chip";
  else return true;
  return false;
}
