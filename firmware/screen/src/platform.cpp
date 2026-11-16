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
#if defined(RH_BOARD_SDC2)
#include <esp_app_desc.h>
#include <esp_memory_utils.h>
#include <esp_partition.h>
#include <esp_private/panic_internal.h>
#include <nvs.h>
#include <riscv/rvruntime-frames.h>
#endif

static const uint64_t TRIAL_US = 10ULL * 60 * 1000 * 1000;

#if defined(RH_BOARD_SDC2)
// The ESP32-C2 has no RTC memory: this keeps across restarts too.
#define RH_KEEP __NOINIT_ATTR
#else
#define RH_KEEP RTC_NOINIT_ATTR
#endif

// Kept across restarts (not power cuts, which the magic catches).
RH_KEEP static uint32_t rtcMagic;
RH_KEEP static uint32_t rtcCrashes;
static volatile bool trial = false;
static esp_timer_handle_t guard = nullptr;

#if defined(RH_BOARD_SDC2)
// The SDC2's boot loader is the stock firmware's. It takes new firmware back at its first restart, crash or not, which
// leaves no trace of why, and may not on every clock. So the firmware keeps a trial of its own, and ends the boot
// loader's once that's armed: new firmware (a build that hasn't yet been kept, by its ELF SHA-256 in NVS) is kept once it
// has been reached over the network, and otherwise goes back to what's in the other app slot (the stock firmware, at
// first) after 10 minutes, or after it has started four times without being kept.
static const char* BOOT_NS = "rhboot";
static const uint8_t TRIAL_STARTS = 4;
static bool bootloaderTrial = false;
static char build[17];

// What a crash left, for the next start: the panic handler's own report goes to a serial port nobody can reach. Kept by
// ESP-IDF's panic handler as it works out what happened (panic_arch_fill_info and panic_soc_fill_info are wrapped:
// -Wl,--wrap in platformio.ini), the flash cache back on, in memory a restart keeps.
static const uint32_t CRASH_MAGIC = 0x43525348;
static const size_t CRASH_CALLS = 32;
static const size_t CRASH_SCAN = 256;  // words of stack looked through for code addresses
struct CrashRecord {
  uint32_t magic;
  uint32_t pc, ra, sp, cause, tval;
  uint32_t abort;
  char reason[72];  // the exception, or what abort() was given
  char task[16];
  uint32_t calls;
  uint32_t call[CRASH_CALLS];  // code addresses on its stack, from the top: where it was called from
};
__NOINIT_ATTR static CrashRecord rec;
static bool crashKept = false;  // a crash in the panic handler itself comes through again: the first is the one
static plat::Crash crashNow;
static String crashSaved;

static void keepText(char* to, size_t size, const char* from) {
  size_t i = 0;
  if (from && (esp_ptr_internal(from) || esp_ptr_in_drom(from)))
    for (; i + 1 < size && from[i]; i++) to[i] = from[i];
  to[i] = 0;
}

// Only what's in RAM or flash is read (the stack pointer may be anything), and the task's name last, since the crash
// may have overwritten its control block.
static void keepCrash(void* frame, panic_info_t* info) {
  if (crashKept) return;
  crashKept = true;
  rec.magic = 0;
  const RvExcFrame* f = (const RvExcFrame*)frame;
  bool ok = f && esp_ptr_internal(f);
  rec.pc = (uint32_t)info->addr;
  rec.ra = ok ? f->ra : 0;
  rec.sp = ok ? f->sp : 0;
  rec.cause = ok ? f->mcause : 0;
  rec.tval = ok ? f->mtval : 0;
  rec.abort = g_panic_abort;
  keepText(rec.reason, sizeof(rec.reason), g_panic_abort ? g_panic_abort_details : info->reason);
  rec.calls = 0;
  const uint32_t* s = (const uint32_t*)rec.sp;
  for (size_t i = 0; !(rec.sp & 3) && i < CRASH_SCAN && rec.calls < CRASH_CALLS; i++) {
    if (!esp_ptr_internal(s + i) || !esp_ptr_internal((const uint8_t*)(s + i) + 3)) break;
    uint32_t w = s[i];
    if (!(w & 1) && esp_ptr_executable((const void*)w)) rec.call[rec.calls++] = w;
  }
  rec.task[0] = 0;
  rec.magic = CRASH_MAGIC;
  TaskHandle_t t = xTaskGetCurrentTaskHandle();
  if (t && esp_ptr_internal(t)) keepText(rec.task, sizeof(rec.task), pcTaskGetName(t));
}

extern "C" void __real_panic_arch_fill_info(void* frame, panic_info_t* info);
extern "C" void __real_panic_soc_fill_info(void* frame, panic_info_t* info);

extern "C" void __wrap_panic_arch_fill_info(void* frame, panic_info_t* info) {
  __real_panic_arch_fill_info(frame, info);
  keepCrash(frame, info);
}

// Watchdogs, cache errors and the stack guard.
extern "C" void __wrap_panic_soc_fill_info(void* frame, panic_info_t* info) {
  __real_panic_soc_fill_info(frame, info);
  keepCrash(frame, info);
}

static String hex8(uint32_t v) {
  char b[9];
  snprintf(b, sizeof(b), "%08lx", (unsigned long)v);
  return b;
}

// Logs what the last crash left, keeps it in NVS (so it outlasts going back to the stock firmware, and a power cut),
// and works out the short version the set-up screen shows.
static void readCrash(esp_reset_reason_t r) {
  bool crashed = r == ESP_RST_PANIC || r == ESP_RST_INT_WDT || r == ESP_RST_TASK_WDT || r == ESP_RST_WDT;
  if (crashed && rec.magic == CRASH_MAGIC) {
    rec.reason[sizeof(rec.reason) - 1] = 0;
    rec.task[sizeof(rec.task) - 1] = 0;
    if (rec.calls > CRASH_CALLS) rec.calls = 0;
    String what = rec.reason, task = rec.task, at;
    // A task watchdog aborts without saying anything: the reset reason does.
    if (!what.length()) what = reasonText;
    if (rec.abort) {
      const char* x = strstr(rec.reason, "0x");
      uint32_t a = x ? strtoul(x + 2, nullptr, 16) : 0;
      const char* over = strstr(rec.reason, "overflow in task ");
      if (over) {
        what = "Stack overflow";
        task = String(over + 17);
        int end = task.indexOf(' ');
        if (end > 0) task = task.substring(0, end);
      } else if (!strncmp(rec.reason, "assert", 6)) {
        what = "Assert failed";
      } else if (!strncmp(rec.reason, "abort()", 7)) {
        what = "abort()";
      }
      at = a ? hex8(a) : String("-");
    } else {
      at = hex8(rec.pc) + " " + hex8(rec.ra);
    }
    String calls;
    uint8_t shown = 0;
    for (uint32_t i = 0; i < rec.calls; i++) {
      uint32_t w = rec.call[i];
      if ((w & 1) || w == rec.pc || w == rec.ra) continue;
      calls += " " + hex8(w);
      if (shown < 2) crashNow.stack += (shown++ ? " " : "") + hex8(w);
    }
    crashNow.what = what;
    crashNow.task = task.length() ? task : String("?");
    crashNow.at = at;
    logf("crash: %s, in task %s", rec.reason, crashNow.task.c_str());
    logf("crash: pc %08lx ra %08lx sp %08lx cause %lu tval %08lx", (unsigned long)rec.pc, (unsigned long)rec.ra,
         (unsigned long)rec.sp, (unsigned long)rec.cause, (unsigned long)rec.tval);
    for (size_t i = 0; i < calls.length(); i += 12 * 9) logf("crash: stack%s", calls.substring(i, i + 12 * 9).c_str());
    String saved = String(build) + " " + rec.reason + " | " + crashNow.task + " | " + hex8(rec.pc) + " " + hex8(rec.ra) + " |" + calls;
    nvs_handle_t h;
    if (nvs_open(BOOT_NS, NVS_READWRITE, &h) == ESP_OK) {
      nvs_set_str(h, "crash", saved.substring(0, 400).c_str());
      nvs_commit(h);
      nvs_close(h);
    }
  }
  rec.magic = 0;
  nvs_handle_t h;
  if (nvs_open(BOOT_NS, NVS_READONLY, &h) == ESP_OK) {
    char saved[401];
    size_t len = sizeof(saved);
    if (nvs_get_str(h, "crash", saved, &len) == ESP_OK) crashSaved = saved;
    nvs_close(h);
  }
}

const plat::Crash& plat::crash() { return crashNow; }

static bool keptBuild() {
  nvs_handle_t h;
  if (nvs_open(BOOT_NS, NVS_READONLY, &h) != ESP_OK) return false;
  char kept[17] = "";
  size_t len = sizeof(kept);
  bool same = nvs_get_str(h, "kept", kept, &len) == ESP_OK && !strcmp(kept, build);
  nvs_close(h);
  return same;
}

// How many times this build has started without being kept (the count starts again for each new build: the boot loader
// can take one back without this firmware ever running again to clear it). 0 if it couldn't be kept count of.
static uint8_t countStart() {
  nvs_handle_t h;
  if (nvs_open(BOOT_NS, NVS_READWRITE, &h) != ESP_OK) return 0;
  char counting[17] = "";
  size_t len = sizeof(counting);
  uint8_t starts = 0;
  if (nvs_get_str(h, "counting", counting, &len) == ESP_OK && !strcmp(counting, build)) nvs_get_u8(h, "starts", &starts);
  if (starts < 255) starts++;
  bool ok = nvs_set_str(h, "counting", build) == ESP_OK && nvs_set_u8(h, "starts", starts) == ESP_OK && nvs_commit(h) == ESP_OK;
  nvs_close(h);
  return ok ? starts : 0;
}

static bool keepBuild() {
  nvs_handle_t h;
  if (nvs_open(BOOT_NS, NVS_READWRITE, &h) != ESP_OK) return false;
  bool ok = nvs_set_str(h, "kept", build) == ESP_OK && nvs_set_u8(h, "starts", 0) == ESP_OK && nvs_commit(h) == ESP_OK;
  nvs_close(h);
  return ok;
}

// Back to the firmware in the other app slot, if there's a whole one there.
static void goBack(const char* why) {
  if (bootloaderTrial) esp_ota_mark_app_invalid_rollback_and_reboot();
  const esp_partition_t* other = esp_ota_get_next_update_partition(nullptr);
  if (other && esp_ota_set_boot_partition(other) == ESP_OK) {
    nvs_handle_t h;
    if (nvs_open(BOOT_NS, NVS_READWRITE, &h) == ESP_OK) {
      nvs_set_u8(h, "starts", 0);
      nvs_commit(h);
      nvs_close(h);
    }
    logf("boot: %s, going back to the firmware in %s", why, other->label);
    delay(100);
    esp_restart();
  }
  logf("boot: %s, but there's no firmware to go back to: keeping this one", why);
  trial = false;
  keepBuild();
}
#endif

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
#if defined(RH_BOARD_SDC2)
  if (trial) goBack("not reached in 10 minutes");
#else
  if (trial) esp_ota_mark_app_invalid_rollback_and_reboot();
#endif
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
#if defined(RH_BOARD_SDC2)
  esp_app_get_elf_sha256(build, sizeof(build));
  readCrash(r);
  bootloaderTrial = running && esp_ota_get_state_partition(running, &state) == ESP_OK && state == ESP_OTA_IMG_PENDING_VERIFY;
  bool newBuild = bootloaderTrial || !keptBuild();
  if (newBuild) {
    uint8_t starts = countStart();
    logf("boot: build %s not kept yet, start %u", build, starts);
    // Without a count (NVS full, say) nothing would take a broken build back, and settings couldn't be kept either.
    if (!starts || starts >= TRIAL_STARTS) {
      goBack(starts ? "started four times without being kept" : "can't count its starts");
      newBuild = false;  // still here: there was nothing to go back to, so this one is kept
    }
  }
  if (newBuild) {
#else
  if (running && esp_ota_get_state_partition(running, &state) == ESP_OK && state == ESP_OTA_IMG_PENDING_VERIFY) {
#endif
    trial = true;
    esp_timer_create_args_t args = {};
    args.callback = giveUp;
    args.name = "trial";
#if defined(RH_BOARD_SDC2)
    if (esp_timer_create(&args, &guard) != ESP_OK || esp_timer_start_once(guard, TRIAL_US) != ESP_OK) goBack("can't time its trial");
    // Its own trial is armed: the boot loader's ends here, so a crash restarts this firmware (counted above, and logged)
    // rather than going straight back with no trace of why.
    if (trial && bootloaderTrial && esp_ota_mark_app_valid_cancel_rollback() == ESP_OK) bootloaderTrial = false;
#else
    if (esp_timer_create(&args, &guard) == ESP_OK) esp_timer_start_once(guard, TRIAL_US);
#endif
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
#if defined(RH_BOARD_SDC2)
  // Unless it's on record as kept, it would be taken back after four starts: the trial (and its timer) carries on.
  if (!keepBuild()) {
    logf("boot: couldn't record this firmware as kept");
    return;
  }
#endif
  trial = false;
  if (guard) esp_timer_stop(guard);
  esp_err_t e = esp_ota_mark_app_valid_cancel_rollback();
  logf("boot: new firmware works, keeping it (%s)", e == ESP_OK ? "ok" : esp_err_to_name(e));
}

bool plat::onTrial() { return trial; }
#if defined(RH_BOARD_SDC2)
const char* plat::chip() { return "esp32c2"; }
#else
const char* plat::chip() { return "esp32"; }
#endif
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
#if defined(RH_BOARD_SDC2)
  if (crashSaved.length()) s["crash"] = crashSaved;
#endif
}

#endif
