/** Types shared by the server and the web app. All values are stored and sent in SI-ish units: SG and °C. */

export type GravityUnit = 'sg' | 'plato';
export type TemperatureUnit = 'C' | 'F';

/** One reading from a pill, with the pill's calibration offsets and data choices applied. */
export interface Reading {
  /** Unix time in ms. */
  ts: number;
  /** Specific gravity used everywhere (from the pill, or worked out by RaptHooker from the tilt), e.g. 1.0465. */
  gravity: number;
  /** °C */
  temperature: number;
  /** Gravity points per day (negative while fermenting) from the pill or RaptHooker, or null when not known yet. */
  velocity: number | null;
  /** Battery state of charge, %. */
  battery: number;
  /** Signal strength at the hub, dBm. */
  rssi: number | null;
  /** Angle from vertical, degrees. */
  tilt: number | null;
  /** Raw accelerometer values. */
  x: number;
  y: number;
  z: number;
  /** False when the pill doesn't look like it's floating (lying on its side, or a gravity no beer could have). */
  plausible: boolean;
  /** The gravity the pill itself reported (with the offset applied). */
  pillGravity: number;
  /** The velocity the pill itself reported. */
  pillVelocity: number | null;
}

export type GravitySource = 'pill' | 'tilt';
export type VelocitySource = 'pill' | 'computed';
export type Smoothing = 'off' | 'light' | 'strong';

/** A tilt calibration point: the pill floating in a liquid of known gravity. */
export interface TiltPoint {
  tilt: number;
  sg: number;
  at: number;
}

/**
 * Where a pill's numbers come from. Every choice defaults to the values the pill sends; RaptHooker's own
 * calculations are opt-in.
 */
export interface PillModel {
  /** 'pill': the gravity the pill sends. 'tilt': worked out by RaptHooker from the tilt, using `tiltPoly`. */
  gravitySource: GravitySource;
  tiltPoints: TiltPoint[];
  /** Coefficients a0..an of sg = a0 + a1·tilt + a2·tilt² …, fitted from `tiltPoints`. */
  tiltPoly: number[] | null;
  /** 'pill': the velocity the pill sends. 'computed': RaptHooker's, from the readings over `velocityHours`. */
  velocitySource: VelocitySource;
  velocityHours: number;
  /** Averages the gravity over the last hour ('light') or four hours ('strong') before it's shown or sent. */
  smoothing: Smoothing;
}

export const DEFAULT_PILL_MODEL: PillModel = {
  gravitySource: 'pill',
  tiltPoints: [],
  tiltPoly: null,
  velocitySource: 'pill',
  velocityHours: 24,
  smoothing: 'off',
};

/** How many readings arrived compared with how many the learned interval says should have. */
export interface CatchRate {
  since: number;
  expected: number;
  received: number;
}

export interface Offsets {
  /** Added to the gravity, in SG (e.g. -0.002). */
  gravity: number;
  /** Added to the temperature, °C. */
  temperature: number;
}

export interface PillInfo {
  firmware: string | null;
  deviceType: string | null;
  payloadVersion: number | null;
}

export interface PillLive {
  /** Last advert of any kind. */
  lastHeardAt: number | null;
  /** Last new reading. */
  lastReadingAt: number | null;
  /** First reading ever recorded. */
  firstReadingAt: number | null;
  online: boolean;
  rssi: number | null;
  /** Learned from the gaps between readings. */
  intervalSec: number | null;
  latest: Reading | null;
  /** RaptHooker's own velocity over the pill's velocity window (whichever source is chosen). */
  computedVelocity: number | null;
  /** Readings received vs expected over the last 24 hours. */
  caught: CatchRate | null;
}

export interface Pill {
  id: string;
  /** Bluetooth address, AA:BB:CC:DD:EE:FF. */
  address: string;
  /** The address the RAPT app shows (Bluetooth address with 2 off the last octet). */
  raptId: string;
  name: string;
  color: string;
  createdAt: number;
  /** Archived pills aren't recorded and are hidden from the dashboard. */
  archived: boolean;
  offsets: Offsets;
  model: PillModel;
  /** Position on the dashboard (lowest first). */
  order: number;
  info: PillInfo;
  live: PillLive;
  /** The brew running on this pill, if any. */
  brew: Brew | null;
}

/** A RAPT Pill heard nearby that hasn't been added. */
export interface NearbyPill {
  address: string;
  raptId: string;
  firstHeardAt: number;
  lastHeardAt: number;
  rssi: number | null;
  latest: Reading | null;
  info: PillInfo;
}

export interface BrewStats {
  /** Manual OG, or the gravity at the start of the brew. */
  og: number | null;
  ogAuto: boolean;
  /** Latest gravity (or the final gravity once ended). */
  gravity: number | null;
  abv: number | null;
  /** Apparent attenuation, %. */
  attenuation: number | null;
  tempMin: number | null;
  tempMax: number | null;
  tempAvg: number | null;
  readings: number;
  firstReadingAt: number | null;
  lastReadingAt: number | null;
  /** Gravity has stopped moving (less than 1 point over 48 hours). */
  stable: boolean;
  /** ABV once the gravity is stable (or the brew has ended). */
  finalAbv: number | null;
  prediction: BrewPrediction | null;
}

export type BrewStage = 'lag' | 'active' | 'finishing' | 'done';

/** A fermentation curve fitted to the brew's readings so far. */
export interface BrewPrediction {
  stage: BrewStage;
  /** Expected final gravity. */
  fg: number;
  /** When the gravity is expected to be within a point of the final gravity, or null if it can't be told yet. */
  finishAt: number | null;
  confidence: 'low' | 'medium' | 'high';
  fittedAt: number;
}

export type BrewEventKind = 'dry_hop' | 'temp_change' | 'cold_crash' | 'addition' | 'note';

export interface BrewEventInput {
  at: number;
  kind: BrewEventKind;
  text: string;
}

export interface BrewEvent extends BrewEventInput {
  id: string;
  brewId: string;
}

export type AbvFormula = 'standard' | 'alternative';

export interface BrewInput {
  name: string;
  style: string;
  notes: string;
  /** Manual original gravity (SG), or null to take it from the readings. */
  og: number | null;
  targetFg: number | null;
}

export interface Brew extends BrewInput {
  id: string;
  pillId: string;
  startedAt: number;
  endedAt: number | null;
  stats: BrewStats;
  events: BrewEvent[];
}

/** A brew's readings by hours since it started, for overlaying brews on one chart. */
export interface BrewCurve {
  brewId: string;
  name: string;
  pillId: string;
  startedAt: number;
  hours: number[];
  gravity: (number | null)[];
  temperature: (number | null)[];
}

/** Columnar history, ready for charting. A gap in the data is a row of nulls. */
export interface History {
  pillId: string;
  from: number;
  to: number;
  /** 0 for raw readings, otherwise the averaging bucket size. */
  bucketMs: number;
  ts: number[];
  /** The gravity in use (the pill's or RaptHooker's, see the pill's model), smoothed if smoothing is on. */
  gravity: (number | null)[];
  temperature: (number | null)[];
  velocity: (number | null)[];
  battery: (number | null)[];
  rssi: (number | null)[];
  tilt: (number | null)[];
  /** True where the pill didn't look like it was floating (for a bucket: every reading in it). */
  implausible: (boolean | null)[];
  /** The pill's own gravity, when the gravity above is RaptHooker's or smoothed. */
  pillGravity?: (number | null)[];
  /** The pill's own velocity, when the velocity above is RaptHooker's. */
  pillVelocity?: (number | null)[];
}

export type HttpMethod = 'POST' | 'PUT' | 'PATCH' | 'GET';
export type BodyFormat = 'json' | 'form' | 'text' | 'none';

export interface WebhookHeader {
  name: string;
  value: string;
}

export interface WebhookInput {
  name: string;
  enabled: boolean;
  preset: string;
  url: string;
  method: HttpMethod;
  headers: WebhookHeader[];
  bodyFormat: BodyFormat;
  body: string;
  /** How often each pill's latest reading is sent, minutes. */
  intervalMin: number;
  /** 'all' includes pills added later. */
  pillIds: string[] | 'all';
  onlyDuringBrew: boolean;
  /** Don't resend a reading that has already been sent. */
  onlyNewReadings: boolean;
  gravityUnit: GravityUnit;
  temperatureUnit: TemperatureUnit;
  timeoutSec: number;
  /** Don't send readings from a pill that doesn't look like it's floating. */
  skipImplausible: boolean;
  /** Send every pill in one request: `body` is rendered for each pill and joined into `{{items}}` in `batchBody`. */
  batch: boolean;
  batchBody: string;
  /** Only send when the gravity has moved at least this many points (0.001 SG) since the last send… */
  minChangeGravity: number | null;
  /** …or the temperature by at least this many °C… */
  minChangeTemp: number | null;
  /** …but send anyway when nothing has been sent for this long, minutes. */
  maxSilenceMin: number | null;
  /** Nothing is sent until then. */
  pausedUntil: number | null;
  /** After the destination has been unreachable, send the readings it missed (one per interval), oldest first. */
  catchUp: boolean;
}

/** The newer webhook options, as given to webhooks saved before they existed. */
export const DEFAULT_WEBHOOK_OPTIONS = {
  skipImplausible: true,
  batch: false,
  batchBody: '',
  minChangeGravity: null,
  minChangeTemp: null,
  maxSilenceMin: null,
  pausedUntil: null,
  catchUp: false,
} satisfies Partial<WebhookInput>;

/** The file written by "Export webhooks". */
export interface WebhookExport {
  app: 'rapthooker';
  kind: 'webhooks';
  version: 1;
  exportedAt: number;
  webhooks: WebhookInput[];
}

export type TokenScope = 'read' | 'relay';

/** A key for scripts (read-only API) or a Bluetooth relay (posting adverts). */
export interface ApiToken {
  id: string;
  name: string;
  scope: TokenScope;
  createdAt: number;
  lastUsedAt: number | null;
  /** The last 4 characters, to tell tokens apart. */
  hint: string;
}

/** Returned once, when the token is created. */
export interface ApiTokenCreated extends ApiToken {
  token: string;
}

export interface WebhookPillStatus {
  pillId: string;
  lastSentAt: number | null;
  lastOk: boolean | null;
  nextAt: number | null;
  /** Why the pill's latest reading is being held back on purpose (looks wrong, hasn't changed enough...). */
  skipped?: string | null;
}

export interface WebhookStatus {
  lastAt: number | null;
  lastOk: boolean | null;
  lastHttpStatus: number | null;
  lastError: string | null;
  sent24h: number;
  failed24h: number;
  pills: WebhookPillStatus[];
}

export interface Webhook extends WebhookInput {
  id: string;
  createdAt: number;
  updatedAt: number;
  /** True when secrets (URL, headers, body) are hidden from a viewer. */
  masked: boolean;
  status: WebhookStatus;
}

export interface WebhookDelivery {
  id: number;
  webhookId: string;
  pillId: string | null;
  at: number;
  ok: boolean;
  status: number | null;
  durationMs: number;
  method: string;
  url: string;
  requestBody: string | null;
  responseBody: string | null;
  error: string | null;
  test: boolean;
}

export interface RenderedRequest {
  method: HttpMethod;
  url: string;
  headers: WebhookHeader[];
  body: string | null;
  contentType: string | null;
  /** Problems found while rendering (unknown variables, invalid JSON...). */
  warnings: string[];
}

export type AlertKind = 'temp_above' | 'temp_below' | 'gravity_below' | 'gravity_stable' | 'battery_below' | 'offline';

export interface AlertRuleInput {
  name: string;
  enabled: boolean;
  pillIds: string[] | 'all';
  kind: AlertKind;
  /** °C, SG, %, gravity points (stable) or minutes (offline), depending on the kind. */
  threshold: number;
  /** Window for 'gravity_stable', hours. */
  hours: number;
  onlyDuringBrew: boolean;
  /** Minimum time between notifications for the same pill, minutes. */
  cooldownMin: number;
  /** Where notifications go: channel ids, BROWSER_PUSH for browser notifications, or 'all'. */
  channelIds: string[] | 'all';
}

/** The channel id for browser (web push) notifications. */
export const BROWSER_PUSH = 'push';

export type ChannelKind = 'ntfy' | 'pushover' | 'telegram' | 'discord' | 'email';

export interface ChannelInput {
  name: string;
  kind: ChannelKind;
  enabled: boolean;
  /** Settings for the kind, see CHANNEL_KINDS. */
  config: Record<string, string>;
}

export interface Channel extends ChannelInput {
  id: string;
  createdAt: number;
  /** True when secret settings are hidden from a viewer. */
  masked: boolean;
  lastAt: number | null;
  lastOk: boolean | null;
  lastError: string | null;
}

export interface AlertRule extends AlertRuleInput {
  id: string;
  createdAt: number;
  /** Pills the rule is currently firing for. */
  active: string[];
}

export interface AlertEvent {
  id: number;
  ruleId: string;
  ruleName: string;
  pillId: string;
  at: number;
  kind: 'fired' | 'resolved';
  message: string;
  value: number | null;
}

export interface Session {
  role: 'owner' | 'viewer';
  user: string;
  via: 'tailscale' | 'pin' | 'localhost' | 'lan' | 'token';
  secure: boolean;
  pinSet: boolean;
}

export type BleState = 'starting' | 'scanning' | 'error' | 'unavailable' | 'mock';

/**
 * 'passive': the adapter only listens, with the kernel filtering for RAPT adverts (kinder to the Pi's Wi-Fi).
 * 'active': ordinary discovery, used when passive scanning isn't available.
 */
export type ScanMode = 'passive' | 'active';

export interface BleStatus {
  state: BleState;
  /** The first adapter in use. */
  adapter: string | null;
  adapters: string[];
  mode: ScanMode | null;
  /** Why active scanning is used although passive was wanted (e.g. BlueZ experimental features are off). */
  modeReason?: string | null;
  error: string | null;
  lastAdvertAt: number | null;
  /** When the hub last had the Bluetooth adapter reset because it looked stuck (null: never). */
  lastResetAt?: number | null;
  since: number;
  /** Relays (e.g. an ESP32) that have posted adverts recently. */
  relays: RelayStatus[];
}

export interface RelayStatus {
  name: string;
  lastAt: number;
  adverts: number;
}

export interface HubSettings {
  /** Shown in the header and the browser tab. */
  name: string;
  /** Default units for browsers that haven't picked their own (and for notifications). */
  units: { gravity: GravityUnit; temperature: TemperatureUnit };
  abvFormula: AbvFormula;
  /** Check GitHub for new releases once a day. */
  updateCheck: boolean;
}

export const DEFAULT_HUB_SETTINGS: HubSettings = {
  name: 'RaptHooker',
  units: { gravity: 'sg', temperature: 'C' },
  abvFormula: 'standard',
  updateCheck: true,
};

export interface MqttSettings {
  enabled: boolean;
  /** mqtt://host:1883 or mqtts://host:8883 */
  url: string;
  username: string;
  password: string;
  /** Readings go to `<topic>/<pill id>/state`. */
  topic: string;
  /** Announce each pill to Home Assistant. */
  discovery: boolean;
  discoveryPrefix: string;
  retain: boolean;
  skipImplausible: boolean;
}

export const DEFAULT_MQTT_SETTINGS: MqttSettings = {
  enabled: false,
  url: '',
  username: '',
  password: '',
  topic: 'rapthooker',
  discovery: true,
  discoveryPrefix: 'homeassistant',
  retain: true,
  skipImplausible: true,
};

export interface MqttStatus {
  state: 'off' | 'connecting' | 'connected' | 'error';
  error: string | null;
  lastPublishAt: number | null;
}

export interface S3Settings {
  enabled: boolean;
  /** e.g. https://s3.eu-west-1.amazonaws.com, https://<account>.r2.cloudflarestorage.com, http://nas:9000 */
  endpoint: string;
  region: string;
  bucket: string;
  /** Folder in the bucket, e.g. rapthooker/ */
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Address the bucket as endpoint/bucket rather than bucket.endpoint (MinIO and most NAS servers need this). */
  pathStyle: boolean;
}

export interface BackupSettings {
  /** Copy each backup to a USB stick labelled RAPTHOOKER when one is plugged in. */
  usb: boolean;
  s3: S3Settings;
  /** Also save every brew as CSV once a week. */
  weeklyCsv: boolean;
}

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
  usb: true,
  s3: {
    enabled: false,
    endpoint: '',
    region: 'us-east-1',
    bucket: '',
    prefix: 'rapthooker/',
    accessKeyId: '',
    secretAccessKey: '',
    pathStyle: true,
  },
  weeklyCsv: true,
};

export type BackupTarget = 'local' | 'usb' | 's3';

export interface BackupTargetStatus {
  target: BackupTarget;
  at: number | null;
  ok: boolean | null;
  error: string | null;
  file: string | null;
  /** A state that isn't an error, e.g. "No USB stick plugged in". */
  note?: string | null;
}

/** A backup file kept on the hub. */
export interface BackupFile {
  name: string;
  bytes: number;
  at: number;
  /** daily: a nightly backup; pre-restore: the data as it was just before a restore. */
  kind: 'daily' | 'pre-restore';
}

/** GET /api/backups */
export interface BackupOverview {
  /** Where the daily backups are kept on the hub. */
  dir: string;
  /** Local time of the daily backup, HH:MM. */
  time: string;
  keep: number;
  files: BackupFile[];
  targets: BackupTargetStatus[];
  /** Whether the RAPTHOOKER USB stick is plugged in (null when USB copies are off). */
  usbPresent: boolean | null;
  /** The last weekly CSV export. */
  csv: { at: number | null; folder: string | null; error: string | null };
  /** The last restore, if the data came from one. */
  lastRestore: { at: number; previous: string } | null;
  /** A backup is running right now. */
  running: boolean;
}

/** POST /api/backups/restore */
export interface RestoreResult {
  /** The hub is restarting to finish the restore (false in development: restart it yourself). */
  restarting: boolean;
  pills: number;
  brews: number;
  readings: number;
}

export interface UpdateInfo {
  current: string;
  latest: string | null;
  available: boolean;
  /** Release notes (markdown). */
  notes: string | null;
  url: string | null;
  checkedAt: number | null;
  error: string | null;
  /** The hub was installed with install.sh, so it can update itself. */
  canSelfUpdate: boolean;
  /** Set when the hub runs a development build (deployed from source, not a release): its version number doesn't say what it runs. */
  devBuild: DevBuild | null;
  /** A development build that can replace itself with the latest release. */
  canSwitchToRelease: boolean;
  state: 'idle' | 'updating' | 'failed';
}

/** Where a development build came from, as far as the build knew. */
export interface DevBuild {
  /** Short git commit it was built from. */
  commit: string | null;
  /** Built with uncommitted changes. */
  changes: boolean;
  builtAt: number | null;
}

export interface HubAddress {
  kind: 'lan' | 'mdns' | 'tailscale';
  url: string;
}

export interface DiskStatus {
  totalBytes: number;
  freeBytes: number;
  /** Everything in the data folder (database, backups, exports). */
  dataBytes: number;
  dbBytes: number;
}

export interface HubWarning {
  id: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  at: number;
  level: LogLevel;
  msg: string;
  /** The part of the hub that logged it (ble, webhooks...). */
  svc: string | null;
  /** Extra fields, as JSON. */
  detail: string | null;
}

export interface HubStatus {
  version: string;
  startedAt: number;
  now: number;
  node: string;
  platform: string;
  hostname: string;
  clockSynced: boolean;
  ble: BleStatus;
  dbSizeBytes: number;
  readings: number;
  lastBackup: { at: number; file: string } | null;
  backupError: string | null;
  backups: BackupTargetStatus[];
  disk: DiskStatus | null;
  warnings: HubWarning[];
  mqtt: MqttStatus;
  update: UpdateInfo;
}

export type LiveMessage =
  | { type: 'hello'; pills: Pill[]; nearby: NearbyPill[]; ble: BleStatus; clockSynced: boolean; hub: HubSettings }
  | { type: 'pill'; pill: Pill }
  | { type: 'pill-removed'; pillId: string }
  | { type: 'reading'; pillId: string; reading: Reading }
  | { type: 'nearby'; nearby: NearbyPill[] }
  | { type: 'ble'; ble: BleStatus; clockSynced: boolean }
  | { type: 'brew'; brew: Brew }
  | { type: 'brew-removed'; brewId: string; pillId: string }
  | { type: 'webhook'; webhookId: string; status: WebhookStatus }
  | { type: 'alert'; event: AlertEvent }
  | { type: 'hub'; hub: HubSettings }
  | { type: 'update'; update: UpdateInfo }
  | { type: 'ping'; at: number };
