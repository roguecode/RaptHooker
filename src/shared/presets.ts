import type { BodyFormat, GravityUnit, HttpMethod, TemperatureUnit, WebhookHeader } from './types.js';

export interface WebhookPreset {
  id: string;
  name: string;
  /** One line shown in the preset picker. */
  tagline: string;
  /** Emoji shown as the preset's badge. */
  badge: string;
  docsUrl: string | null;
  url: string;
  method: HttpMethod;
  headers: WebhookHeader[];
  bodyFormat: BodyFormat;
  body: string;
  intervalMin: number;
  /** The service ignores or rejects anything more frequent. */
  minIntervalMin: number | null;
  gravityUnit: GravityUnit;
  temperatureUnit: TemperatureUnit;
  setup: string[];
  notes: string[];
  /**
   * True once the preset has been tried against the real service. Untested presets are built from the service's
   * documentation and other open-source projects.
   */
  verified: boolean;
}

/** 'verified' or 'untested' for presets that talk to a service; null for your own endpoint (nothing to test). */
export function presetTrust(p: Pick<WebhookPreset, 'verified' | 'docsUrl'>): 'verified' | 'untested' | null {
  if (p.verified) return 'verified';
  return p.docsUrl === null ? null : 'untested';
}

export const UNTESTED_PRESET_NOTE =
  "Built from the service's documentation and other open-source projects, but not yet tried against the real service. " +
  'Use "Send a test now" and check the delivery log; please report back on GitHub whether it works or not.';

const ispindelBody = (token: string) => `{
  "name": "{{name}}",
  "ID": {{chip_id}},
  "token": "${token}",
  "angle": {{tilt|0}},
  "temperature": {{temperature}},
  "temp_units": "{{temp_unit}}",
  "battery": {{battery}},
  "gravity": {{gravity}},
  "interval": {{interval}},
  "RSSI": {{rssi|0}}
}`;

const ISPINDEL_BATTERY_NOTE =
  'iSpindel-format services expect the battery in volts; RAPT Pills report a percentage, which is sent as it is.';

export const PRESETS: WebhookPreset[] = [
  {
    id: 'brewfather',
    name: 'Brewfather',
    tagline: 'Custom Stream logging to your batches',
    badge: '🍺',
    docsUrl: 'https://docs.brewfather.app/integrations/custom-stream',
    url: 'https://log.brewfather.net/stream?id=<LOGGING_ID>',
    method: 'POST',
    headers: [],
    bodyFormat: 'json',
    body: `{
  "name": "{{name}}",
  "temp": {{temperature}},
  "temp_unit": "{{temp_unit}}",
  "gravity": {{gravity}},
  "gravity_unit": "{{gravity_unit}}",
  "angle": {{tilt|0}},
  "rssi": {{rssi|0}},
  "beer": "{{brew_style}}",
  "comment": "Battery {{battery}}%",
  "device_source": "RAPT Pill",
  "report_source": "RaptHooker"
}`,
    intervalMin: 15,
    minIntervalMin: 15,
    gravityUnit: 'sg',
    temperatureUnit: 'C',
    setup: [
      'In Brewfather open Settings → Power-ups → Custom Stream and switch it on.',
      'Copy the logging URL it shows and paste it into the URL above (it ends in ?id=…).',
      'After the first reading arrives, the pill appears under Devices in Brewfather: link it to your batch.',
    ],
    notes: [
      'Brewfather ignores anything sent more often than every 15 minutes per device name.',
      'Brewfather identifies the device by its name, so renaming the pill creates a new device there.',
      "Brewfather's battery field is in volts, so the pill's battery % goes in the comment instead.",
    ],
    verified: false,
  },
  {
    id: 'grainfather',
    name: 'Grainfather',
    tagline: 'Fermentation tracking via the iSpindel endpoint',
    badge: '🌾',
    docsUrl: 'https://mp-se.github.io/gravitymon/services.html',
    url: 'http://community.grainfather.com/iot/<DEVICE_ID>/ispindel',
    method: 'POST',
    headers: [],
    bodyFormat: 'json',
    body: ispindelBody(''),
    intervalMin: 15,
    minIntervalMin: 15,
    gravityUnit: 'plato',
    temperatureUnit: 'C',
    setup: [
      'In the Grainfather app, add equipment: Fermentation Tracking Equipment → iSpindel DIY electronic Hydrometer.',
      'Open it, choose View instructions and note the Server URL, e.g. /iot/abc123/ispindel.',
      'Replace <DEVICE_ID> above with the part between /iot/ and /ispindel.',
    ],
    notes: [
      'Grainfather expects gravity in °P (it converts to SG itself) and accepts one reading every 15 minutes.',
      ISPINDEL_BATTERY_NOTE,
    ],
    verified: true,
  },
  {
    id: 'brewersfriend',
    name: "Brewer's Friend",
    tagline: 'Device stream for your brew sessions',
    badge: '📒',
    docsUrl: 'https://docs.brewersfriend.com/api/stream',
    url: 'https://log.brewersfriend.com/stream/<API_KEY>',
    method: 'POST',
    headers: [],
    bodyFormat: 'json',
    body: `{
  "name": "{{name}}",
  "device_source": "RAPT Pill",
  "report_source": "RaptHooker",
  "temp": {{temperature}},
  "temp_unit": "{{temp_unit}}",
  "gravity": {{gravity}},
  "gravity_unit": "{{gravity_unit}}",
  "RSSI": {{rssi|0}},
  "angle": {{tilt|0}},
  "beer": "{{brew_name}}",
  "comment": "Battery {{battery}}%"
}`,
    intervalMin: 15,
    minIntervalMin: 15,
    gravityUnit: 'sg',
    temperatureUnit: 'C',
    setup: [
      "Find your API key in Brewer's Friend under Profile → Integrations.",
      'Replace <API_KEY> in the URL above.',
      'After the first reading, pick the device in your brew session under Fermentation.',
    ],
    notes: ["Brewer's Friend allows one post every 15 minutes per API key and brew session (more gets HTTP 429)."],
    verified: false,
  },
  {
    id: 'brewspy',
    name: 'BrewSpy',
    tagline: 'iSpindel-style logging with a token',
    badge: '🕵️',
    docsUrl: 'https://brewspy.app/bier/brewspy/faq/view/5/EN/Setting-up-iSpindel',
    url: 'http://brew-spy.com/api/ispindel',
    method: 'POST',
    headers: [],
    bodyFormat: 'json',
    body: ispindelBody('<BREWSPY_TOKEN>'),
    intervalMin: 15,
    minIntervalMin: 15,
    gravityUnit: 'sg',
    temperatureUnit: 'C',
    setup: [
      'In BrewSpy, add a hydrometer and open its setup tab to find its token.',
      'Replace <BREWSPY_TOKEN> in the body with it. Each pill needs its own token, so make one webhook per pill.',
    ],
    notes: ['If BrewSpy shows odd gravity values, switch the gravity unit to °P.', ISPINDEL_BATTERY_NOTE],
    verified: true,
  },
  {
    id: 'bricks',
    name: 'Bricks (BierBot)',
    tagline: 'The same payload as the RAPT portal integration',
    badge: '🧱',
    docsUrl: 'https://docs.bierbot.com/hardware/hardware/raptpill',
    url: 'https://brewbricks.com/api/iot/v1',
    method: 'POST',
    headers: [],
    bodyFormat: 'json',
    body: `{
  "apikey": "<BRICKS_API_KEY>",
  "type": "raptpill",
  "brand": "rapt",
  "version": "0.0.1",
  "chipid": "{{name}}",
  "s_number_wort_0": {{gravity}},
  "s_number_temp_0": {{temperature}},
  "s_number_batterypercent_0": {{battery}},
  "s_number_wifi_0": {{rssi|0}}
}`,
    intervalMin: 15,
    minIntervalMin: null,
    gravityUnit: 'sg',
    temperatureUnit: 'C',
    setup: [
      'Copy your API key from Bricks and replace <BRICKS_API_KEY> in the body.',
      'After the first reading, activate the pill on your Bricks page and assign it to a fermenter.',
    ],
    notes: [],
    verified: false,
  },
  {
    id: 'fermentrack',
    name: 'Fermentrack',
    tagline: 'Your own Fermentrack server (iSpindel endpoint)',
    badge: '🧪',
    docsUrl: 'https://docs.fermentrack.com/',
    url: 'http://<FERMENTRACK_HOST>/ispindel/',
    method: 'POST',
    headers: [],
    bodyFormat: 'json',
    body: ispindelBody(''),
    intervalMin: 5,
    minIntervalMin: null,
    gravityUnit: 'sg',
    temperatureUnit: 'C',
    setup: [
      'In Fermentrack add a gravity sensor of type iSpindel, named exactly like the pill.',
      'Replace <FERMENTRACK_HOST> with the address of your Fermentrack server.',
    ],
    notes: [ISPINDEL_BATTERY_NOTE],
    verified: false,
  },
  {
    id: 'homeassistant',
    name: 'Home Assistant',
    tagline: 'Webhook trigger for your automations',
    badge: '🏠',
    docsUrl: 'https://www.home-assistant.io/docs/automation/trigger/#webhook-trigger',
    url: 'http://<HOME_ASSISTANT>:8123/api/webhook/<WEBHOOK_ID>',
    method: 'POST',
    headers: [],
    bodyFormat: 'json',
    body: `{
  "pill": "{{name}}",
  "pill_id": "{{pill_id}}",
  "gravity": {{gravity_sg}},
  "temperature": {{temperature_c}},
  "velocity": {{velocity}},
  "battery": {{battery}},
  "rssi": {{rssi}},
  "tilt": {{tilt}},
  "brew": "{{brew_name}}",
  "abv": {{brew_abv}},
  "timestamp": "{{timestamp}}"
}`,
    intervalMin: 5,
    minIntervalMin: null,
    gravityUnit: 'sg',
    temperatureUnit: 'C',
    setup: [
      'Create an automation with a Webhook trigger and copy its webhook id.',
      'Replace <HOME_ASSISTANT> and <WEBHOOK_ID> above. Use trigger.json.gravity etc. in the automation.',
    ],
    notes: ['Allow the webhook to be called from your local network in the trigger settings.'],
    verified: true,
  },
  {
    id: 'ubidots',
    name: 'Ubidots',
    tagline: 'IoT dashboards and charts',
    badge: '📈',
    docsUrl: 'https://docs.ubidots.com/reference/http',
    url: 'https://industrial.api.ubidots.com/api/v1.6/devices/{{name_slug}}',
    method: 'POST',
    headers: [{ name: 'X-Auth-Token', value: '<UBIDOTS_TOKEN>' }],
    bodyFormat: 'json',
    body: `{
  "gravity": {{gravity}},
  "temperature": {{temperature}},
  "battery": {{battery}},
  "velocity": {{velocity|0}},
  "tilt": {{tilt|0}},
  "rssi": {{rssi|0}}
}`,
    intervalMin: 15,
    minIntervalMin: null,
    gravityUnit: 'sg',
    temperatureUnit: 'C',
    setup: ['Copy a token from your Ubidots account (API Credentials) into the X-Auth-Token header.'],
    notes: ['Each pill becomes an Ubidots device named after it.'],
    verified: false,
  },
  {
    id: 'thingspeak',
    name: 'ThingSpeak',
    tagline: 'Charts in a ThingSpeak channel',
    badge: '📊',
    docsUrl: 'https://www.mathworks.com/help/thingspeak/writedata.html',
    url: 'https://api.thingspeak.com/update.json',
    method: 'POST',
    headers: [],
    bodyFormat: 'json',
    body: `{
  "api_key": "<WRITE_API_KEY>",
  "field1": {{gravity}},
  "field2": {{temperature}},
  "field3": {{battery}},
  "field4": {{velocity|0}},
  "field5": {{tilt|0}},
  "field6": {{rssi|0}}
}`,
    intervalMin: 5,
    minIntervalMin: null,
    gravityUnit: 'sg',
    temperatureUnit: 'C',
    setup: ["Copy the channel's Write API Key into the body.", 'Use one channel (and one webhook) per pill.'],
    notes: ['Fields: 1 gravity, 2 temperature, 3 battery, 4 velocity, 5 tilt, 6 signal.'],
    verified: false,
  },
  {
    id: 'discord',
    name: 'Discord',
    tagline: 'Fermentation updates posted to a channel',
    badge: '💬',
    docsUrl: 'https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks',
    url: 'https://discord.com/api/webhooks/<WEBHOOK_ID>/<WEBHOOK_TOKEN>',
    method: 'POST',
    headers: [],
    bodyFormat: 'json',
    body: `{
  "username": "RaptHooker",
  "content": "🍺 **{{name}}**: {{gravity}} {{gravity_label}}, {{temperature}} °{{temp_unit}}, battery {{battery}}%"
}`,
    intervalMin: 120,
    minIntervalMin: null,
    gravityUnit: 'sg',
    temperatureUnit: 'C',
    setup: ['In Discord: channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL, then paste it above.'],
    notes: [],
    verified: true,
  },
  {
    id: 'generic',
    name: 'Everything (JSON)',
    tagline: 'Every value, for your own server or automation',
    badge: '🧰',
    docsUrl: null,
    url: 'https://<YOUR_SERVER>/rapt',
    method: 'POST',
    headers: [],
    bodyFormat: 'json',
    body: `{
  "pill": {
    "id": "{{pill_id}}",
    "name": "{{name}}",
    "rapt_id": "{{rapt_id}}",
    "address": "{{address}}",
    "firmware": "{{firmware}}"
  },
  "reading": {
    "timestamp": "{{timestamp}}",
    "gravity": {{gravity}},
    "gravity_unit": "{{gravity_unit}}",
    "gravity_sg": {{gravity_sg}},
    "gravity_plato": {{gravity_plato}},
    "temperature": {{temperature}},
    "temp_unit": "{{temp_unit}}",
    "velocity": {{velocity}},
    "battery": {{battery}},
    "rssi": {{rssi}},
    "tilt": {{tilt}},
    "accel": { "x": {{accel_x}}, "y": {{accel_y}}, "z": {{accel_z}} }
  },
  "brew": {
    "id": "{{brew_id}}",
    "name": "{{brew_name}}",
    "style": "{{brew_style}}",
    "og": {{brew_og}},
    "target_fg": {{brew_target_fg}},
    "abv": {{brew_abv}},
    "attenuation": {{brew_attenuation}},
    "days": {{brew_days}}
  },
  "source": "{{app}} {{app_version}}"
}`,
    intervalMin: 15,
    minIntervalMin: null,
    gravityUnit: 'sg',
    temperatureUnit: 'C',
    setup: ['Point the URL at your own endpoint.'],
    notes: [],
    verified: false,
  },
  {
    id: 'custom',
    name: 'Custom',
    tagline: 'Start from a blank webhook',
    badge: '✏️',
    docsUrl: null,
    url: 'https://',
    method: 'POST',
    headers: [],
    bodyFormat: 'json',
    body: `{
  "name": "{{name}}",
  "gravity": {{gravity}},
  "temperature": {{temperature}}
}`,
    intervalMin: 15,
    minIntervalMin: null,
    gravityUnit: 'sg',
    temperatureUnit: 'C',
    setup: [],
    notes: [],
    verified: false,
  },
];

export function presetById(id: string): WebhookPreset | undefined {
  return PRESETS.find((p) => p.id === id);
}
