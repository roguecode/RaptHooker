#include "net.h"

#include "log.h"
#include "platform.h"
#include "store.h"
#include "version.h"

#if defined(ESP8266)
#include <ESP8266mDNS.h>
#else
#include <ESPmDNS.h>
#include <esp_wifi.h>
#endif

static const uint32_t FALLBACK_AFTER_MS = 5 * 60 * 1000;
static const uint32_t TRIAL_TIMEOUT_MS = 60 * 1000;

static net::State st = net::State::Setup;
static net::Trial tr = net::Trial::Idle;
static String ap, host, trialErr;
static IPAddress trialAddr;
static uint32_t downAt = 0, upAt = 0, trialAt = 0, apTriedAt = 0;
static int apChannel = 1;
static bool apOn = false, stationTrying = false, mdnsOn = false;

// Why the station last dropped, since when it's had a link (0: none), and how many times in a row that was for its
// password. On the ESP32 the Wi-Fi task sets these.
static volatile int lastReason = 0;
static volatile uint32_t associatedAt = 0, authFailures = 0;
// When the station last started trying (in the 802.11 mode it has now).
static uint32_t beganAt = 0;

#if defined(ESP8266)
static WiFiEventHandler onDisconnect, onConnect, onIp;
typedef WiFiPhyMode_t Phy;
static const Phy PHY_B = WIFI_PHY_MODE_11B, PHY_G = WIFI_PHY_MODE_11G, PHY_N = WIFI_PHY_MODE_11N;
static void applyPhy(Phy p) { WiFi.setPhyMode(p); }
static void beginStation(const String& ssid, const String& pass, int channel = 0) {
  beganAt = millis();
  WiFi.begin(ssid, pass, channel);
}
enum : int {
  R_AUTH_EXPIRE = WIFI_DISCONNECT_REASON_AUTH_EXPIRE,
  R_AUTH_FAIL = WIFI_DISCONNECT_REASON_AUTH_FAIL,
  R_4WAY = WIFI_DISCONNECT_REASON_4WAY_HANDSHAKE_TIMEOUT,
  R_HANDSHAKE = WIFI_DISCONNECT_REASON_HANDSHAKE_TIMEOUT,
  R_NO_AP = WIFI_DISCONNECT_REASON_NO_AP_FOUND,
  R_ASSOC_FAIL = WIFI_DISCONNECT_REASON_ASSOC_FAIL,
  R_BEACON = WIFI_DISCONNECT_REASON_BEACON_TIMEOUT,
};
#else
enum Phy : uint8_t { PHY_B, PHY_G, PHY_N };
static void applyPhy(Phy p) {
  uint8_t proto = WIFI_PROTOCOL_11B;
  if (p != PHY_B) proto |= WIFI_PROTOCOL_11G;
  if (p == PHY_N) proto |= WIFI_PROTOCOL_11N;
  esp_wifi_set_protocol(WIFI_IF_STA, proto);
}
enum : int {
  R_AUTH_EXPIRE = WIFI_REASON_AUTH_EXPIRE,
  R_AUTH_FAIL = WIFI_REASON_AUTH_FAIL,
  R_4WAY = WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT,
  R_HANDSHAKE = WIFI_REASON_HANDSHAKE_TIMEOUT,
  R_NO_AP = WIFI_REASON_NO_AP_FOUND,
  R_ASSOC_FAIL = WIFI_REASON_ASSOC_FAIL,
  R_BEACON = WIFI_REASON_BEACON_TIMEOUT,
};
// Set by the Wi-Fi task, logged by net::loop.
static volatile bool evLeft = false, evJoined = false, evGotIp = false;
static volatile uint8_t evChannel = 0;
static String txtHub, txtClaimed;

static void beginStation(const String& ssid, const String& pass, int channel = 0) {
  beganAt = millis();
  WiFi.begin(ssid.c_str(), pass.c_str(), channel);
}
#endif

static String hex3(const uint8_t* m, bool upper) {
  char b[7];
  snprintf(b, sizeof(b), upper ? "%02X%02X%02X" : "%02x%02x%02x", m[3], m[4], m[5]);
  return b;
}

// The ESP8266 starts in 802.11g, which routers that won't give it an address in n do (see swapPhyIfStuck); the
// ESP32 in b/g/n.
#if defined(ESP8266)
static const Phy PHY_DEFAULT = PHY_G;
#else
static const Phy PHY_DEFAULT = PHY_N;
#endif
static Phy phy = PHY_DEFAULT;
static String trialSsid, trialPass;
static int trialChannel = 0;

// When DHCP fails lwIP picks a 169.254.x.x address of its own. Nothing else on the network can use that,
// so it counts as no address at all.
static bool hasAddress() {
  if (WiFi.status() != WL_CONNECTED) return false;
  IPAddress ip = WiFi.localIP();
  return (uint32_t)ip != 0 && !(ip[0] == 169 && ip[1] == 254);
}

// Some routers (ASUS AX and AiMesh among them) let an ESP8266 join in 802.11n but never answer its DHCP
// requests, and a few want n. So when it joins but gets no address, it tries the other mode.
static void swapPhyIfStuck(uint32_t now, const String& ssid, const String& pass, int channel) {
  if (!associatedAt || hasAddress() || now - associatedAt < 20000) return;
  WiFi.disconnect();
  associatedAt = 0;
  phy = phy == PHY_G ? PHY_N : PHY_G;
  applyPhy(phy);
  logf("net: no address after 20 s, trying 802.11%s", net::phyName());
  beginStation(ssid, pass, channel);
}

// Some routers turn a station away before it joins (802.11n only, say): after 10 s of that it tries the other mode.
// The reason is forgotten, so the next refusal is logged in the new mode.
static void swapPhyIfRefused(uint32_t now, const String& ssid, const String& pass, int channel) {
  if (associatedAt || hasAddress() || lastReason != R_ASSOC_FAIL || now - beganAt < 10000) return;
  WiFi.disconnect();
  const char* was = net::phyName();
  phy = phy == PHY_G ? PHY_N : PHY_G;
  applyPhy(phy);
  lastReason = 0;
  logf("net: turned away in 802.11%s, trying 802.11%s", was, net::phyName());
  beginStation(ssid, pass, channel);
}

static const char* describe(int r) {
  switch (r) {
    case 0: return "";
    case R_NO_AP: return "network not found";
    case R_AUTH_EXPIRE:
    case R_AUTH_FAIL:
    case R_4WAY:
    case R_HANDSHAKE: return "wrong password";
    case R_ASSOC_FAIL: return "couldn't join";
    case R_BEACON: return "signal lost";
    default: return "disconnected";
  }
}

static bool passwordProblem(int r) { return !strcmp(describe(r), "wrong password"); }

static void startAp(int channel) {
  apTriedAt = millis();
  apChannel = channel > 0 && channel <= 13 ? channel : 1;
  apOn = WiFi.softAP(ap.c_str(), nullptr, apChannel, 0, 4);
  logf("net: hotspot %s on channel %d: %s", ap.c_str(), apChannel, apOn ? "on" : "failed");
}

static void startMdns() {
  if (mdnsOn) return;
  if (!MDNS.begin(host.c_str())) {
    logf("net: mDNS failed");
    return;
  }
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char id[13];
  snprintf(id, sizeof(id), "%02x%02x%02x%02x%02x%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
#if defined(ESP32)
  MDNS.addService("rhscreen", "tcp", 80);
  MDNS.addServiceTxt("rhscreen", "tcp", "id", String(id));
  MDNS.addServiceTxt("rhscreen", "tcp", "model", RH_MODEL);
  MDNS.addServiceTxt("rhscreen", "tcp", "fw", FW_VERSION);
  MDNS.addServiceTxt("rhscreen", "tcp", "api", String(FW_API));
  txtHub = txtClaimed = "-";  // published by net::loop
  mdnsOn = true;
  logf("net: mDNS %s.local", host.c_str());
}
#else
  MDNSResponder::hMDNSService s = MDNS.addService(nullptr, "rhscreen", "tcp", 80);
  MDNS.addServiceTxt(s, "id", id);
  MDNS.addServiceTxt(s, "model", RH_MODEL);
  MDNS.addServiceTxt(s, "fw", FW_VERSION);
  MDNS.addServiceTxt(s, "api", String(FW_API).c_str());
  MDNS.setDynamicServiceTxtCallback(s, [](const MDNSResponder::hMDNSService h) {
    Settings& c = store::settings();
    MDNS.addDynamicServiceTxt(h, "hub", c.hub.c_str());
    MDNS.addDynamicServiceTxt(h, "claimed", c.token.length() ? "1" : "0");
  });
  mdnsOn = true;
  logf("net: mDNS %s.local", host.c_str());
}
#endif

#if defined(ESP32)
// The ESP32's mDNS has no TXT callback: the fields that change (after set-up or adoption) are sent again.
static void publishTxt() {
  Settings& c = store::settings();
  String claimed = c.token.length() ? "1" : "0";
  if (c.hub == txtHub && claimed == txtClaimed) return;
  MDNS.addServiceTxt("rhscreen", "tcp", "hub", c.hub);
  MDNS.addServiceTxt("rhscreen", "tcp", "claimed", claimed);
  txtHub = c.hub;
  txtClaimed = claimed;
}

static void onWifiEvent(WiFiEvent_t e, WiFiEventInfo_t info) {
  switch (e) {
    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED: {
      int r = info.wifi_sta_disconnected.reason;
      if (r != lastReason) evLeft = true;
      lastReason = r;
      associatedAt = 0;
      if (passwordProblem(r)) authFailures = authFailures + 1;
      break;
    }
    case ARDUINO_EVENT_WIFI_STA_CONNECTED:
      associatedAt = millis();
      evChannel = info.wifi_sta_connected.channel;
      evJoined = true;
      break;
    case ARDUINO_EVENT_WIFI_STA_GOT_IP: evGotIp = true; break;
    default: break;
  }
}

static void logEvents() {
  if (evLeft) {
    evLeft = false;
    int r = lastReason;
    logf("net: station disconnected, reason %d (%s)", r, describe(r));
  }
  if (evJoined) {
    evJoined = false;
    logf("net: joined %s on channel %d, waiting for an address", WiFi.SSID().c_str(), evChannel);
  }
  if (evGotIp) {
    evGotIp = false;
    logf("net: address %s, gateway %s", WiFi.localIP().toString().c_str(), WiFi.gatewayIP().toString().c_str());
  }
}

// The ESP32's station stops trying after some failures (a network that isn't there, a wrong password): it's asked
// again every 30 s, as the ESP8266's keeps trying by itself.
static void retryStation(uint32_t now, const String& ssid, const String& pass) {
  if (!stationTrying || associatedAt || WiFi.status() == WL_CONNECTED || now - beganAt < 30000) return;
  beganAt = now;
  WiFi.disconnect();
  WiFi.begin(ssid.c_str(), pass.c_str());
}

#endif

void net::begin() {
  uint8_t mac[6];
  WiFi.macAddress(mac);
  ap = "RaptHooker-Screen-" + hex3(mac, true);
  host = "rh-screen-" + hex3(mac, false);
  WiFi.persistent(false);
#if defined(ESP32)
  WiFi.setHostname(host.c_str());  // before the station starts, or it isn't used
  // Every channel, then the strongest access point: the ESP32's default joins the first it hears, which on a mesh
  // network can be a far one.
  WiFi.setScanMethod(WIFI_ALL_CHANNEL_SCAN);
  WiFi.setSortMethod(WIFI_CONNECT_AP_BY_SIGNAL);
  WiFi.onEvent(onWifiEvent);
  WiFi.mode(WIFI_OFF);
#else
  WiFi.setAutoConnect(false);
  WiFi.mode(WIFI_OFF);
  WiFi.setSleepMode(WIFI_NONE_SLEEP);  // it's on USB power, and stays quick to answer
  onDisconnect = WiFi.onStationModeDisconnected([](const WiFiEventStationModeDisconnected& e) {
    if (e.reason != lastReason) logf("net: station disconnected, reason %d (%s)", e.reason, describe(e.reason));
    lastReason = e.reason;
    associatedAt = 0;
    if (passwordProblem(e.reason)) authFailures++;
  });
  onConnect = WiFi.onStationModeConnected([](const WiFiEventStationModeConnected& e) {
    associatedAt = millis();
    logf("net: joined %s on channel %d, waiting for an address", e.ssid.c_str(), e.channel);
  });
  onIp = WiFi.onStationModeGotIP([](const WiFiEventStationModeGotIP& e) {
    logf("net: address %s, gateway %s", e.ip.toString().c_str(), e.gw.toString().c_str());
  });
#endif
  Settings& c = store::settings();
  if (c.configured()) {
    WiFi.mode(WIFI_STA);
#if defined(ESP32)
    WiFi.setSleep(false);  // it's on USB power, and stays quick to answer
#else
    WiFi.hostname(host);
#endif
    WiFi.setAutoReconnect(true);
    phy = c.phy == "n" ? PHY_N : c.phy == "b" ? PHY_B : PHY_G;
    applyPhy(phy);
#if defined(ESP32)
    if (c.txPower) WiFi.setTxPower((wifi_power_t)(c.txPower * 4));
#else
    if (c.txPower) WiFi.setOutputPower(c.txPower);
#endif
    beginStation(c.ssid, c.pass);
    stationTrying = true;
    st = State::Connecting;
    downAt = millis();
    logf("net: joining %s", c.ssid.c_str());
  } else {
    WiFi.mode(WIFI_AP);
#if defined(ESP32)
    WiFi.setSleep(false);
#endif
    startAp(1);
    st = State::Setup;
  }
}

void net::startTrial(const String& ssid, const String& pass, int channel) {
  tr = Trial::Testing;
  trialErr = "";
  trialAddr = IPAddress();
  lastReason = 0;
  authFailures = 0;
  trialAt = millis();
  trialSsid = ssid;
  trialPass = pass;
  trialChannel = channel > 0 ? channel : 0;
  WiFi.mode(WIFI_AP_STA);
#if defined(ESP8266)
  WiFi.hostname(host);
#endif
  // The hotspot has to be on the network's channel once the station joins it. Moving it first means
  // RaptHooker's connection drops once, now, rather than at a moment it can't predict.
  if (channel > 0 && channel != WiFi.channel()) startAp(channel);
  phy = PHY_DEFAULT;
  applyPhy(phy);
  beginStation(ssid, pass, trialChannel);
  logf("net: trying %s (channel %d)", ssid.c_str(), channel);
}

static void endTrial(net::Trial result, const String& err) {
  tr = result;
  trialErr = err;
  if (result == net::Trial::Connected) {
    trialAddr = WiFi.localIP();
    logf("net: trial joined, %s", trialAddr.toString().c_str());
    startMdns();
  } else {
    logf("net: trial failed: %s", err.c_str());
    WiFi.disconnect();
    WiFi.mode(WIFI_AP);
  }
}

void net::loop() {
#if defined(ESP32)
  logEvents();
  static uint32_t txtAt = 0;
  if (mdnsOn && millis() - txtAt > 2000) {
    txtAt = millis();
    publishTxt();
  }
#else
  if (mdnsOn) MDNS.update();
#endif
  uint32_t now = millis();
  if (st == State::Setup) {
    // Without its hotspot an unset screen can't be reached at all, so keep trying to start it.
    if (!apOn && now - apTriedAt > 10000) startAp(apChannel);
    if (tr != Trial::Testing) return;
    wl_status_t s = WiFi.status();
    uint32_t t = now - trialAt;
    swapPhyIfStuck(now, trialSsid, trialPass, trialChannel);
    swapPhyIfRefused(now, trialSsid, trialPass, trialChannel);
#if defined(ESP8266)
    bool wrongPassword = s == WL_WRONG_PASSWORD || authFailures >= 2;
#else
    bool wrongPassword = authFailures >= 2;
    retryStation(now, trialSsid, trialPass);
#endif
    if (hasAddress()) endTrial(Trial::Connected, "");
    else if (wrongPassword && t > 8000) endTrial(Trial::Failed, "wrong password");
    else if (s == WL_NO_SSID_AVAIL && t > 15000) endTrial(Trial::Failed, "network not found");
    else if (t > TRIAL_TIMEOUT_MS) {
      endTrial(Trial::Failed, associatedAt ? "joined, but got no IP address (DHCP)" : lastReason ? describe(lastReason) : "timed out");
    }
    return;
  }

  bool up = hasAddress();
  Settings& c = store::settings();
  if (up && st != State::Online) {
    st = State::Online;
    upAt = now;
    lastReason = 0;
    logf("net: online %s, %d dBm, channel %d, 802.11%s", WiFi.localIP().toString().c_str(), WiFi.RSSI(),
         WiFi.channel(), phyName());
    if (c.phy != phyName()) {
      c.phy = phyName();
      store::save();
    }
    startMdns();
  } else if (!up && st == State::Online) {
    st = State::Offline;
    downAt = now;
    logf("net: lost the network (%s)", describe(lastReason));
  }
  if (!up && stationTrying) {
    swapPhyIfStuck(now, c.ssid, c.pass, 0);
    swapPhyIfRefused(now, c.ssid, c.pass, 0);
  }
#if defined(ESP32)
  if (!up) retryStation(now, c.ssid, c.pass);
#endif
  // How joining is going, every 15 s for the first minutes, for whoever watches the serial port at set-up (RaptHooker
  // over USB): a reason is only logged when it changes.
  static uint32_t toldAt = 0;
  if (!up && now < 150000 && now - toldAt >= 15000) {
    toldAt = now;
    if (now > 10000) {
      const char* why = lastReason ? describe(lastReason) : associatedAt ? "waiting for an address" : "no answer yet";
      logf("net: still joining %s: %s", c.ssid.c_str(), why);
    }
  }

  if (!up && !apOn && now - downAt > FALLBACK_AFTER_MS && now - apTriedAt > 10000) {
    // Still no network: open the hotspot too, so RaptHooker can reach the screen to fix its settings.
    WiFi.mode(WIFI_AP_STA);
    startAp(WiFi.channel());
  }
  if (apOn && !up) {
    // A station that keeps looking hops channels and drops whoever is on the hotspot, so it waits while
    // someone is connected.
    bool someone = WiFi.softAPgetStationNum() > 0;
    if (someone && stationTrying) {
      WiFi.disconnect();
      stationTrying = false;
    } else if (!someone && !stationTrying) {
      beginStation(c.ssid, c.pass);
      stationTrying = true;
    }
  }
  if (apOn && up && now - upAt > 60000 && WiFi.softAPgetStationNum() == 0) {
    WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_STA);
    apOn = false;
    logf("net: hotspot off");
  }
}

net::State net::state() { return st; }

const char* net::stateName() {
  switch (st) {
    case State::Setup: return "setup";
    case State::Connecting: return "connecting";
    case State::Online: return "online";
    default: return "offline";
  }
}

bool net::online() { return st == State::Online || (st == State::Setup && tr == Trial::Connected); }
String net::apName() { return ap; }
bool net::apActive() { return apOn; }
String net::hostname() { return host; }
String net::reason() { return describe(lastReason); }
uint32_t net::downFor() { return st == State::Online ? 0 : millis() - downAt; }
net::Trial net::trial() { return tr; }

const char* net::trialName() {
  switch (tr) {
    case Trial::Idle: return "idle";
    case Trial::Testing: return "testing";
    case Trial::Connected: return "connected";
    default: return "failed";
  }
}

String net::trialError() { return trialErr; }
IPAddress net::trialIp() { return trialAddr; }
const char* net::phyName() { return phy == PHY_N ? "n" : phy == PHY_B ? "b" : "g"; }
