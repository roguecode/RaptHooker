#include <Arduino.h>
#include <ESP8266WiFi.h>

#include "app.h"
#include "display.h"
#include "fetch.h"
#include "hw.h"
#include "log.h"
#include "net.h"
#include "store.h"
#include "version.h"

// Firmware for a small Wi-Fi screen that shows a picture from RaptHooker. RaptHooker sets it up over the
// screen's hotspot, then manages it over the network: see /api/info and web.cpp.

static const char BUILD_P[] PROGMEM = "RHSCREEN-FW:" RH_MODEL ":" FW_VERSION;

static const uint32_t RTC_BLOCK = 64;  // the first 128 bytes of RTC memory belong to the OTA boot loader
static const uint32_t RTC_MAGIC = 0x52484332;
static const uint8_t CRASHES_FOR_SAFE_MODE = 3;

bool app::safeMode = false;
String app::id, app::mac;

static uint32_t rebootAt = 0, identifyUntil = 0, infoUntil = 0, lastUi = 0, pairingUntil = 0;
static bool identifying = false, pictureOnScreen = false, stable = false, pairing = false;
static uint32_t drawsSeen = 0;
static String drawnInfo, drawnBanner, resetReasonText, pairingCode;
static bool buttonArmed = false, buttonWasDown = false;
static uint32_t buttonAt = 0;

struct Rtc {
  uint32_t magic;
  uint32_t crashes;
};

void app::rebootIn(uint32_t ms) { rebootAt = millis() + ms; }
void app::identify() { identifyUntil = millis() + 10000; }
void app::showPairing(const String& code, uint32_t ms) {
  pairingCode = code;
  pairingUntil = millis() + ms;
  pairing = false;
}
void app::endPairing() { pairingUntil = millis(); }

// While the screen shows something of its own (a pairing code, "this screen"), a new picture mustn't cover it.
bool app::screenBusy() {
  uint32_t now = millis();
  return (int32_t)(pairingUntil - now) > 0 || (int32_t)(identifyUntil - now) > 0;
}
bool app::buttonDown() { return digitalRead(PIN_BUTTON) == LOW; }
const char* app::resetReason() { return resetReasonText.c_str(); }

void app::settingsChanged(bool network, bool picture) {
  if (network) {
    rebootIn(1000);
    return;
  }
  drawnInfo = "";  // the details show the name and Wi-Fi: draw them again if they're up
  if (picture) pictureOnScreen = false;
}

static void countCrashes() {
  rst_info* ri = ESP.getResetInfoPtr();
  resetReasonText = ESP.getResetReason();
  Rtc r;
  ESP.rtcUserMemoryRead(RTC_BLOCK, (uint32_t*)&r, sizeof(r));
  if (r.magic != RTC_MAGIC) r = {RTC_MAGIC, 0};
  bool crashed = ri->reason == REASON_WDT_RST || ri->reason == REASON_EXCEPTION_RST || ri->reason == REASON_SOFT_WDT_RST;
  r.crashes = crashed ? r.crashes + 1 : 0;
  ESP.rtcUserMemoryWrite(RTC_BLOCK, (uint32_t*)&r, sizeof(r));
  app::safeMode = r.crashes >= CRASHES_FOR_SAFE_MODE;
  logf("boot: %s, %u crash(es) in a row%s", resetReasonText.c_str(), r.crashes, app::safeMode ? ", safe mode" : "");
}

static void markStable() {
  app::clearCrashes();
  stable = true;
}

void app::clearCrashes() {
  Rtc r = {RTC_MAGIC, 0};
  ESP.rtcUserMemoryWrite(RTC_BLOCK, (uint32_t*)&r, sizeof(r));
}

// A start counts as good once it has run past the point the fallback hotspot opens, with a way in over
// the network. Until then crashes add up, and three in a row start in safe mode.
static bool runningWell() {
  if (app::safeMode || millis() < 6 * 60 * 1000) return false;
  return net::online() || net::apActive();
}

static String duration(uint32_t ms) {
  uint32_t m = ms / 60000;
  if (m < 1) return String(ms / 1000) + "s";
  if (m < 60) return String(m) + "m";
  if (m < 48 * 60) return String(m / 60) + "h " + String(m % 60) + "m";
  return String(m / 1440) + "d " + String(m / 60 % 24) + "h";
}

static String hubOf(const String& url) {
  int start = url.indexOf("://");
  if (start < 0) return "-";
  start += 3;
  int end = url.indexOf('/', start);
  return url.substring(start, end < 0 ? url.length() : end);
}

static void showDetails() {
  Settings& c = store::settings();
  display::Line lines[6];
  size_t n = 0;
  String title, status;
  uint16_t color = display::VIOLET;
  if (net::state() == net::State::Setup) {
    title = "Set up";
    lines[n++] = {"Set up", "RaptHooker > Screens"};
    lines[n++] = {"Wi-Fi", net::apName()};
    lines[n++] = {"MAC", app::mac};
    lines[n++] = {"Firmware", FW_VERSION};
    switch (net::trial()) {
      case net::Trial::Idle: status = "Waiting for RaptHooker"; break;
      case net::Trial::Testing: status = "Joining Wi-Fi..."; color = display::AMBER; break;
      case net::Trial::Connected:
        status = "Joined: " + net::trialIp().toString();
        color = display::GREEN;
        break;
      default:
        status = "Couldn't join: " + net::trialError();
        color = display::RED;
    }
  } else {
    title = c.name.length() ? c.name : String("Screen");
    bool up = WiFi.status() == WL_CONNECTED;
    lines[n++] = {"Wi-Fi", c.ssid};
    lines[n++] = {"IP", up ? WiFi.localIP().toString() : String("-")};
    lines[n++] = {"MAC", app::mac};
    lines[n++] = {"Hub", c.imageUrl.length() ? hubOf(c.imageUrl) : String("-")};
    lines[n++] = {"Firmware", FW_VERSION};
    if (net::apActive()) lines[n++] = {"Hotspot", net::apName()};
    if (net::state() == net::State::Connecting) {
      bool stuck = net::downFor() > 20000 && net::reason().length();
      status = stuck ? "Can't join: " + net::reason() : "Joining " + c.ssid + "...";
      color = stuck ? display::RED : display::AMBER;
    } else if (net::state() == net::State::Offline) {
      status = "Reconnecting to " + c.ssid + "...";
      color = display::AMBER;
    } else if (!c.imageUrl.length()) {
      status = "Ready: pick a picture in RaptHooker";
      color = display::GREEN;
    } else if (fetch::failures()) {
      status = "Picture: " + fetch::brief();
      color = display::RED;
    } else {
      status = "Loading the picture...";
    }
  }
  String sig = title + status;
  for (size_t i = 0; i < n; i++) sig += lines[i].value;
  if (sig == drawnInfo) return;
  drawnInfo = sig;
  drawnBanner = "";
  pictureOnScreen = false;
  display::showInfo(title, lines, n, status, color);
}

static void showBanner() {
  String text;
  uint16_t color = display::AMBER;
  if (!net::online()) {
    uint32_t down = net::downFor();
    if (down > 10000) {
      text = down > 120000 && net::reason().length() ? "Wi-Fi: " + net::reason() + " (" + duration(down) + ")"
                                                    : "Wi-Fi lost, reconnecting...";
      color = down > 120000 ? display::RED : display::AMBER;
    }
  } else {
    uint32_t stale = max<uint32_t>(fetch::interval() * 3, 300) * 1000;
    if (fetch::failures() >= 3 || fetch::sinceGood() > stale) {
      String why = fetch::brief();
      if (why.length()) {
        why.setCharAt(0, toupper(why[0]));
        text = why + " (" + duration(fetch::sinceGood()) + ")";
      } else {
        text = "No new picture for " + duration(fetch::sinceGood());
      }
      color = display::RED;
    }
  }
  if (text == drawnBanner) return;
  if (!text.length()) {
    fetch::now();  // the picture under the old line comes back with the next one
  } else {
    display::showBanner(text, color);
  }
  drawnBanner = text;
}

static void ui() {
  uint32_t now = millis();
  if (now - lastUi < 500 || web::updating()) return;
  lastUi = now;
  if ((int32_t)(pairingUntil - now) > 0) {
    if (!pairing) display::showPairing(pairingCode);
    pairing = true;
    return;
  }
  if (pairing) {
    pairing = false;
    app::settingsChanged(false, true);
  }
  if ((int32_t)(identifyUntil - now) > 0) {
    if (!identifying) display::showIdentify(store::settings().name);
    identifying = true;
    return;
  }
  if (identifying) {
    identifying = false;
    app::settingsChanged(false, true);
  }
  bool want = net::state() != net::State::Setup && store::settings().imageUrl.length() && (int32_t)(infoUntil - now) <= 0;
  if (fetch::draws() != drawsSeen) {
    drawsSeen = fetch::draws();
    pictureOnScreen = true;
    drawnBanner = "";
    drawnInfo = "";  // if the details are wanted, the picture just covered them
  }
  // A picture is wanted and none is showing (just started, or something covered it): get one now, whenever the
  // last one was fetched.
  if (want && !pictureOnScreen) fetch::now();
  if (want && pictureOnScreen) {
    drawnInfo = "";
    showBanner();
  } else {
    showDetails();
  }
}

static void button() {
  bool down = app::buttonDown();
  uint32_t now = millis();
  if (!down) buttonArmed = true;
  if (!buttonArmed) return;
  if (down && !buttonWasDown) buttonAt = now;
  if (!down && buttonWasDown && now - buttonAt > 50 && now - buttonAt < 3000) {
    infoUntil = now + 30000;
    drawnInfo = "";
    logf("button: showing details");
  }
  buttonWasDown = down;
}

void setup() {
  Serial.begin(115200);
  Serial.println();
  char build[96];
  strncpy_P(build, BUILD_P, sizeof(build) - 1);
  build[sizeof(build) - 1] = 0;
  logf("%s", build);
  countCrashes();
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  uint8_t m[6];
  WiFi.macAddress(m);
  char buf[18];
  snprintf(buf, sizeof(buf), "%02x%02x%02x%02x%02x%02x", m[0], m[1], m[2], m[3], m[4], m[5]);
  app::id = buf;
  snprintf(buf, sizeof(buf), "%02X:%02X:%02X:%02X:%02X:%02X", m[0], m[1], m[2], m[3], m[4], m[5]);
  app::mac = buf;
  store::begin();
  // The network and the update endpoint come first, so even firmware that goes wrong later on can be
  // replaced over the network.
  net::begin();
  web::begin();
  fetch::begin(app::id);
  if (!app::safeMode) display::begin(store::settings().brightness);
}

void loop() {
  web::loop();
  net::loop();
  if (!app::safeMode) {
    fetch::loop();
    ui();
    button();
  }
  if (!stable && runningWell()) markStable();
  if (rebootAt && (int32_t)(millis() - rebootAt) >= 0) {
    logf("restarting");
    delay(100);
    ESP.restart();
  }
  delay(2);
}
