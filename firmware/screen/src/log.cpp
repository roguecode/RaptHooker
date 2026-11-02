#include "log.h"

#include <stdarg.h>

#if defined(ESP32)
static const size_t LOG_SIZE = 8192;
#else
static const size_t LOG_SIZE = 3072;
#endif
static char ring[LOG_SIZE];
static size_t head = 0;
static bool wrapped = false;

static void put(const char* s, size_t n) {
  for (size_t i = 0; i < n; i++) {
    ring[head++] = s[i];
    if (head == LOG_SIZE) {
      head = 0;
      wrapped = true;
    }
  }
}

void logf(const char* fmt, ...) {
  char line[160];
  uint32_t s = millis() / 1000;
  int n = snprintf(line, sizeof(line), "[%lu:%02lu:%02lu] ", (unsigned long)(s / 3600), (unsigned long)(s / 60 % 60),
                   (unsigned long)(s % 60));
  va_list ap;
  va_start(ap, fmt);
  int m = vsnprintf(line + n, sizeof(line) - n - 1, fmt, ap);
  va_end(ap);
  size_t len = n + (m < 0 ? 0 : min((size_t)m, sizeof(line) - n - 2));
  line[len++] = '\n';
  line[len] = 0;
  Serial.print(line);
  put(line, len);
}

void logWrite(Print& out) {
  if (wrapped) {
    // Skip the partial first line.
    size_t i = head;
    while (i < LOG_SIZE && ring[i] != '\n') i++;
    if (i + 1 < LOG_SIZE) out.write((const uint8_t*)ring + i + 1, LOG_SIZE - i - 1);
  }
  out.write((const uint8_t*)ring, head);
}
