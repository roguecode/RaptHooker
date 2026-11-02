#include "fetch.h"

#include "platform.h"
#if defined(ESP8266)
#include <ESP8266HTTPClient.h>
#else
#include <HTTPClient.h>
#endif

#include "app.h"
#include "display.h"
#include "log.h"
#include "net.h"
#include "store.h"
#include "version.h"

#if defined(ESP8266)
static const size_t MAX_PICTURE = 64 * 1024;
static const size_t HEAP_SPARE = 6 * 1024;
#else
static const size_t MAX_PICTURE = 160 * 1024;
static const size_t HEAP_SPARE = 24 * 1024;
#endif

static String screenId, lastError, lastBrief;
static bool paused = false, pictureShown = false;
static uint32_t nextAt = 0, goodAt = 0, failed = 0, lastBytes = 0, refresh = 0, drawn = 0, ranAt = 0;

void fetch::begin(const String& id) {
  screenId = id;
  goodAt = millis();
}

// Several things can ask for a picture at once (a settings change and the screen coming back to it): one fetch
// answers them all.
void fetch::soon() {
  if (ranAt && !failed && millis() - ranAt < 3000) return;
  nextAt = millis();
}
// The screen needs a picture drawn, so one fetched moments ago doesn't count. A failing hub isn't asked any sooner
// than the back-off allows.
void fetch::now() {
  if (!failed) nextAt = millis();
}
void fetch::pause(bool p) { paused = p; }
bool fetch::shown() { return pictureShown; }
uint32_t fetch::sinceGood() { return millis() - goodAt; }
uint32_t fetch::failures() { return failed; }
String fetch::error() { return lastError; }
String fetch::brief() { return lastBrief; }
uint32_t fetch::bytes() { return lastBytes; }
uint32_t fetch::interval() { return refresh ? refresh : store::settings().interval; }
uint32_t fetch::draws() { return drawn; }

void fetch::forget() {
  pictureShown = false;
  failed = 0;
  lastError = "";
  lastBrief = "";
  refresh = 0;
  goodAt = millis();
  nextAt = millis();
}

// `why` is for the log and RaptHooker; `brief` fits on the screen.
static void fail(const String& why, const char* brief) {
  failed++;
  // The same failure every minute for hours would push everything else out of the log.
  if (failed <= 3 || failed % 30 == 0 || why != lastError) logf("fetch: %s (%u in a row)", why.c_str(), failed);
  lastError = why;
  lastBrief = brief;
  // Try again soon at first, then back off to the usual interval.
  uint32_t wait = min<uint32_t>(10u << min<uint32_t>(failed - 1, 3u), 60u);
  nextAt = millis() + min(wait, fetch::interval()) * 1000;
}

static void run() {
  Settings& c = store::settings();
  WiFiClient client;
  HTTPClient http;
  http.setTimeout(15000);
  http.useHTTP10(true);
  http.setReuse(false);
  http.setUserAgent("RaptHooker-Screen/" FW_VERSION);
  if (!http.begin(client, c.imageUrl)) {
    fail("bad picture address", "bad picture address");
    return;
  }
  char status[96];
  snprintf(status, sizeof(status), "rssi=%d;up=%lu;heap=%u;fail=%u", WiFi.RSSI(), millis() / 1000,
           ESP.getFreeHeap(), failed);
  http.addHeader("X-Screen-Id", screenId);
  http.addHeader("X-Screen-Firmware", RH_MODEL "/" FW_VERSION);
  http.addHeader("X-Screen-Status", status);
  const char* keep[] = {"X-Refresh"};
  http.collectHeaders(keep, 1);
  uint32_t started = millis();
  int code = http.GET();
  uint32_t answered = millis();
  if (code <= 0) {
    fail("can't reach the hub (" + HTTPClient::errorToString(code) + ")", "can't reach the hub");
    http.end();
    return;
  }
  if (code != 200) {
    fail(String("the hub said ") + code, "the hub had a problem");
    http.end();
    return;
  }
  long r = http.header("X-Refresh").toInt();
  refresh = r > 0 ? constrain(r, 5L, 86400L) : 0;
  int len = http.getSize();
  if (len <= 0 || (size_t)len > MAX_PICTURE) {
    fail(len <= 0 ? "no picture size" : "picture too big", "bad picture");
    http.end();
    return;
  }
  if ((size_t)len + HEAP_SPARE > plat::maxBlock()) {
    fail(String("not enough memory for ") + (len / 1024) + " KB", "picture too big");
    http.end();
    return;
  }
  uint8_t* buf = (uint8_t*)malloc(len);
  if (!buf) {
    fail("out of memory", "out of memory");
    http.end();
    return;
  }
  WiFiClient* stream = http.getStreamPtr();
#if defined(ESP32)
  stream->setTimeout(10);  // the ESP32's WiFiClient takes seconds
#else
  stream->setTimeout(10000);
#endif
  size_t got = stream->readBytes(buf, len);
  uint32_t read = millis();
  http.end();
  if (got != (size_t)len) {
    free(buf);
    fail(String("picture cut short (") + got + " of " + len + " bytes)", "download failed");
    return;
  }
  String err;
  uint32_t t = millis();
  bool ok = display::drawJpeg(buf, len, err);
  free(buf);
  if (!ok) {
    fail(err, "bad picture");
    return;
  }
  if (failed) logf("fetch: back after %u failures", failed);
  failed = 0;
  lastError = "";
  lastBrief = "";
  lastBytes = len;
  goodAt = millis();
  pictureShown = true;
  drawn++;
  nextAt = millis() + fetch::interval() * 1000;
  logf("fetch: %d bytes, answer %lu ms, body %lu ms, drawn in %lu ms", len, (unsigned long)(answered - started),
       (unsigned long)(read - answered), (unsigned long)(millis() - t));
}

void fetch::loop() {
  if (paused || app::screenBusy() || !display::ready() || !net::online() || net::state() == net::State::Setup) return;
  if (!store::settings().imageUrl.length()) return;
  if ((int32_t)(millis() - nextAt) < 0) return;
  run();
  ranAt = millis();
}
