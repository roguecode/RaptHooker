#include <ArduinoJson.h>
#include <Crypto.h>
#include <ESP8266WebServer.h>
#include <ESP8266WiFi.h>
#include <StreamString.h>
#include <Updater.h>

#include "app.h"
#include "display.h"
#include "fetch.h"
#include "image.h"
#include "log.h"
#include "net.h"
#include "store.h"
#include "version.h"

static ESP8266WebServer server(80);

// Every build carries this, and an update has to as well (unless forced), so RaptHooker can't put the
// wrong firmware on a screen by mistake.
static const char MARKER_P[] PROGMEM = "RHSCREEN-FW:" RH_MODEL ":";
static char marker[48];
static uint8_t markerLen = 0;
static uint8_t failure[48];

// force=1 takes firmware without the marker (the stock firmware, to go back to it); it still has to be a
// complete, well-formed image. force=2 skips the image checks too, in case they ever turn out wrong.
struct Ota {
  bool active = false, ended = false, found = false;
  uint8_t force = 0;
  uint8_t match = 0;
  int shown = -1;
  size_t size = 0, received = 0;
  String error;
};
static Ota ota;
static ImageCheck check;
static bool installed = false;  // an update is staged: nothing more until the restart

static Settings pending;
static bool trialPending = false, trialSaved = false;
static int trialChannel = 0;
static uint32_t trialStartAt = 0;

static bool authorized() {
  const String& t = store::settings().token;
  if (!t.length()) return true;  // not set up yet: whoever is on its hotspot may set it up
  String h = server.header("Authorization");
  if (h.length() != t.length() + 7 || !h.startsWith("Bearer ")) return false;
  uint8_t diff = 0;
  for (size_t i = 0; i < t.length(); i++) diff |= h[i + 7] ^ t[i];
  return diff == 0;
}

static void sendJson(int code, const JsonDocument& doc) {
  String s;
  serializeJson(doc, s);
  server.send(code, "application/json", s);
}

static void sendError(int code, const String& msg) {
  JsonDocument d;
  d["ok"] = false;
  d["error"] = msg;
  sendJson(code, d);
}

static void sendOk() {
  JsonDocument d;
  d["ok"] = true;
  sendJson(200, d);
}

static bool requireAuth() {
  if (authorized()) return true;
  sendError(401, "not allowed");
  return false;
}

static bool readBody(JsonDocument& doc) {
  if (deserializeJson(doc, server.arg("plain")) || !doc.is<JsonObject>()) {
    sendError(400, "bad JSON");
    return false;
  }
  return true;
}

static void handleInfo() {
  Settings& c = store::settings();
  JsonDocument d;
  d["firmware"] = FW_NAME;
  d["version"] = FW_VERSION;
  d["api"] = FW_API;
  d["model"] = RH_MODEL;
  d["id"] = app::id;
  d["mac"] = app::mac;
  d["hostname"] = net::hostname();
  d["name"] = c.name;
  d["hub"] = c.hub;
  d["claimed"] = c.token.length() > 0;
  d["state"] = net::stateName();
  d["safeMode"] = app::safeMode;
  d["updating"] = ota.active;
  // Proof that this screen has the key, without sending it: an HMAC of the hub's challenge (with this screen's id,
  // so the screen can't be used to sign anything else). The hub sends the key only to an address that proves it.
  String challenge = server.arg("challenge");
  if (c.token.length() && challenge.length() >= 16 && challenge.length() <= 64) {
    String message = String("rhscreen-proof:") + app::id + ":" + challenge;
    d["proof"] = experimental::crypto::SHA256::hmac(message, c.token.c_str(), c.token.length(), 32);
  }
  // What this firmware can do, for RaptHooker to check before using something newer than API level 1 had.
  JsonArray f = d["features"].to<JsonArray>();
  for (const char* name : {"ota", "setup", "settings", "scan", "log", "identify", "refresh", "reboot", "reset", "adopt", "phy", "proof"})
    f.add(name);
  JsonObject w = d["wifi"].to<JsonObject>();
  w["ssid"] = c.ssid;
  if (WiFi.status() == WL_CONNECTED) {
    w["ip"] = WiFi.localIP().toString();
    w["gateway"] = WiFi.gatewayIP().toString();
    w["rssi"] = WiFi.RSSI();
    w["bssid"] = WiFi.BSSIDstr();
  }
  w["channel"] = WiFi.channel();
  w["phy"] = net::phyName();
  w["hotspot"] = net::apName();
  w["hotspotOn"] = net::apActive();
  w["reason"] = net::reason();
  w["downMs"] = net::downFor();
  JsonObject im = d["image"].to<JsonObject>();
  im["url"] = c.imageUrl;
  im["interval"] = fetch::interval();
  im["shown"] = fetch::shown();
  im["ageMs"] = fetch::sinceGood();
  im["failures"] = fetch::failures();
  im["error"] = fetch::error();
  im["bytes"] = fetch::bytes();
  JsonObject ds = d["display"].to<JsonObject>();
  ds["width"] = 240;
  ds["height"] = 240;
  ds["format"] = "jpeg";
  ds["brightness"] = c.brightness;
  JsonObject su = d["setup"].to<JsonObject>();
  su["trial"] = net::trialName();
  su["error"] = net::trialError();
  if (net::trial() == net::Trial::Connected) su["ip"] = net::trialIp().toString();
  su["saved"] = trialSaved;
  JsonObject s = d["system"].to<JsonObject>();
  s["uptime"] = millis() / 1000;
  s["heap"] = ESP.getFreeHeap();
  s["maxBlock"] = ESP.getMaxFreeBlockSize();
  s["frag"] = ESP.getHeapFragmentation();
  s["resetReason"] = app::resetReason();
  s["flashSize"] = ESP.getFlashChipRealSize();
  s["flashId"] = ESP.getFlashChipId();
  s["sketchSize"] = ESP.getSketchSize();
  s["freeSketch"] = ESP.getFreeSketchSpace();
  s["sketchMd5"] = ESP.getSketchMD5();
  s["core"] = ESP.getCoreVersion();
  s["sdk"] = ESP.getSdkVersion();
  s["cpuMhz"] = ESP.getCpuFreqMHz();
  s["button"] = app::buttonDown();
  s["store"] = store::available();
  sendJson(200, d);
}

static void handleSetup() {
  if (!requireAuth()) return;
  JsonDocument b;
  if (!readBody(b)) return;
  if (net::state() != net::State::Setup) return sendError(409, "already set up");
  if (net::trial() == net::Trial::Testing || trialPending) return sendError(409, "already trying a network");
  Settings p;
  p.ssid = b["ssid"] | "";
  p.pass = b["password"] | "";
  p.token = b["token"] | "";
  p.hub = b["hub"] | "";
  p.name = b["name"] | "";
  p.imageUrl = b["imageUrl"] | "";
  p.interval = constrain((long)(b["interval"] | 60), 5L, 86400L);
  p.brightness = constrain((int)(b["brightness"] | 80), 1, 100);
  if (!p.ssid.length() || p.ssid.length() > 32 || p.pass.length() > 64) return sendError(400, "bad Wi-Fi details");
  if (p.token.length() < 16 || p.token.length() > 64) return sendError(400, "token missing");
  pending = p;
  trialSaved = false;
  trialPending = true;
  trialChannel = b["channel"] | 0;
  trialStartAt = millis() + 300;  // after this reply has gone, since moving the hotspot drops the client
  JsonDocument d;
  d["ok"] = true;
  d["trial"] = "testing";
  d["channel"] = trialChannel;
  sendJson(202, d);
}

static void handleSetupStatus() {
  JsonDocument d;
  d["trial"] = trialPending ? "testing" : net::trialName();
  d["error"] = net::trialError();
  if (net::trial() == net::Trial::Connected) d["ip"] = net::trialIp().toString();
  d["saved"] = trialSaved;
  d["channel"] = WiFi.channel();
  sendJson(200, d);
}

static void handleSetupFinish() {
  if (!requireAuth()) return;
  if (!trialSaved) return sendError(409, "not joined a network yet");
  sendOk();
  app::rebootIn(1000);
}

static void writeSettings(JsonDocument& d) {
  Settings& c = store::settings();
  d["ok"] = true;
  d["name"] = c.name;
  d["hub"] = c.hub;
  d["ssid"] = c.ssid;
  d["imageUrl"] = c.imageUrl;
  d["interval"] = c.interval;
  d["brightness"] = c.brightness;
  d["phy"] = c.phy;
  d["txPower"] = c.txPower;
}

static void handleGetSettings() {
  if (!requireAuth()) return;
  JsonDocument d;
  writeSettings(d);
  sendJson(200, d);
}

static void handleSettings() {
  if (!requireAuth()) return;
  JsonDocument b;
  if (!readBody(b)) return;
  Settings next = store::settings();
  bool network = false, picture = false;
  if (b["name"].is<const char*>()) next.name = b["name"].as<const char*>();
  if (b["hub"].is<const char*>()) next.hub = b["hub"].as<const char*>();
  if (b["imageUrl"].is<const char*>()) {
    String u = b["imageUrl"].as<const char*>();
    if (u.length() && !u.startsWith("http://")) return sendError(400, "picture address must be http://");
    picture |= u != next.imageUrl;
    next.imageUrl = u;
  }
  if (b["interval"].is<long>()) next.interval = constrain(b["interval"].as<long>(), 5L, 86400L);
  if (b["brightness"].is<int>()) next.brightness = constrain(b["brightness"].as<int>(), 1, 100);
  if (b["phy"].is<const char*>()) {
    String p = b["phy"].as<const char*>();
    if (p != "b" && p != "g" && p != "n") return sendError(400, "phy must be b, g or n");
    network |= p != next.phy;
    next.phy = p;
  }
  if (b["txPower"].is<int>()) {
    uint8_t t = constrain(b["txPower"].as<int>(), 0, 20);
    network |= t != next.txPower;
    next.txPower = t;
  }
  if (b["token"].is<const char*>()) {
    String t = b["token"].as<const char*>();
    if (t.length() < 16 || t.length() > 64) return sendError(400, "bad token");
    next.token = t;
  }
  if (b["ssid"].is<const char*>()) {
    String s = b["ssid"].as<const char*>();
    String p = b["password"] | "";
    if (!s.length() || s.length() > 32 || p.length() > 64) return sendError(400, "bad Wi-Fi details");
    network |= s != next.ssid || p != next.pass;
    next.ssid = s;
    next.pass = p;
  }
  store::settings() = next;
  if (!store::save()) return sendError(500, "couldn't save");
  JsonDocument d;
  writeSettings(d);
  d["reboot"] = network;
  sendJson(200, d);
  display::setBrightness(next.brightness);
  if (picture) fetch::forget();
  app::settingsChanged(network, picture);
}

static void handleReboot() {
  if (!requireAuth()) return;
  app::clearCrashes();
  sendOk();
  app::rebootIn(500);
}

static void handleReset() {
  if (!requireAuth()) return;
  store::reset();
  app::clearCrashes();
  sendOk();
  app::rebootIn(500);
}

static void handleIdentify() {
  if (!requireAuth()) return;
  app::identify();
  sendOk();
}

static String adoptCode;
static uint32_t adoptUntil = 0;
static uint8_t adoptTries = 0;
// Wrong codes, whichever code they were for: too many and nothing more is taken for a while, so the code can't be
// guessed by asking for new ones.
static uint8_t adoptFails = 0;
static uint32_t adoptLockedUntil = 0;
static const uint8_t ADOPT_MAX_FAILS = 10;
static const uint32_t ADOPT_LOCK_MS = 15 * 60 * 1000;

// A hub without this screen's key (RaptHooker reinstalled, or another hub) takes it over with the code the screen
// shows, which proves someone is standing next to it. Without a code in the body, a code is shown (the same one
// while it's still up).
static void handleAdopt() {
  JsonDocument b;
  String body = server.arg("plain");
  if (body.length() && (deserializeJson(b, body) || !b.is<JsonObject>())) return sendError(400, "bad JSON");
  String code = b["code"] | "";
  uint32_t now = millis();
  if (adoptLockedUntil && (int32_t)(adoptLockedUntil - now) > 0) return sendError(429, "too many wrong codes: try again later");
  if (adoptLockedUntil) {
    adoptLockedUntil = 0;
    adoptFails = 0;
  }
  bool showing = adoptCode.length() && (int32_t)(adoptUntil - now) > 0;
  if (!code.length()) {
    if (!showing) {
      char c[7];
      snprintf(c, sizeof(c), "%06lu", (unsigned long)(ESP.random() % 1000000));
      adoptCode = c;
      adoptUntil = now + 120000;
      adoptTries = 0;
      app::showPairing(adoptCode, 120000);
      logf("adopt: showing a pairing code");
    }
    JsonDocument d;
    d["ok"] = true;
    d["expiresIn"] = (adoptUntil - now) / 1000;
    return sendJson(202, d);
  }
  if (!showing) return sendError(409, "no pairing code is showing");
  if (code != adoptCode) {
    ++adoptFails;
    if (++adoptTries >= 5 || adoptFails >= ADOPT_MAX_FAILS) {
      adoptCode = "";
      app::endPairing();
    }
    if (adoptFails >= ADOPT_MAX_FAILS) {
      adoptLockedUntil = now + ADOPT_LOCK_MS;
      logf("adopt: too many wrong codes, locked for 15 min");
    }
    return sendError(403, "wrong code");
  }
  String token = b["token"] | "";
  if (token.length() < 16 || token.length() > 64) return sendError(400, "token missing");
  String url = b["imageUrl"] | "";
  if (url.length() && !url.startsWith("http://")) return sendError(400, "picture address must be http://");
  Settings& c = store::settings();
  c.token = token;
  if (b["hub"].is<const char*>()) c.hub = b["hub"].as<const char*>();
  if (b["name"].is<const char*>()) c.name = b["name"].as<const char*>();
  bool picture = b["imageUrl"].is<const char*>() && url != c.imageUrl;
  if (b["imageUrl"].is<const char*>()) c.imageUrl = url;
  adoptCode = "";
  app::endPairing();
  if (!store::save()) return sendError(500, "couldn't save");
  logf("adopt: now with hub %s", c.hub.c_str());
  sendOk();
  if (picture) fetch::forget();
}

static void handleRefresh() {
  if (!requireAuth()) return;
  fetch::soon();
  sendOk();
}

static void handleLog() {
  if (!requireAuth()) return;
  StreamString s;
  logWrite(s);
  server.send(200, "text/plain", (const String&)s);
}

static void handleScan() {
  if (!requireAuth()) return;
  int n = WiFi.scanNetworks(false, false);
  JsonDocument d;
  JsonArray a = d["networks"].to<JsonArray>();
  for (int i = 0; i < n; i++) {
    JsonObject o = a.add<JsonObject>();
    o["ssid"] = WiFi.SSID(i);
    o["rssi"] = WiFi.RSSI(i);
    o["channel"] = WiFi.channel(i);
    o["bssid"] = WiFi.BSSIDstr(i);
    o["open"] = WiFi.encryptionType(i) == ENC_TYPE_NONE;
  }
  WiFi.scanDelete();
  sendJson(200, d);
}

static void handleRoot() {
  String h = F("<!doctype html><meta name=viewport content='width=device-width'><title>RaptHooker screen</title>"
               "<body style='font:16px system-ui;margin:2em;background:#111;color:#eee'><h1>RaptHooker screen</h1><p>");
  h += app::mac;
  h += F("</p><p>Set it up and change it from RaptHooker, under <b>Screens</b>.</p><p><a style='color:#a78bfa' "
         "href='/api/info'>Details</a></p>");
  server.send(200, "text/html", h);
}

static void otaFail(const String& why) {
  if (!ota.error.length()) ota.error = why;
  logf("ota: %s", ota.error.c_str());
}

// Drops an update without installing it. end() installs a complete update whose MD5 matches, and there's
// no other way to clear one, so give it an MD5 that can't match first.
static void otaReset() {
  if (Update.isRunning()) {
    Update.setMD5("00000000000000000000000000000000");
    Update.end();
    if (Update.isRunning()) Update.end();
  }
  ota.active = false;
  fetch::pause(false);
}

static void scanMarker(const uint8_t* p, size_t n) {
  for (size_t i = 0; i < n && !ota.found; i++) {
    while (ota.match && p[i] != (uint8_t)marker[ota.match]) ota.match = failure[ota.match - 1];
    if (p[i] == (uint8_t)marker[ota.match]) ota.match++;
    if (ota.match == markerLen) ota.found = true;
  }
}

static void handleUpload() {
  HTTPUpload& up = server.upload();
  if (up.status == UPLOAD_FILE_START) {
    ota = Ota();
    if (installed) return otaFail("already updated, restarting");
    if (!authorized()) return otaFail("not allowed");
    ota.size = server.arg("size").toInt();
    ota.force = server.arg("force").toInt();
    String md5 = server.arg("md5");
    if (!ota.size) return otaFail("size missing");
    if (md5.length() != 32) return otaFail("md5 missing");
    if (ota.size > ESP.getFreeSketchSpace()) return otaFail(String("too big: ") + ota.size + " > " + ESP.getFreeSketchSpace());
    fetch::pause(true);
    logf("ota: start %u bytes%s", ota.size, ota.force ? " (forced)" : "");
    if (!Update.begin(ota.size)) {
      otaFail(Update.getErrorString());
      return otaReset();
    }
    Update.setMD5(md5.c_str());
    check.begin(ota.size);
    ota.active = true;
    display::showProgress("Updating", "Don't unplug the screen", 0);
  } else if (up.status == UPLOAD_FILE_WRITE) {
    if (!ota.active || ota.error.length()) return;
    if (ota.received == 0 && up.currentSize && up.buf[0] != 0xE9) {
      otaFail("not ESP8266 firmware");
      return otaReset();
    }
    scanMarker(up.buf, up.currentSize);
    check.add(up.buf, up.currentSize);
    if (Update.write(up.buf, up.currentSize) != up.currentSize) {
      otaFail(Update.getErrorString());
      return otaReset();
    }
    ota.received += up.currentSize;
    int pct = ota.received * 100 / ota.size;
    if (pct / 5 != ota.shown / 5) {
      ota.shown = pct;
      display::showProgress("Updating", "Don't unplug the screen", pct);
    }
  } else if (up.status == UPLOAD_FILE_END) {
    // Only noted here: the request may still fail after the file, and installing writes the boot loader's
    // copy command, which can't be taken back. handleUploadDone installs once the request is complete.
    if (ota.active && !ota.error.length()) ota.ended = true;
  } else if (up.status == UPLOAD_FILE_ABORTED) {
    otaFail("upload cut short");
    otaReset();
  }
}

static bool install() {
  String why;
  if (!ota.active || !ota.ended || ota.error.length()) return false;
  if (ota.received != ota.size) {
    otaFail(String("got ") + ota.received + " of " + ota.size + " bytes");
    return false;
  }
  if (ota.force < 2 && !check.finish(why)) {
    otaFail("bad image: " + why);
    return false;
  }
  if (!ota.force && !ota.found) {
    otaFail("not RaptHooker firmware for this screen");
    return false;
  }
  if (!ota.force && !check.hasCrc()) {
    otaFail("image has no CRC");
    return false;
  }
  if (!Update.end()) {
    otaFail(Update.getErrorString());
    return false;
  }
  return true;
}

static void handleUploadDone() {
  if (install()) {
    installed = true;
    ota.active = false;
    logf("ota: installed %u bytes, restarting", ota.received);
    // Other firmware (the screen's original, put back) has no use for RaptHooker's settings, and RaptHooker put on
    // again later should start afresh rather than join a network with a key no hub has any more.
    if (!ota.found) store::wipe();
    app::clearCrashes();
    display::showProgress("Restarting", "", 100);
    sendOk();
    app::rebootIn(500);
    return;
  }
  otaReset();
  sendError(ota.error == "not allowed" ? 401 : 400, ota.error.length() ? ota.error : String("no firmware sent"));
  if (!installed) app::settingsChanged(false, true);  // put the usual screen back
}

static void handleNotFound() {
  if (server.method() == HTTP_OPTIONS) {
    server.sendHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    server.send(204);
    return;
  }
  sendError(404, "not found");
}

void web::begin() {
  strncpy_P(marker, MARKER_P, sizeof(marker) - 1);
  markerLen = strlen(marker);
  failure[0] = 0;
  for (uint8_t i = 1, k = 0; i < markerLen; i++) {
    while (k && marker[i] != marker[k]) k = failure[k - 1];
    if (marker[i] == marker[k]) k++;
    failure[i] = k;
  }
  server.collectHeaders("Authorization");
  server.enableCORS(true);
  server.on("/", HTTP_GET, handleRoot);
  server.on("/api/info", HTTP_GET, handleInfo);
  server.on("/api/setup", HTTP_POST, handleSetup);
  server.on("/api/setup", HTTP_GET, handleSetupStatus);
  server.on("/api/setup/finish", HTTP_POST, handleSetupFinish);
  server.on("/api/settings", HTTP_GET, handleGetSettings);
  server.on("/api/settings", HTTP_POST, handleSettings);
  server.on("/api/ota", HTTP_POST, handleUploadDone, handleUpload);
  server.on("/api/reboot", HTTP_POST, handleReboot);
  server.on("/api/reset", HTTP_POST, handleReset);
  server.on("/api/identify", HTTP_POST, handleIdentify);
  server.on("/api/adopt", HTTP_POST, handleAdopt);
  server.on("/api/refresh", HTTP_POST, handleRefresh);
  server.on("/api/log", HTTP_GET, handleLog);
  server.on("/api/scan", HTTP_GET, handleScan);
  server.onNotFound(handleNotFound);
  server.begin();
  logf("web: listening");
}

void web::loop() {
  server.handleClient();
  if (trialPending && (int32_t)(millis() - trialStartAt) >= 0) {
    trialPending = false;
    net::startTrial(pending.ssid, pending.pass, trialChannel);
  }
  if (!trialSaved && net::trial() == net::Trial::Connected) {
    pending.phy = net::phyName();
    store::settings() = pending;
    trialSaved = store::save();
    // RaptHooker normally says when it's done; if it never does, carry on as set up anyway.
    if (trialSaved) app::rebootIn(3 * 60 * 1000);
  }
}

bool web::updating() { return ota.active; }
