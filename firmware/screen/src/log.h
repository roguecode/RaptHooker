#pragma once
#include <Arduino.h>

// Log lines go to the serial port and to a small ring buffer that /api/log returns, since a screen in a
// case has no serial port to read.
void logf(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
void logWrite(Print& out);
// SDC2: keeps what was logged before a restart (a crash, say), so /api/log has it. Before anything is logged.
void logKeep();
// SDC2: the last line logged before that restart, without its time ("" if it didn't keep one).
const char* logBefore();
