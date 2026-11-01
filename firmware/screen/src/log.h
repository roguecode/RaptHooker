#pragma once
#include <Arduino.h>

// Log lines go to the serial port and to a small ring buffer that /api/log returns, since a screen in a
// case has no serial port to read.
void logf(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
void logWrite(Print& out);
