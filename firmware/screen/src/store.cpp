#include "store.h"

#include <ArduinoJson.h>

#include "log.h"

extern "C" uint32_t _FS_end;
extern "C" uint32_t _EEPROM_start;

static const uint32_t MAGIC = 0x31534852;  // "RHS1"
static const size_t SECTOR = 0x1000;
static const size_t HEADER = 12;

static Settings current;
static JsonDocument doc;  // everything that was stored, so unknown keys survive a save
static uint32_t address = 0;
static bool sealed = false;  // wiped for other firmware: nothing more is written

static uint32_t crc32(const uint8_t* p, size_t n) {
  uint32_t c = 0xFFFFFFFF;
  while (n--) {
    c ^= *p++;
    for (int k = 0; k < 8; k++) c = (c >> 1) ^ (0xEDB88320 & (0 - (c & 1)));
  }
  return ~c;
}

bool store::available() { return address != 0; }

void store::begin() {
  uint32_t start = (uint32_t)&_FS_end - 0x40200000;
  uint32_t end = (uint32_t)&_EEPROM_start - 0x40200000;
  if (start % SECTOR != 0 || end < start + SECTOR) {
    logf("store: no free sector between %06x and %06x", start, end);
    return;
  }
  address = start;
  uint32_t head[3];
  if (!ESP.flashRead(address, head, sizeof(head)) || head[0] != MAGIC || head[1] == 0 || head[1] > SECTOR - HEADER) {
    logf("store: empty");
    return;
  }
  size_t len = head[1];
  uint8_t* buf = (uint8_t*)malloc((len + 3) & ~3);
  if (!buf) return;
  if (ESP.flashRead(address + HEADER, (uint32_t*)buf, (len + 3) & ~3) && crc32(buf, len) == head[2] &&
      !deserializeJson(doc, (const char*)buf, len)) {
    current.ssid = doc["ssid"] | "";
    current.pass = doc["pass"] | "";
    current.token = doc["token"] | "";
    current.hub = doc["hub"] | "";
    current.name = doc["name"] | "";
    current.imageUrl = doc["imageUrl"] | "";
    current.interval = constrain((uint32_t)(doc["interval"] | 60), 5u, 86400u);
    current.brightness = constrain((int)(doc["brightness"] | 80), 1, 100);
    String p = doc["phy"] | "g";
    current.phy = p == "n" || p == "b" ? p : String("g");
    current.txPower = constrain((int)(doc["txPower"] | 0), 0, 20);
    logf("store: loaded %u bytes", len);
  } else {
    doc.clear();
    logf("store: bad checksum, ignoring");
  }
  free(buf);
}

Settings& store::settings() { return current; }

bool store::save() {
  if (!address || sealed) return false;
  if (!doc.is<JsonObject>()) doc.to<JsonObject>();
  doc["v"] = 1;
  doc["ssid"] = current.ssid;
  doc["pass"] = current.pass;
  doc["token"] = current.token;
  doc["hub"] = current.hub;
  doc["name"] = current.name;
  doc["imageUrl"] = current.imageUrl;
  doc["interval"] = current.interval;
  doc["brightness"] = current.brightness;
  doc["phy"] = current.phy;
  doc["txPower"] = current.txPower;
  size_t len = measureJson(doc);
  if (len > SECTOR - HEADER) {
    logf("store: settings too big (%u)", len);
    return false;
  }
  size_t total = (HEADER + len + 3) & ~3;
  uint8_t* buf = (uint8_t*)calloc(total + 4, 1);  // room for serializeJson's terminator
  if (!buf) return false;
  serializeJson(doc, (char*)buf + HEADER, len + 1);
  uint32_t head[3] = {MAGIC, len, crc32(buf + HEADER, len)};
  memcpy(buf, head, HEADER);
  bool ok = ESP.flashEraseSector(address / SECTOR) && ESP.flashWrite(address, (uint32_t*)buf, total);
  free(buf);
  logf("store: saved %u bytes: %s", len, ok ? "ok" : "failed");
  return ok;
}

void store::reset() {
  current = Settings();
  doc.clear();
  if (address) ESP.flashEraseSector(address / SECTOR);
  logf("store: reset");
}

void store::wipe() {
  reset();
  sealed = true;
}
