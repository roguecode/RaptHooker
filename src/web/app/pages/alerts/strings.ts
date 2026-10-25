import { channelKindInfo, type ChannelKind, type ChannelKindInfo } from '@rapthooker/shared';
import { t, tk } from '../../i18n';

/**
 * Text from @rapthooker/shared that the alerts page shows (ALERT_KINDS in format.ts; CHANNEL_KINDS and the checks in
 * channelFieldProblems in channels.ts), listed so `npm run i18n` finds it (it doesn't read src/shared). Each must match
 * the shared text exactly; it's translated with t() where it's shown. Service names (ntfy, Pushover...) stay as they are.
 */
export const SHARED_ALERT_STRINGS = [
  // ALERT_KINDS: label, describe
  tk('Temperature above'),
  tk('The beer gets too warm'),
  tk('Temperature below'),
  tk('The beer gets too cold'),
  tk('Gravity reaches'),
  tk('Gravity drops to a target'),
  tk('Fermentation stable'),
  tk('Gravity has changed less than this many points over the window'),
  tk('Battery below'),
  tk('The pill needs charging'),
  tk('Pill goes quiet'),
  tk('Nothing heard from the pill for a while'),

  // CHANNEL_KINDS: ntfy
  tk('Free push notifications through the ntfy app, no account needed'),
  tk('Install the ntfy app on your phone, or open ntfy.sh in a browser.'),
  tk('Pick a topic name that is hard to guess (anyone who knows it can read your alerts) and subscribe to it in the app.'),
  tk('Type the same topic here and send a test.'),
  tk('Get the ntfy app'),
  tk('ntfy publishing docs'),
  tk('Server'),
  tk('Only change it if you run your own ntfy server.'),
  tk('Topic'),
  tk('Letters, numbers, - and _. Anyone who knows it can read your alerts, so make it hard to guess.'),
  tk('Access token'),
  tk('Only for protected topics. Or use a username and password instead.'),
  tk('Username'),
  tk('Password'),
  // i18n: placeholder of an optional field
  tk('Optional'),

  // Pushover
  tk('Reliable alerts on iPhone, Android and desktop (one-off app purchase)'),
  tk('Sign up at pushover.net and install the Pushover app. Your user key is on the Pushover dashboard.'),
  tk('Create an application (call it RaptHooker) and copy its API token.'),
  tk('Paste both here and send a test.'),
  tk('Create a Pushover application'),
  tk('Pushover API docs'),
  tk('API token'),
  tk('30 letters and numbers'),
  tk("From your application's page on pushover.net."),
  tk('User key'),
  tk('On your Pushover dashboard (or a group key).'),
  tk('Device'),
  tk('Leave empty to send to all your devices.'),

  // Telegram
  tk('Messages from your own Telegram bot'),
  tk('In Telegram, talk to @BotFather: send /newbot and follow the steps. Copy the bot token it gives you.'),
  tk('Open a chat with your new bot and send it any message (or add the bot to a group).'),
  tk('In a browser, open api.telegram.org/bot<your token>/getUpdates and copy the number after "chat":{"id":'),
  tk('Paste the token and chat ID here and send a test.'),
  tk('Talk to @BotFather'),
  tk('Telegram bot tutorial'),
  tk('Bot token'),
  tk('From @BotFather.'),
  tk('Chat ID'),
  tk('A number (group chats start with -), or @name for a public channel.'),

  // Discord
  tk('Posts in a channel on your Discord server'),
  tk('In Discord: Server Settings → Integrations → Webhooks → New Webhook.'),
  tk('Pick the channel it posts to, then Copy Webhook URL.'),
  tk('Paste it here and send a test.'),
  tk('Intro to Discord webhooks'),
  tk('Webhook URL'),
  tk('Anyone with this URL can post to the channel, so keep it to yourself.'),

  // Email
  tk('Email'),
  tk("Through your mail provider's SMTP server"),
  tk("Look up your mail provider's SMTP settings: server, port and security."),
  tk('Gmail, Outlook and most others want an app password here, not your normal password.'),
  tk('Fill them in and send a test.'),
  tk('Gmail app passwords'),
  tk('Nodemailer SMTP options'),
  tk('SMTP server'),
  tk('Port'),
  tk('Security'),
  tk('STARTTLS (usually port 587)'),
  tk('TLS (usually port 465)'),
  tk('None (only on your own network)'),
  tk('Leave empty if the server needs no login.'),
  tk('App password'),
  // i18n: the sender of an email
  tk('Sender'),
  // i18n: who an email is sent to
  tk('Send to'),
  tk('Most providers only accept your own address here.'),
  tk('Separate several addresses with commas.'),

  // channelFieldProblems
  tk('Server must be a web address starting with https://'),
  tk('Topic can only use letters, numbers, - and _ (up to 64)'),
  tk('Fill in Password to go with the username'),
  tk('Fill in Username to go with the password'),
  tk('API token should be 30 letters and numbers'),
  tk('User key should be 30 letters and numbers'),
  tk('Device should be a device name from Pushover'),
  tk('Bot token should look like 123456789:AAE…'),
  tk('Chat ID should be a number (or @name for a public channel)'),
  tk('Webhook URL should start with https://discord.com/api/webhooks/'),
  tk('Port should be a number like 587 or 465'),
  tk('Pick a Security option'),
  tk('From should be an email address'),
  tk('To should be email addresses separated by commas'),
];

/** A service's name in the language in use (only "Email" is a word; the rest are names). */
export const channelKindLabel = (kind: ChannelKind): string => (kind === 'email' ? t('Email') : channelKindInfo(kind).label);

/** One of channelFieldProblems' messages in the language in use. */
export function channelProblemText(info: ChannelKindInfo, key: string, message: string): string {
  const field = info.fields.find((f) => f.key === key);
  if (field && message === `Fill in ${field.label}`) return t('Fill in {field}', { field: t(field.label) });
  return t(message);
}
