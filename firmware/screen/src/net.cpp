#include "net.h"

#include <ESP8266WiFi.h>
#include <ESP8266mDNS.h>

#include "log.h"
#include "store.h"
#include "version.h"

static const uint32_t FALLBACK_AFTER_MS = 5 * 60 * 1000;
static const uint32_t TRIAL_TIMEOUT_MS = 60 * 1000;

static net::State st = net::State::Setup;
static net::Trial tr = net::Trial::Idle;
static String ap, host, trialErr;
static IPAddress trialAddr;
static uint32_t downAt = 0, upAt = 0, trialAt = 0, apTriedAt = 0, authFailures = 0, associatedAt = 0;
static int lastReason = 0, apChannel = 1;
static bool apOn = false, stationTrying = false, mdnsOn = false;
static WiFiEventHandler onDisconnect, onConnect, onIp;

static String hex3(const uint8_t* m, bool upper) {
  char b[7];
  snprintf(b, sizeof(b), upper ? "%02X%02X%02X" : "%02x%02x%02x", m[3], m[4], m[5]);
  return b;
}

static WiFiPhyMode_t phy = WIFI_PHY_MODE_11G;
static String trialSsid, trialPass;
static int trialChannel = 0;

// When DHCP fails lwIP picks a 169.254.x.x address of its own. Nothing else on the network can use that,
// so it counts as no address at all.
static bool hasAddress() {
  if (WiFi.status() != WL_CONNECTED) return false;
  IPAddress ip = WiFi.localIP();
  return ip.isSet() && !(ip[0] == 169 && ip[1] == 254);
}

// Some routers (ASUS AX and AiMesh among them) let an ESP8266 join in 802.11n but never answer its DHCP
// requests, and a few want n. So when it joins but gets no address, it tries the other mode.
static void swapPhyIfStuck(uint32_t now, const String& ssid, const String& pass, int channel) {
  if (!associatedAt || hasAddress() || now - associatedAt < 20000) return;
  WiFi.disconnect();
  associatedAt = 0;
  phy = phy == WIFI_PHY_MODE_11G ? WIFI_PHY_MODE_11N : WIFI_PHY_MODE_11G;
  WiFi.setPhyMode(phy);
  logf("net: no address after 20 s, trying 802.11%s", net::phyName());
  WiFi.begin(ssid, pass, channel);
}

static const char* describe(int r) {
  switch (r) {
    case 0: return "";
    case WIFI_DISCONNECT_REASON_NO_AP_FOUND: return "network not found";
    case WIFI_DISCONNECT_REASON_AUTH_EXPIRE:
    case WIFI_DISCONNECT_REASON_AUTH_FAIL:
    case WIFI_DISCONNECT_REASON_4WAY_HANDSHAKE_TIMEOUT:
    case WIFI_DISCONNECT_REASON_HANDSHAKE_TIMEOUT: return "wrong password";
    case WIFI_DISCONNECT_REASON_ASSOC_FAIL: return "couldn't join";
    case WIFI_DISCONNECT_REASON_BEACON_TIMEOUT: return "signal lost";
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

void net::begin() {
  WiFi.persistent(false);
  WiFi.setAutoConnect(false);
  WiFi.mode(WIFI_OFF);
  WiFi.setSleepMode(WIFI_NONE_SLEEP);  // it's on USB power, and stays quick to answer
  uint8_t mac[6];
  WiFi.macAddress(mac);
  ap = "RaptHooker-Screen-" + hex3(mac, true);
  host = "rh-screen-" + hex3(mac, false);
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
  Settings& c = store::settings();
  if (c.configured()) {
    WiFi.mode(WIFI_STA);
    WiFi.hostname(host);
    WiFi.setAutoReconnect(true);
    phy = c.phy == "n" ? WIFI_PHY_MODE_11N : c.phy == "b" ? WIFI_PHY_MODE_11B : WIFI_PHY_MODE_11G;
    WiFi.setPhyMode(phy);
    if (c.txPower) WiFi.setOutputPower(c.txPower);
    WiFi.begin(c.ssid, c.pass);
    stationTrying = true;
    st = State::Connecting;
    downAt = millis();
    logf("net: joining %s", c.ssid.c_str());
  } else {
    WiFi.mode(WIFI_AP);
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
  WiFi.hostname(host);
  // The hotspot has to be on the network's channel once the station joins it. Moving it first means
  // RaptHooker's connection drops once, now, rather than at a moment it can't predict.
  if (channel > 0 && channel != WiFi.channel()) startAp(channel);
  phy = WIFI_PHY_MODE_11G;
  WiFi.setPhyMode(phy);
  WiFi.begin(ssid, pass, trialChannel);
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
  if (mdnsOn) MDNS.update();
  uint32_t now = millis();
  if (st == State::Setup) {
    // Without its hotspot an unset screen can't be reached at all, so keep trying to start it.
    if (!apOn && now - apTriedAt > 10000) startAp(apChannel);
    if (tr != Trial::Testing) return;
    wl_status_t s = WiFi.status();
    uint32_t t = now - trialAt;
    swapPhyIfStuck(now, trialSsid, trialPass, trialChannel);
    if (hasAddress()) endTrial(Trial::Connected, "");
    else if ((s == WL_WRONG_PASSWORD || authFailures >= 2) && t > 8000) endTrial(Trial::Failed, "wrong password");
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
  if (!up && stationTrying) swapPhyIfStuck(now, c.ssid, c.pass, 0);

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
      WiFi.begin(c.ssid, c.pass);
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
const char* net::phyName() { return phy == WIFI_PHY_MODE_11N ? "n" : phy == WIFI_PHY_MODE_11B ? "b" : "g"; }
