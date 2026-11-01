#pragma once
#include <cstddef>
#include <cstdint>
inline uint32_t crc32(const void* data, size_t length, uint32_t crc = 0xffffffff) {
  const uint8_t* p = (const uint8_t*)data;
  while (length--) {
    uint8_t c = *p++;
    for (uint32_t i = 0x80; i > 0; i >>= 1) {
      bool bit = crc & 0x80000000;
      if (c & i) bit = !bit;
      crc <<= 1;
      if (bit) crc ^= 0x04c11db7;
    }
  }
  return crc;
}
