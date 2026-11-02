#include "platform.h"

#include "log.h"

static const uint32_t RTC_MAGIC = 0x52484332;
static const uint8_t CRASHES_FOR_SAFE_MODE = 3;
static bool safe = false;
static String reasonText;

bool plat::safeMode() { return safe; }
const char* plat::resetReason() { return reasonText.c_str(); }

#if defined(ESP8266)

#include <Crypto.h>

static const uint32_t RTC_BLOCK = 64;  // the first 128 bytes of RTC memory belong to the OTA boot loader

struct Rtc {
  uint32_t magic;
  uint32_t crashes;
};

void plat::begin() {
  rst_info* ri = ESP.getResetInfoPtr();
  reasonText = ESP.getResetReason();
  Rtc r;
  ESP.rtcUserMemoryRead(RTC_BLOCK, (uint32_t*)&r, sizeof(r));
  if (r.magic != RTC_MAGIC) r = {RTC_MAGIC, 0};
  bool crashed = ri->reason == REASON_WDT_RST || ri->reason == REASON_EXCEPTION_RST || ri->reason == REASON_SOFT_WDT_RST;
  r.crashes = crashed ? r.crashes + 1 : 0;
  ESP.rtcUserMemoryWrite(RTC_BLOCK, (uint32_t*)&r, sizeof(r));
  safe = r.crashes >= CRASHES_FOR_SAFE_MODE;
  logf("boot: %s, %u crash(es) in a row%s", reasonText.c_str(), r.crashes, safe ? ", safe mode" : "");
}

void plat::clearCrashes() {
  Rtc r = {RTC_MAGIC, 0};
  ESP.rtcUserMemoryWrite(RTC_BLOCK, (uint32_t*)&r, sizeof(r));
}

void plat::markGood() { clearCrashes(); }
bool plat::onTrial() { return false; }
const char* plat::chip() { return "esp8266"; }
uint32_t plat::maxBlock() { return ESP.getMaxFreeBlockSize(); }
uint32_t plat::random32() { return ESP.random(); }

String plat::hmacSha256(const String& key, const String& message) {
  return experimental::crypto::SHA256::hmac(message, key.c_str(), key.length(), 32);
}

void plat::systemInfo(JsonObject s) {
  s["uptime"] = millis() / 1000;
  s["heap"] = ESP.getFreeHeap();
  s["maxBlock"] = ESP.getMaxFreeBlockSize();
  s["frag"] = ESP.getHeapFragmentation();
  s["resetReason"] = resetReason();
  s["flashSize"] = ESP.getFlashChipRealSize();
  s["flashId"] = ESP.getFlashChipId();
  s["sketchSize"] = ESP.getSketchSize();
  s["freeSketch"] = ESP.getFreeSketchSpace();
  s["sketchMd5"] = ESP.getSketchMD5();
  s["core"] = ESP.getCoreVersion();
  s["sdk"] = ESP.getSdkVersion();
  s["cpuMhz"] = ESP.getCpuFreqMHz();
}

#elif defined(ESP32)

#include <esp_arduino_version.h>
#include <esp_ota_ops.h>
#include <esp_system.h>
#include <esp_timer.h>
#include <mbedtls/md.h>

static const uint64_t TRIAL_US = 10ULL * 60 * 1000 * 1000;

// Kept across restarts (not power cuts, which the magic catches).
RTC_NOINIT_ATTR static uint32_t rtcMagic;
RTC_NOINIT_ATTR static uint32_t rtcCrashes;
static volatile bool trial = false;
static esp_timer_handle_t guard = nullptr;

// Arduino marks new firmware good as it starts unless this says otherwise: here it has to earn it (markGood).
extern "C" bool verifyRollbackLater() { return true; }

static const char* describe(esp_reset_reason_t r) {
  switch (r) {
    case ESP_RST_POWERON: return "Power on";
    case ESP_RST_EXT: return "External reset";
    case ESP_RST_SW: return "Software/System restart";
    case ESP_RST_PANIC: return "Exception";
    case ESP_RST_INT_WDT: return "Interrupt watchdog";
    case ESP_RST_TASK_WDT: return "Task watchdog";
    case ESP_RST_WDT: return "Watchdog";
    case ESP_RST_DEEPSLEEP: return "Deep sleep";
    case ESP_RST_BROWNOUT: return "Brownout";
    default: return "Unknown";
  }
}

static void giveUp(void*) {
  // Still on trial after all this time: whatever this firmware is doing, it isn't working. The old one goes back.
  if (trial) esp_ota_mark_app_invalid_rollback_and_reboot();
}

void plat::begin() {
  esp_reset_reason_t r = esp_reset_reason();
  reasonText = describe(r);
  if (rtcMagic != RTC_MAGIC || r == ESP_RST_POWERON) {
    rtcMagic = RTC_MAGIC;
    rtcCrashes = 0;
  }
  bool crashed = r == ESP_RST_PANIC || r == ESP_RST_INT_WDT || r == ESP_RST_TASK_WDT || r == ESP_RST_WDT;
  rtcCrashes = crashed ? rtcCrashes + 1 : 0;
  safe = rtcCrashes >= CRASHES_FOR_SAFE_MODE;
  logf("boot: %s, %u crash(es) in a row%s", reasonText.c_str(), rtcCrashes, safe ? ", safe mode" : "");
  const esp_partition_t* running = esp_ota_get_running_partition();
  esp_ota_img_states_t state;
  if (running && esp_ota_get_state_partition(running, &state) == ESP_OK && state == ESP_OTA_IMG_PENDING_VERIFY) {
    trial = true;
    esp_timer_create_args_t args = {};
    args.callback = giveUp;
    args.name = "trial";
    if (esp_timer_create(&args, &guard) == ESP_OK) esp_timer_start_once(guard, TRIAL_US);
    logf("boot: new firmware in %s, on trial", running->label);
  }
}

void plat::clearCrashes() {
  rtcMagic = RTC_MAGIC;
  rtcCrashes = 0;
}

void plat::markGood() {
  clearCrashes();
  if (!trial) return;
  trial = false;
  if (guard) esp_timer_stop(guard);
  esp_err_t e = esp_ota_mark_app_valid_cancel_rollback();
  logf("boot: new firmware works, keeping it (%s)", e == ESP_OK ? "ok" : esp_err_to_name(e));
}

bool plat::onTrial() { return trial; }
const char* plat::chip() { return "esp32"; }
uint32_t plat::maxBlock() { return ESP.getMaxAllocHeap(); }
uint32_t plat::random32() { return esp_random(); }

String plat::hmacSha256(const String& key, const String& message) {
  uint8_t out[32];
  mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), (const uint8_t*)key.c_str(), key.length(),
                  (const uint8_t*)message.c_str(), message.length(), out);
  char hex[65];
  for (int i = 0; i < 32; i++) snprintf(hex + i * 2, 3, "%02x", out[i]);
  return hex;
}

void plat::systemInfo(JsonObject s) {
  const esp_partition_t* running = esp_ota_get_running_partition();
  s["uptime"] = millis() / 1000;
  s["heap"] = ESP.getFreeHeap();
  s["maxBlock"] = ESP.getMaxAllocHeap();
  s["minHeap"] = ESP.getMinFreeHeap();
  s["resetReason"] = resetReason();
  s["flashSize"] = ESP.getFlashChipSize();
  s["sketchSize"] = ESP.getSketchSize();
  s["freeSketch"] = ESP.getFreeSketchSpace();
  s["sketchMd5"] = ESP.getSketchMD5();
  s["core"] = String(ESP_ARDUINO_VERSION_MAJOR) + "." + ESP_ARDUINO_VERSION_MINOR + "." + ESP_ARDUINO_VERSION_PATCH;
  s["sdk"] = ESP.getSdkVersion();
  s["cpuMhz"] = ESP.getCpuFreqMHz();
  s["chipModel"] = ESP.getChipModel();
  s["chipRev"] = ESP.getChipRevision();
  s["partition"] = running ? running->label : "";
  s["trial"] = trial;
}

#endif
