#include "log.h"

#include <stdarg.h>

#if defined(RH_BOARD_SDC2)
static const size_t LOG_SIZE = 4096;
#elif defined(ESP32)
static const size_t LOG_SIZE = 8192;
#else
static const size_t LOG_SIZE = 3072;
#endif
#if defined(RH_BOARD_SDC2)
#include <esp_system.h>
// Kept across a restart (not a power cut): with no serial port, what was logged before a crash is the only clue to it.
static const uint32_t KEPT = 0x4b4c4f47;
__NOINIT_ATTR static uint32_t kept;
__NOINIT_ATTR static char ring[LOG_SIZE];
__NOINIT_ATTR static size_t head;
__NOINIT_ATTR static uint8_t wrapped;
#else
static char ring[LOG_SIZE];
static size_t head = 0;
static bool wrapped = false;
#endif

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

#if defined(RH_BOARD_SDC2)
static char before[48];

// The last line logged before the restart, without its time.
static void keepBefore() {
  size_t have = wrapped ? LOG_SIZE : head;
  auto back = [](size_t i) { return ring[(head + LOG_SIZE - 1 - i) % LOG_SIZE]; };
  size_t end = have && back(0) == '\n' ? 1 : 0, i = end;
  while (i < have && back(i) != '\n') i++;
  size_t len = i - end, skip = 0;
  // Line character k is back(i - 1 - k).
  if (len && back(i - 1) == '[')
    for (size_t k = 1; k < len && k < 14; k++)
      if (back(i - 1 - k) == ']') {
        skip = k + 1 < len && back(i - 2 - k) == ' ' ? k + 2 : k + 1;
        break;
      }
  size_t n = 0;
  for (size_t k = skip; k < len && n < sizeof(before) - 1; k++) {
    char c = back(i - 1 - k);
    before[n++] = c >= ' ' && c <= '~' ? c : '?';  // what a brownout might have left
  }
  before[n] = 0;
}

void logKeep() {
  esp_reset_reason_t r = esp_reset_reason();
  if (kept != KEPT || head >= LOG_SIZE || wrapped > 1 || r == ESP_RST_POWERON || r == ESP_RST_UNKNOWN) {
    kept = KEPT;
    head = 0;
    wrapped = false;
    return;
  }
  keepBefore();
  static const char line[] = "--- restarted ---\n";
  put(line, sizeof(line) - 1);
}

const char* logBefore() { return before; }
#endif
