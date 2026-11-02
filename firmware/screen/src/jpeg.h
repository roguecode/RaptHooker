#pragma once
#include <Arduino.h>

// A thin wrapper over ChaN's TJpgDec (src/tjpgd). The data may be in RAM or in flash.
namespace jpeg {

typedef bool (*Output)(int16_t x, int16_t y, uint16_t w, uint16_t h, uint16_t* pixels);

// 0 when it worked, otherwise TJpgDec's JRESULT (or -1 for no memory).
int size(const uint8_t* data, size_t len, uint16_t& w, uint16_t& h);
int draw(const uint8_t* data, size_t len, int16_t x, int16_t y, Output out);

}  // namespace jpeg
