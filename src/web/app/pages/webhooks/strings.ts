import { t, tk } from '../../i18n';

/**
 * Text from @rapthooker/shared that the webhook pages show: preset descriptions, setup steps and notes, the template
 * variables' descriptions and the preview's warnings. Listed here (with the exact English) so `npm run i18n` finds it;
 * it's translated where it's shown, with t(text). Preset names, variable names and JSON examples stay as they are.
 * strings.test.ts checks nothing in the presets or variables is missing.
 */
export const SHARED_STRINGS: readonly string[] = [
  // Presets: the "untested" note
  tk(
    'Built from the service\'s documentation and other open-source projects, but not yet tried against the real service. Use "Send a test now" and check the delivery log; please report back on GitHub whether it works or not.',
  ),

  // Presets: taglines
  tk('Custom Stream logging to your batches'),
  tk('Fermentation tracking via the iSpindel endpoint'),
  tk('Device stream for your brew sessions'),
  tk('iSpindel-style logging with a token'),
  tk('The same payload as the RAPT portal integration'),
  tk('Your own Fermentrack server (iSpindel endpoint)'),
  tk('Webhook trigger for your automations'),
  tk('IoT dashboards and charts'),
  tk('Charts in a ThingSpeak channel'),
  tk('Fermentation updates posted to a channel'),
  tk('Every value, for your own server or automation'),
  tk('Start from a blank webhook'),

  // Presets: setup steps
  tk('In Brewfather open Settings → Power-ups → Custom Stream and switch it on.'),
  tk('Copy the logging URL it shows and paste it into the URL above (it ends in ?id=…).'),
  tk('After the first reading arrives, the pill appears under Devices in Brewfather: link it to your batch.'),
  tk('In the Grainfather app, add equipment: Fermentation Tracking Equipment → iSpindel DIY electronic Hydrometer.'),
  tk('Open it, choose View instructions and note the Server URL, e.g. /iot/abc123/ispindel.'),
  tk('Replace <DEVICE_ID> above with the part between /iot/ and /ispindel.'),
  tk("Find your API key in Brewer's Friend under Profile → Integrations."),
  tk('Replace <API_KEY> in the URL above.'),
  tk('After the first reading, pick the device in your brew session under Fermentation.'),
  tk('In BrewSpy, add a hydrometer and open its setup tab to find its token.'),
  tk('Replace <BREWSPY_TOKEN> in the body with it. Each pill needs its own token, so make one webhook per pill.'),
  tk('Copy your API key from Bricks and replace <BRICKS_API_KEY> in the body.'),
  tk('After the first reading, activate the pill on your Bricks page and assign it to a fermenter.'),
  tk('In Fermentrack add a gravity sensor of type iSpindel, named exactly like the pill.'),
  tk('Replace <FERMENTRACK_HOST> with the address of your Fermentrack server.'),
  tk('Create an automation with a Webhook trigger and copy its webhook id.'),
  tk('Replace <HOME_ASSISTANT> and <WEBHOOK_ID> above. Use trigger.json.gravity etc. in the automation.'),
  tk('Copy a token from your Ubidots account (API Credentials) into the X-Auth-Token header.'),
  tk("Copy the channel's Write API Key into the body."),
  tk('Use one channel (and one webhook) per pill.'),
  tk('In Discord: channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL, then paste it above.'),
  tk('Point the URL at your own endpoint.'),

  // Presets: notes
  tk('Brewfather ignores anything sent more often than every 15 minutes per device name.'),
  tk('Brewfather identifies the device by its name, so renaming the pill creates a new device there.'),
  tk("Brewfather's battery field is in volts, so the pill's battery % goes in the comment instead."),
  tk('Grainfather expects gravity in °P (it converts to SG itself) and accepts one reading every 15 minutes.'),
  tk('iSpindel-format services expect the battery in volts; RAPT Pills report a percentage, which is sent as it is.'),
  tk("Brewer's Friend allows one post every 15 minutes per API key and brew session (more gets HTTP 429)."),
  tk('If BrewSpy shows odd gravity values, switch the gravity unit to °P.'),
  tk('Allow the webhook to be called from your local network in the trigger settings.'),
  tk('Each pill becomes an Ubidots device named after it.'),
  tk('Fields: 1 gravity, 2 temperature, 3 battery, 4 velocity, 5 tilt, 6 signal.'),

  // Template variables: groups
  tk('Pill'),
  tk('Reading'),
  tk('Brew'),
  tk('Time'),
  tk('Other'),

  // Template variables: descriptions
  tk('The name you gave the pill'),
  tk('The name in lower case with dashes (for URLs and device labels)'),
  tk("RaptHooker's id for the pill"),
  tk('A number from the last 3 bytes of the Bluetooth address (like an iSpindel ID)'),
  tk('Bluetooth address'),
  tk('The MAC address the RAPT app shows'),
  tk('Firmware version'),
  tk('Device type, e.g. PillG1'),
  tk("Gravity in the webhook's unit (SG or °P)"),
  tk('"G" for SG or "P" for Plato (Brewfather/Brewer\'s Friend style)'),
  tk('"SG" or "°P"'),
  tk('Specific gravity, e.g. 1.0465'),
  tk('Degrees Plato'),
  tk('Gravity points, e.g. 46.5'),
  tk("Temperature in the webhook's unit"),
  tk('"C" or "F"'),
  tk('Temperature, °C'),
  tk('Temperature, °F'),
  tk('Gravity change, points per day (null until there is enough data)'),
  tk('true when the pill looks like it is floating, false when the reading looks wrong'),
  tk('The gravity the pill itself sent (SG), even when RaptHooker works it out from the tilt'),
  tk('The velocity the pill itself sent, points per day'),
  tk('Battery, %'),
  tk('Bluetooth signal at the hub, dBm'),
  tk('Angle from vertical, degrees'),
  tk('Accelerometer X'),
  tk('Accelerometer Y'),
  tk('Accelerometer Z'),
  tk('Time of the reading, ISO 8601 (UTC)'),
  tk('Time of the reading, seconds since 1970'),
  tk('Time of the reading, milliseconds since 1970'),
  tk('How old the reading is when sent'),
  tk("This webhook's interval, seconds"),
  tk('Id of the brew running on the pill ("" when none)'),
  tk('Brew name'),
  tk('Beer style'),
  tk("Original gravity, in the webhook's gravity unit"),
  tk("Target final gravity, in the webhook's gravity unit"),
  tk('ABV so far, %'),
  tk('Apparent attenuation so far, %'),
  tk('Days since the brew started'),
  tk('When the brew started, ISO 8601'),
  tk('The name of this hub'),
  tk('RaptHooker version'),

  // Batch variables: descriptions
  tk("Every pill's rendered body, separated by commas (JSON) or new lines (text)"),
  tk('How many pills are in this request'),
  tk('When the request is sent, ISO 8601 (UTC)'),
  tk('When the request is sent, seconds since 1970'),
  tk('When the request is sent, milliseconds since 1970'),

  // Preview warnings
  tk('The URL must start with http:// or https://'),
  tk('Put a username or password in an Authorization header rather than in the URL'),
  tk('Replace the <PLACEHOLDERS> from the preset with your own details'),
  tk('Sending all pills in one request needs a JSON or plain-text body (and not GET)'),
  tk('Put {{items}} in the batch body where the readings go'),
];

/** Descriptions with nothing to translate (the app's name). */
export const UNTRANSLATED = new Set(['"RaptHooker"']);

/** A preview warning from the template renderer, translated (the two with details in them are matched by shape). */
export function warningText(warning: string): string {
  const unknown = /^Unknown variable (\{\{.*\}\})$/.exec(warning);
  if (unknown) return t('Unknown variable {name}', { name: unknown[1]! });
  const json = /^The body isn't valid JSON: ([\s\S]*)$/.exec(warning);
  if (json) return t("The body isn't valid JSON: {error}", { error: json[1]! });
  return t(warning);
}
