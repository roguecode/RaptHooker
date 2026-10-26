import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { connect, type IClientOptions, type MqttClient } from 'mqtt';
import { sgToPlato, type Brew, type MqttSettings, type MqttStatus, type Pill, type Reading } from '@rapthooker/shared';
import type { Logger } from './log.js';
import type { PillService } from './pills.js';
import type { BrewService } from './brews.js';
import type { Settings } from './settings.js';

export interface MqttDeps {
  pills: PillService;
  brews: BrewService;
  settings: Settings;
  version: string;
}

export interface MqttOptions {
  /** First wait before reconnecting; doubled after each failed attempt, up to `maxRetryMs`. */
  minRetryMs?: number;
  maxRetryMs?: number;
  /** Wait between attempts while the broker turns down the login (saving new settings tries again straight away). */
  authRetryMs?: number;
  /** Longest random wait before announcing everything again when Home Assistant restarts. */
  birthDelayMs?: number;
  testTimeoutMs?: number;
  clientId?: string;
}

const SUPPORT_URL = 'https://github.com/roguecode/RaptHooker';

/** One Home Assistant entity per pill, read from the pill's state topic (or its plausible topic). */
interface EntityDef {
  component: 'sensor' | 'binary_sensor';
  object: string;
  name: string;
  /** The field of the state JSON it shows. */
  field?: string;
  unit?: string;
  deviceClass?: string;
  precision?: number;
  measurement?: boolean;
  diagnostic?: boolean;
  /** Created switched off in Home Assistant (the user can turn it on). */
  disabled?: boolean;
  icon?: string;
  /** Also announced for a RAPT Thermometer (which only has these). */
  thermometer?: boolean;
}

export const MQTT_ENTITIES: readonly EntityDef[] = [
  { component: 'sensor', object: 'gravity', name: 'Gravity', field: 'gravity', precision: 4, measurement: true, icon: 'mdi:beer-outline' },
  {
    component: 'sensor',
    object: 'gravity_plato',
    name: 'Gravity (Plato)',
    field: 'gravity_plato',
    unit: '°P',
    precision: 1,
    measurement: true,
    icon: 'mdi:beer-outline',
    disabled: true,
  },
  {
    component: 'sensor',
    object: 'temperature',
    name: 'Temperature',
    field: 'temperature',
    unit: '°C',
    deviceClass: 'temperature',
    precision: 1,
    measurement: true,
    thermometer: true,
  },
  {
    component: 'sensor',
    object: 'velocity',
    name: 'Gravity velocity',
    field: 'velocity',
    unit: 'points/day',
    precision: 1,
    measurement: true,
    icon: 'mdi:speedometer',
  },
  {
    component: 'sensor',
    object: 'battery',
    name: 'Battery',
    field: 'battery',
    unit: '%',
    deviceClass: 'battery',
    precision: 0,
    measurement: true,
  },
  {
    component: 'sensor',
    object: 'signal_strength',
    name: 'Signal strength',
    field: 'rssi',
    unit: 'dBm',
    deviceClass: 'signal_strength',
    measurement: true,
    diagnostic: true,
    thermometer: true,
  },
  {
    component: 'sensor',
    object: 'tilt',
    name: 'Tilt',
    field: 'tilt',
    unit: '°',
    precision: 1,
    measurement: true,
    diagnostic: true,
    icon: 'mdi:angle-acute',
  },
  {
    component: 'sensor',
    object: 'last_reading',
    name: 'Last reading',
    field: 'timestamp',
    deviceClass: 'timestamp',
    diagnostic: true,
    thermometer: true,
  },
  {
    component: 'sensor',
    object: 'pill_gravity',
    name: 'Gravity sent by the pill',
    field: 'pill_gravity',
    precision: 4,
    measurement: true,
    diagnostic: true,
    disabled: true,
  },
  {
    component: 'sensor',
    object: 'pill_velocity',
    name: 'Velocity sent by the pill',
    field: 'pill_velocity',
    unit: 'points/day',
    precision: 1,
    measurement: true,
    diagnostic: true,
    disabled: true,
  },
  { component: 'sensor', object: 'brew', name: 'Brew', field: 'brew_name', icon: 'mdi:glass-mug-variant' },
  { component: 'sensor', object: 'og', name: 'Original gravity', field: 'og', precision: 4, icon: 'mdi:beer-outline' },
  {
    component: 'sensor',
    object: 'abv',
    name: 'ABV',
    field: 'abv',
    unit: '%',
    precision: 1,
    measurement: true,
    icon: 'mdi:glass-mug-variant',
  },
  {
    component: 'sensor',
    object: 'attenuation',
    name: 'Attenuation',
    field: 'attenuation',
    unit: '%',
    precision: 0,
    measurement: true,
    icon: 'mdi:chart-bell-curve-cumulative',
  },
  { component: 'sensor', object: 'stage', name: 'Fermentation stage', field: 'stage', icon: 'mdi:progress-clock' },
  // On ("Problem") when the pill doesn't look like it's floating: lying on its side, or a gravity no beer could have.
  { component: 'binary_sensor', object: 'implausible', name: 'Implausible reading', deviceClass: 'problem' },
];

/** A connection to a broker with the settings it was made with. */
interface Link {
  client: MqttClient;
  s: MqttSettings;
}

const round = (v: number, dp: number): number => Math.round(v * 10 ** dp) / 10 ** dp;
const roundOrNull = (v: number | null | undefined, dp: number): number | null => (v === null || v === undefined ? null : round(v, dp));
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Whether a device of this kind has the entity. */
const hasEntity = (pill: Pill, e: EntityDef): boolean => pill.kind === 'pill' || e.thermometer === true;

/** The JSON published to `<topic>/<pill id>/state`. Brew fields are null when no brew is running. */
export function statePayload(pill: Pill, reading: Reading): Record<string, unknown> {
  const stats = pill.brew?.stats;
  return {
    name: pill.name,
    gravity: roundOrNull(reading.gravity, 4),
    gravity_plato: reading.gravity === null ? null : round(sgToPlato(reading.gravity), 2),
    temperature: round(reading.temperature, 2),
    velocity: roundOrNull(reading.velocity, 2),
    battery: roundOrNull(reading.battery, 1),
    rssi: reading.rssi,
    tilt: roundOrNull(reading.tilt, 1),
    plausible: reading.plausible,
    pill_gravity: roundOrNull(reading.pillGravity, 4),
    pill_velocity: roundOrNull(reading.pillVelocity, 2),
    timestamp: new Date(reading.ts).toISOString(),
    brew_name: pill.brew?.name ?? null,
    og: roundOrNull(stats?.og, 4),
    abv: roundOrNull(stats?.abv, 2),
    attenuation: roundOrNull(stats?.attenuation, 1),
    stage: stats?.prediction?.stage ?? null,
  };
}

/** An error whose message is already fit to show. */
const readable = (message: string): Error => Object.assign(new Error(message), { code: 'RAPTHOOKER' });

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
};

/** The broker address without any username or password in it, for the log. */
const safeUrl = (url: string): string => {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return '(not a valid address)';
  }
};

const isAuthError = (err: unknown): boolean => [4, 5, 134, 135].includes((err as { code?: unknown } | null)?.code as number);

/** Turns a connection error from mqtt.js or Node into something a homebrewer can act on. */
export function describeMqttError(err: unknown, url: string): string {
  const e = err as { code?: unknown; message?: string } | null;
  const message = e?.message ?? String(err);
  const host = hostOf(url);
  switch (e?.code) {
    case 'RAPTHOOKER':
      return message;
    case 4:
    case 134:
      return 'The broker turned down the username or password';
    case 5:
    case 135:
      return "The broker says this user isn't allowed to connect";
    case 2:
    case 133:
      return 'The broker turned down the client id';
    case 1:
    case 132:
      return "The broker doesn't accept MQTT 3.1.1";
    case 3:
    case 136:
    case 137:
      return 'The broker is unavailable right now';
    case 138:
      return 'The broker has banned this client';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EAI_NONAME':
      return `Couldn't find ${host}: check the broker address`;
    case 'ECONNREFUSED':
      return `${host} refused the connection: is the broker running, and is the port right?`;
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EHOSTDOWN':
      return `Couldn't reach ${host}: is it switched on and on this network?`;
    case 'ECONNRESET':
    case 'EPIPE':
      return `${host} closed the connection: check the port, and whether it needs TLS (mqtts://)`;
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
      return "The broker's TLS certificate isn't trusted (is it self-signed?)";
    case 'CERT_HAS_EXPIRED':
      return "The broker's TLS certificate has expired";
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return `The broker's TLS certificate isn't for ${host}`;
    case 'EPROTO':
    case 'ERR_SSL_WRONG_VERSION_NUMBER':
      return `TLS didn't work with ${host}: is this a plain MQTT port? Try mqtt://`;
    case 'ERR_INVALID_URL':
      return "That broker address doesn't look right: use something like mqtt://homeassistant.local:1883";
  }
  if (/connack timeout/i.test(message)) return `${host} didn't answer like an MQTT broker: check the address and port`;
  if (/wrong version number|ssl/i.test(message)) return `TLS didn't work with ${host}: is this a plain MQTT port? Try mqtt://`;
  if (/missing protocol|unknown protocol|invalid url/i.test(message))
    return "That broker address doesn't look right: use something like mqtt://homeassistant.local:1883";
  return message;
}

/** Settings no broker could accept. */
const settingsProblem = (s: MqttSettings): string | null =>
  s.password && !s.username ? 'Enter the username too: MQTT only sends a password along with a username' : null;

const discoverySig = (pill: Pill): string => JSON.stringify([pill.kind, pill.name, pill.info.firmware, pill.info.deviceType]);
const brewSig = (brew: Brew | null): string =>
  brew ? JSON.stringify([brew.id, brew.name, brew.stats.og, brew.stats.prediction?.stage ?? null]) : '';

const sameSettings = (a: MqttSettings, b: MqttSettings | null): boolean => b !== null && JSON.stringify(a) === JSON.stringify(b);

/** Ends a client, giving queued messages (like "offline") a moment to go out. */
function endClient(client: MqttClient, waitMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (!client.connected) {
      client.end(true);
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      client.end(true);
      resolve();
    }, waitMs);
    timer.unref();
    try {
      client.end(false, {}, () => {
        clearTimeout(timer);
        resolve();
      });
    } catch {
      clearTimeout(timer);
      client.end(true);
      resolve();
    }
  });
}

/**
 * Publishes readings to an MQTT broker, and announces each pill to Home Assistant (MQTT discovery).
 *
 * Topics (`<topic>` is the base topic from the settings):
 * - `<topic>/status`: "online" while connected, "offline" (the last will) when not, retained.
 * - `<topic>/<pill id>/state`: the latest reading as JSON (see statePayload).
 * - `<topic>/<pill id>/plausible`: "true", or "false" when the pill doesn't look like it's floating. Published even when
 *   implausible readings are skipped, so Home Assistant can still say the pill has fallen over.
 * - `<prefix>/<component>/rapthooker_<pill id>/<object>/config`: Home Assistant discovery, retained.
 *
 * Problems here never reach the recording: every handler catches and logs its errors. Emits 'status' (MqttStatus).
 */
export class MqttService extends EventEmitter {
  status: MqttStatus = { state: 'off', error: null, lastPublishAt: null };
  private readonly opts: Required<MqttOptions>;
  private readonly hubIdentifier: string;
  /** The settings in use (null when stopped). */
  private settings: MqttSettings | null = null;
  private link: Link | null = null;
  private attempts = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  private birthTimer: NodeJS.Timeout | undefined;
  private attached = false;
  /** Pills announced to Home Assistant on this connection, with what was announced. */
  private readonly announced = new Map<string, string>();
  /** The brew each pill's last published state was for. */
  private readonly brewSigs = new Map<string, string>();

  constructor(
    private readonly deps: MqttDeps,
    private readonly log: Logger,
    opts: MqttOptions = {},
  ) {
    super();
    const host = hostname().replace(/[^A-Za-z0-9_-]/g, '') || 'hub';
    this.opts = {
      minRetryMs: 2000,
      maxRetryMs: 60_000,
      authRetryMs: 5 * 60_000,
      birthDelayMs: 5000,
      testTimeoutMs: 8000,
      clientId: `rapthooker-${host}`,
      ...opts,
    };
    this.hubIdentifier = `rapthooker_hub_${host.toLowerCase()}`;
  }

  async start(): Promise<void> {
    this.attach();
    await this.apply(this.deps.settings.mqtt());
  }

  async stop(): Promise<void> {
    this.detach();
    this.settings = null;
    clearTimeout(this.retryTimer);
    clearTimeout(this.birthTimer);
    const old = this.link;
    this.link = null;
    if (old) await this.shutdown(old, null);
    this.setStatus({ state: 'off', error: null });
  }

  /** Reconnects with new settings. */
  async apply(settings: MqttSettings): Promise<void> {
    const next = { ...settings };
    this.settings = next;
    clearTimeout(this.retryTimer);
    clearTimeout(this.birthTimer);
    this.attempts = 0;
    const old = this.link;
    this.link = null;
    this.announced.clear();
    if (old) await this.shutdown(old, next);
    // A newer apply() (or stop()) took over while the old connection was closing.
    if (this.settings !== next) return;
    if (!next.enabled || !next.url.trim()) {
      this.setStatus({ state: 'off', error: null });
      return;
    }
    const problem = settingsProblem(next);
    if (problem) {
      this.setStatus({ state: 'error', error: problem });
      return;
    }
    this.setStatus({ state: 'connecting', error: null });
    this.open(next);
  }

  onReading(pillId: string, reading: Reading): void {
    this.guard('publishing a reading over MQTT', () => {
      const link = this.connected();
      if (!link) return;
      const pill = this.deps.pills.get(pillId);
      if (!pill || pill.archived) return;
      this.publishState(link, pill, reading);
    });
  }

  /** Tries the settings without saving them: resolves when connected, rejects with a readable error. */
  async test(settings: MqttSettings): Promise<void> {
    if (!settings.url.trim()) throw readable('Enter the broker address first');
    const problem = settingsProblem(settings);
    if (problem) throw readable(problem);
    const timeoutMs = this.opts.testTimeoutMs;
    await new Promise<void>((resolve, reject) => {
      let client: MqttClient | null = null;
      let lastError: unknown = null;
      let done = false;
      const finish = (err: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        client?.end(true);
        if (err) reject(new Error(describeMqttError(err, settings.url)));
        else resolve();
      };
      const timer = setTimeout(
        () => finish(lastError ?? readable(`${hostOf(settings.url)} didn't answer within ${Math.round(timeoutMs / 1000)} seconds`)),
        timeoutMs,
      );
      try {
        // Its own client id, so the test doesn't knock the hub's own connection off the broker.
        const clientId = `rapthooker-test-${randomBytes(3).toString('hex')}`;
        client = connect(settings.url, this.clientOptions(settings, clientId, false, timeoutMs));
      } catch (err) {
        finish(err);
        return;
      }
      client.on('connect', () => finish(null));
      client.on('error', (err) => {
        lastError = err;
      });
      client.on('close', () => finish(lastError ?? readable('The broker closed the connection')));
    });
  }

  // Connection

  private clientOptions(s: MqttSettings, clientId: string, will: boolean, connectTimeout = 10_000): IClientOptions {
    return {
      clientId,
      username: s.username || undefined,
      password: s.password || undefined,
      keepalive: 60,
      // Reconnecting is done here, with a backoff.
      reconnectPeriod: 0,
      connectTimeout,
      clean: true,
      protocolVersion: 4,
      queueQoSZero: false,
      ...(will ? { will: { topic: `${s.topic}/status`, payload: Buffer.from('offline'), qos: 1 as const, retain: true } } : {}),
    };
  }

  private open(s: MqttSettings): void {
    let client: MqttClient;
    try {
      client = connect(s.url, this.clientOptions(s, this.opts.clientId, true));
    } catch (err) {
      this.failed(s, err, false);
      return;
    }
    const link: Link = { client, s };
    this.link = link;
    let lastError: unknown = null;
    let wasConnected = false;
    client.on('connect', () => {
      if (this.link !== link) return;
      wasConnected = true;
      lastError = null;
      this.attempts = 0;
      this.log.info({ broker: safeUrl(s.url) }, 'connected to the MQTT broker');
      this.setStatus({ state: 'connected', error: null });
      this.guard('announcing over MQTT', () => this.announce(link));
    });
    client.on('message', (topic, payload, packet) => {
      if (this.link === link) this.guard('handling an MQTT message', () => this.onMessage(link, topic, payload, packet.retain));
    });
    client.on('error', (err) => {
      lastError = err;
    });
    client.on('close', () => {
      if (this.link !== link) return;
      this.link = null;
      this.announced.clear();
      client.end(true);
      this.failed(
        s,
        lastError ?? readable(wasConnected ? 'Lost the connection to the broker' : "Couldn't connect to the broker"),
        wasConnected,
      );
    });
  }

  private failed(s: MqttSettings, err: unknown, wasConnected: boolean): void {
    const error = describeMqttError(err, s.url);
    if (error !== this.status.error) {
      this.log.warn({ broker: safeUrl(s.url), error }, wasConnected ? 'lost the MQTT connection' : "couldn't connect to the MQTT broker");
    }
    this.setStatus({ state: 'error', error });
    const backoff = Math.min(this.opts.maxRetryMs, this.opts.minRetryMs * 2 ** this.attempts);
    const wait = (isAuthError(err) ? Math.max(backoff, this.opts.authRetryMs) : backoff) * (1 + Math.random() * 0.2);
    this.attempts = Math.min(this.attempts + 1, 20);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (this.settings === s && !this.link) this.guard('reconnecting to MQTT', () => this.open(s));
    }, wait);
    this.retryTimer.unref();
  }

  /** Says goodbye on the old connection (tidying up what the new settings won't use) and closes it. */
  private async shutdown(link: Link, next: MqttSettings | null): Promise<void> {
    const { s } = link;
    if (link.client.connected) {
      this.guard('tidying up MQTT', () => {
        const pills = this.deps.pills.list();
        if (s.discovery && next?.enabled && (!next.discovery || next.discoveryPrefix !== s.discoveryPrefix)) {
          for (const pill of pills) this.clearDiscovery(link, pill.id);
          this.send(link, this.hubTopic(s), '', true);
        }
        if (next?.enabled && next.topic !== s.topic) {
          for (const pill of pills) this.clearState(link, pill.id);
          this.send(link, `${s.topic}/status`, '', true);
        } else {
          // Readings published without retain don't replace a retained one, so drop it rather than leave it stale.
          if (s.retain && next?.enabled && !next.retain) for (const pill of pills) this.clearState(link, pill.id);
          this.send(link, `${s.topic}/status`, 'offline', true);
        }
      });
    }
    await endClient(link.client, 2000);
  }

  private connected(): Link | null {
    return this.link?.client.connected ? this.link : null;
  }

  private send(link: Link, topic: string, payload: string, retain: boolean, done?: () => void): void {
    if (!link.client.connected) return;
    try {
      link.client.publish(topic, payload, { qos: 1, retain }, (err) => {
        if (err) this.log.debug({ topic, err: err.message }, 'MQTT publish failed');
        else done?.();
      });
    } catch (err) {
      this.log.warn({ topic, err: errText(err) }, 'MQTT publish failed');
    }
  }

  /** Everything a broker (and Home Assistant) needs after connecting. */
  private announce(link: Link): void {
    const { s, client } = link;
    this.announced.clear();
    this.brewSigs.clear();
    this.send(link, `${s.topic}/status`, 'online', true);
    if (s.discovery) {
      // Home Assistant's birth message, and the devices announced earlier (to remove any that have gone since). Every
      // kind of device has a temperature.
      client.subscribe([`${s.discoveryPrefix}/status`, `${s.discoveryPrefix}/sensor/+/temperature/config`], { qos: 0 }, (err) => {
        if (err) this.log.warn({ err: err.message }, "couldn't subscribe to Home Assistant's status");
      });
      this.publishAllDiscovery(link);
    }
    this.publishAllStates(link);
  }

  private onMessage(link: Link, topic: string, payload: Buffer, retained: boolean): void {
    const { s } = link;
    if (!s.discovery) return;
    if (topic === `${s.discoveryPrefix}/status`) {
      if (!retained && payload.toString() === 'online') this.rediscoverSoon(link);
      return;
    }
    const pillId = this.staleConfigPill(s, topic, payload);
    if (pillId && !this.isActive(pillId)) {
      this.log.info({ pill: pillId }, 'removing a pill this hub no longer has from Home Assistant');
      this.clearDiscovery(link, pillId);
    }
  }

  /** Home Assistant restarted: announce everything again after a short random wait (as its docs ask). */
  private rediscoverSoon(link: Link): void {
    clearTimeout(this.birthTimer);
    this.birthTimer = setTimeout(
      () =>
        this.guard('announcing to Home Assistant', () => {
          if (this.connected() !== link) return;
          this.publishAllDiscovery(link);
          this.publishAllStates(link);
        }),
      Math.random() * this.opts.birthDelayMs,
    );
    this.birthTimer.unref();
  }

  /** The pill a retained discovery config is for, if this hub announced it. */
  private staleConfigPill(s: MqttSettings, topic: string, payload: Buffer): string | null {
    const head = `${s.discoveryPrefix}/sensor/rapthooker_`;
    const tail = '/temperature/config';
    if (payload.length === 0 || !topic.startsWith(head) || !topic.endsWith(tail)) return null;
    const id = topic.slice(head.length, -tail.length);
    if (!/^[0-9a-z]+$/.test(id)) return null;
    try {
      const config = JSON.parse(payload.toString()) as { device?: { via_device?: unknown } };
      return config.device?.via_device === this.hubIdentifier ? id : null;
    } catch {
      return null;
    }
  }

  private isActive(pillId: string): boolean {
    const pill = this.deps.pills.get(pillId);
    return pill !== null && !pill.archived;
  }

  // State

  private publishState(link: Link, pill: Pill, reading: Reading): void {
    const { s } = link;
    this.brewSigs.set(pill.id, brewSig(pill.brew));
    this.send(link, `${s.topic}/${pill.id}/plausible`, String(reading.plausible), s.retain);
    if (!reading.plausible && s.skipImplausible) return;
    this.send(link, `${s.topic}/${pill.id}/state`, JSON.stringify(statePayload(pill, reading)), s.retain, () =>
      this.setStatus({ lastPublishAt: Date.now() }),
    );
  }

  private publishAllStates(link: Link): void {
    for (const pill of this.deps.pills.list()) {
      if (!pill.archived && pill.live.latest) this.publishState(link, pill, pill.live.latest);
    }
  }

  private clearState(link: Link, pillId: string): void {
    this.send(link, `${link.s.topic}/${pillId}/state`, '', true);
    this.send(link, `${link.s.topic}/${pillId}/plausible`, '', true);
  }

  // Home Assistant discovery

  private origin() {
    return { name: 'RaptHooker', sw_version: this.deps.version, support_url: SUPPORT_URL };
  }

  private hubTopic(s: MqttSettings): string {
    return `${s.discoveryPrefix}/binary_sensor/${this.hubIdentifier}/connection/config`;
  }

  private configTopic(s: MqttSettings, e: EntityDef, pillId: string): string {
    return `${s.discoveryPrefix}/${e.component}/rapthooker_${pillId}/${e.object}/config`;
  }

  /** The hub is a device too, so the pills can say they're connected through it. */
  private hubConfig(s: MqttSettings): Record<string, unknown> {
    return {
      name: 'Connection',
      unique_id: `${this.hubIdentifier}_connection`,
      state_topic: `${s.topic}/status`,
      payload_on: 'online',
      payload_off: 'offline',
      device_class: 'connectivity',
      entity_category: 'diagnostic',
      device: {
        identifiers: [this.hubIdentifier],
        name: this.deps.settings.hub().name,
        manufacturer: 'RaptHooker',
        model: 'RaptHooker hub',
        sw_version: this.deps.version,
      },
      origin: this.origin(),
    };
  }

  private entityConfig(s: MqttSettings, pill: Pill, e: EntityDef): Record<string, unknown> {
    const base = `${s.topic}/${pill.id}`;
    const config: Record<string, unknown> = {
      name: e.name,
      unique_id: `rapthooker_${pill.id}_${e.object}`,
      availability_topic: `${s.topic}/status`,
      ...(e.component === 'binary_sensor'
        ? { state_topic: `${base}/plausible`, payload_on: 'false', payload_off: 'true' }
        : { state_topic: `${base}/state`, value_template: `{{ value_json.${e.field} }}` }),
      device: {
        identifiers: [`rapthooker_${pill.id}`],
        name: pill.name,
        manufacturer: 'KegLand',
        model:
          pill.kind === 'thermometer'
            ? 'RAPT Bluetooth Thermometer'
            : pill.info.deviceType
              ? `RAPT Pill (${pill.info.deviceType})`
              : 'RAPT Pill',
        ...(pill.info.firmware ? { sw_version: pill.info.firmware } : {}),
        via_device: this.hubIdentifier,
      },
      origin: this.origin(),
    };
    if (e.unit) config.unit_of_measurement = e.unit;
    if (e.deviceClass) config.device_class = e.deviceClass;
    if (e.measurement) config.state_class = 'measurement';
    if (e.precision !== undefined) config.suggested_display_precision = e.precision;
    if (e.diagnostic) config.entity_category = 'diagnostic';
    if (e.disabled) config.enabled_by_default = false;
    if (e.icon) config.icon = e.icon;
    return config;
  }

  /** Announces the device's entities, and removes any its kind doesn't have (it may have turned out to be the other kind). */
  private publishDiscovery(link: Link, pill: Pill): void {
    for (const e of MQTT_ENTITIES) {
      const config = hasEntity(pill, e) ? JSON.stringify(this.entityConfig(link.s, pill, e)) : '';
      this.send(link, this.configTopic(link.s, e, pill.id), config, true);
    }
    this.announced.set(pill.id, discoverySig(pill));
  }

  private publishAllDiscovery(link: Link): void {
    this.send(link, this.hubTopic(link.s), JSON.stringify(this.hubConfig(link.s)), true);
    for (const pill of this.deps.pills.list()) if (!pill.archived) this.publishDiscovery(link, pill);
  }

  /** An empty retained config removes the entity (and the device, once it has none left) from Home Assistant. */
  private clearDiscovery(link: Link, pillId: string): void {
    for (const e of MQTT_ENTITIES) this.send(link, this.configTopic(link.s, e, pillId), '', true);
    this.announced.delete(pillId);
  }

  // Changes elsewhere in the hub

  private readonly onSettings = (next: MqttSettings): void => {
    if (sameSettings(next, this.settings) && this.status.state === 'connected') return;
    this.apply(next).catch((err: unknown) => this.log.error({ err: errText(err) }, "couldn't apply the MQTT settings"));
  };

  private readonly onHub = (): void =>
    this.guard('renaming the hub in Home Assistant', () => {
      const link = this.connected();
      if (link?.s.discovery) this.send(link, this.hubTopic(link.s), JSON.stringify(this.hubConfig(link.s)), true);
    });

  /** Renamed, archived or brought back, or new firmware heard: tell Home Assistant. */
  private readonly onPill = (pill: Pill): void =>
    this.guard('announcing a pill to Home Assistant', () => {
      const link = this.connected();
      if (!link?.s.discovery) return;
      if (pill.archived) {
        if (this.announced.has(pill.id)) this.clearDiscovery(link, pill.id);
      } else if (this.announced.get(pill.id) !== discoverySig(pill)) {
        this.publishDiscovery(link, pill);
      }
    });

  private readonly onRemoved = (pillId: string): void =>
    this.guard('removing a pill from MQTT', () => {
      this.brewSigs.delete(pillId);
      const link = this.connected();
      if (!link) return;
      if (link.s.discovery) this.clearDiscovery(link, pillId);
      this.clearState(link, pillId);
    });

  /** A brew started, ended, was renamed or its OG changed: publish the pill's latest state with it. */
  private readonly onBrew = (brew: Brew): void =>
    this.guard('publishing a brew change over MQTT', () => {
      const link = this.connected();
      if (!link) return;
      const pill = this.deps.pills.get(brew.pillId);
      if (!pill || pill.archived || !pill.live.latest) return;
      if (this.brewSigs.get(pill.id) === brewSig(pill.brew)) return;
      this.publishState(link, pill, pill.live.latest);
    });

  private attach(): void {
    if (this.attached) return;
    this.attached = true;
    const { settings, pills, brews } = this.deps;
    settings.on('mqtt', this.onSettings);
    settings.on('hub', this.onHub);
    pills.on('pill', this.onPill);
    pills.on('removed', this.onRemoved);
    brews.on('brew', this.onBrew);
    brews.on('removed', this.onBrew);
  }

  private detach(): void {
    if (!this.attached) return;
    this.attached = false;
    const { settings, pills, brews } = this.deps;
    settings.off('mqtt', this.onSettings);
    settings.off('hub', this.onHub);
    pills.off('pill', this.onPill);
    pills.off('removed', this.onRemoved);
    brews.off('brew', this.onBrew);
    brews.off('removed', this.onBrew);
  }

  private setStatus(patch: Partial<MqttStatus>): void {
    const next = { ...this.status, ...patch };
    if (next.state === this.status.state && next.error === this.status.error && next.lastPublishAt === this.status.lastPublishAt) return;
    this.status = next;
    this.emit('status', next);
  }

  private guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.log.error({ err: err instanceof Error ? (err.stack ?? err.message) : String(err) }, `${what} failed`);
    }
  }
}
