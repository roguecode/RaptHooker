#pragma once
// Just enough of Arduino for host tests of the pure-logic parts of the firmware.
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <string>
using std::max;
using std::min;
struct String : std::string {
  String() {}
  String(const char* s) : std::string(s ? s : "") {}
  String& operator=(const char* s) { assign(s ? s : ""); return *this; }
};
struct EspShim {
  uint32_t magicFlashChipSize(uint8_t b) {
    switch (b & 0xF) {
      case 0: return 512u << 10; case 1: return 256u << 10; case 2: return 1u << 20; case 3: return 2u << 20;
      case 4: return 4u << 20; case 8: return 8u << 20; case 9: return 16u << 20; default: return 0;
    }
  }
  uint32_t getFlashChipRealSize() { return 4u << 20; }
};
extern EspShim ESP;
