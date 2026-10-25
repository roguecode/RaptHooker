import type { ChannelInput, ChannelKind } from './types.js';

/** One setting of a notification channel, for the editor form and the server's checks. */
export interface ChannelField {
  key: string;
  label: string;
  /** How it's typed in. 'password' hides what's typed. */
  input: 'text' | 'password' | 'url' | 'number' | 'select';
  /** A key, token, password or private address: hidden from viewers and kept out of error messages and logs. */
  secret?: boolean;
  /** Viewers can see it. Every other value is hidden from people who aren't the owner. */
  public?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
  /** Used when the field is left empty. */
  default?: string;
  options?: { value: string; label: string }[];
}

export interface ChannelKindInfo {
  kind: ChannelKind;
  label: string;
  /** One line under the name in the picker. */
  tagline: string;
  /** Setup, a few short steps. */
  steps: string[];
  links: { label: string; url: string }[];
  fields: ChannelField[];
}

export const CHANNEL_KINDS: ChannelKindInfo[] = [
  {
    kind: 'ntfy',
    label: 'ntfy',
    tagline: 'Free push notifications through the ntfy app, no account needed',
    steps: [
      'Install the ntfy app on your phone, or open ntfy.sh in a browser.',
      'Pick a topic name that is hard to guess (anyone who knows it can read your alerts) and subscribe to it in the app.',
      'Type the same topic here and send a test.',
    ],
    links: [
      { label: 'Get the ntfy app', url: 'https://ntfy.sh/' },
      { label: 'ntfy publishing docs', url: 'https://docs.ntfy.sh/publish/' },
    ],
    fields: [
      {
        key: 'server',
        label: 'Server',
        input: 'url',
        public: true,
        default: 'https://ntfy.sh',
        placeholder: 'https://ntfy.sh',
        help: 'Only change it if you run your own ntfy server.',
      },
      {
        key: 'topic',
        label: 'Topic',
        input: 'text',
        secret: true,
        required: true,
        placeholder: 'rapthooker-k7p2x9',
        help: 'Letters, numbers, - and _. Anyone who knows it can read your alerts, so make it hard to guess.',
      },
      {
        key: 'token',
        label: 'Access token',
        input: 'password',
        secret: true,
        placeholder: 'tk_…',
        help: 'Only for protected topics. Or use a username and password instead.',
      },
      { key: 'username', label: 'Username', input: 'text', placeholder: 'Optional' },
      { key: 'password', label: 'Password', input: 'password', secret: true, placeholder: 'Optional' },
    ],
  },
  {
    kind: 'pushover',
    label: 'Pushover',
    tagline: 'Reliable alerts on iPhone, Android and desktop (one-off app purchase)',
    steps: [
      'Sign up at pushover.net and install the Pushover app. Your user key is on the Pushover dashboard.',
      'Create an application (call it RaptHooker) and copy its API token.',
      'Paste both here and send a test.',
    ],
    links: [
      { label: 'Create a Pushover application', url: 'https://pushover.net/apps/build' },
      { label: 'Pushover API docs', url: 'https://pushover.net/api' },
    ],
    fields: [
      {
        key: 'token',
        label: 'API token',
        input: 'password',
        secret: true,
        required: true,
        placeholder: '30 letters and numbers',
        help: "From your application's page on pushover.net.",
      },
      {
        key: 'user',
        label: 'User key',
        input: 'password',
        secret: true,
        required: true,
        placeholder: '30 letters and numbers',
        help: 'On your Pushover dashboard (or a group key).',
      },
      { key: 'device', label: 'Device', input: 'text', placeholder: 'Optional', help: 'Leave empty to send to all your devices.' },
    ],
  },
  {
    kind: 'telegram',
    label: 'Telegram',
    tagline: 'Messages from your own Telegram bot',
    steps: [
      'In Telegram, talk to @BotFather: send /newbot and follow the steps. Copy the bot token it gives you.',
      'Open a chat with your new bot and send it any message (or add the bot to a group).',
      'In a browser, open api.telegram.org/bot<your token>/getUpdates and copy the number after "chat":{"id":',
      'Paste the token and chat ID here and send a test.',
    ],
    links: [
      { label: 'Talk to @BotFather', url: 'https://t.me/BotFather' },
      { label: 'Telegram bot tutorial', url: 'https://core.telegram.org/bots/tutorial' },
    ],
    fields: [
      {
        key: 'botToken',
        label: 'Bot token',
        input: 'password',
        secret: true,
        required: true,
        placeholder: '123456789:AAE…',
        help: 'From @BotFather.',
      },
      {
        key: 'chatId',
        label: 'Chat ID',
        input: 'text',
        required: true,
        placeholder: '123456789',
        help: 'A number (group chats start with -), or @name for a public channel.',
      },
    ],
  },
  {
    kind: 'discord',
    label: 'Discord',
    tagline: 'Posts in a channel on your Discord server',
    steps: [
      'In Discord: Server Settings → Integrations → Webhooks → New Webhook.',
      'Pick the channel it posts to, then Copy Webhook URL.',
      'Paste it here and send a test.',
    ],
    links: [{ label: 'Intro to Discord webhooks', url: 'https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks' }],
    fields: [
      {
        key: 'url',
        label: 'Webhook URL',
        input: 'url',
        secret: true,
        required: true,
        placeholder: 'https://discord.com/api/webhooks/…',
        help: 'Anyone with this URL can post to the channel, so keep it to yourself.',
      },
    ],
  },
  {
    kind: 'email',
    label: 'Email',
    tagline: "Through your mail provider's SMTP server",
    steps: [
      "Look up your mail provider's SMTP settings: server, port and security.",
      'Gmail, Outlook and most others want an app password here, not your normal password.',
      'Fill them in and send a test.',
    ],
    links: [
      { label: 'Gmail app passwords', url: 'https://support.google.com/accounts/answer/185833' },
      { label: 'Nodemailer SMTP options', url: 'https://nodemailer.com/smtp/' },
    ],
    fields: [
      { key: 'host', label: 'SMTP server', input: 'text', public: true, required: true, placeholder: 'smtp.example.com' },
      { key: 'port', label: 'Port', input: 'number', public: true, default: '587', placeholder: '587' },
      {
        key: 'security',
        label: 'Security',
        input: 'select',
        public: true,
        default: 'starttls',
        options: [
          { value: 'starttls', label: 'STARTTLS (usually port 587)' },
          { value: 'tls', label: 'TLS (usually port 465)' },
          { value: 'none', label: 'None (only on your own network)' },
        ],
      },
      {
        key: 'username',
        label: 'Username',
        input: 'text',
        placeholder: 'you@example.com',
        help: 'Leave empty if the server needs no login.',
      },
      { key: 'password', label: 'Password', input: 'password', secret: true, placeholder: 'App password' },
      {
        key: 'from',
        label: 'Sender',
        input: 'text',
        required: true,
        placeholder: 'RaptHooker <you@example.com>',
        help: 'Most providers only accept your own address here.',
      },
      {
        key: 'to',
        label: 'Send to',
        input: 'text',
        required: true,
        placeholder: 'you@example.com',
        help: 'Separate several addresses with commas.',
      },
    ],
  },
];

export const channelKindInfo = (kind: ChannelKind): ChannelKindInfo => CHANNEL_KINDS.find((k) => k.kind === kind) ?? CHANNEL_KINDS[0]!;

/** The kind's settings only, tidied up, with defaults for empty fields. Passwords are kept exactly as typed. */
export function normalizeChannelConfig(kind: ChannelKind, config: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of channelKindInfo(kind).fields) {
    const raw = config[f.key] ?? '';
    const value = f.input === 'password' ? raw : f.input === 'url' ? raw.trim().replace(/\/+$/, '') : raw.trim();
    out[f.key] = value === '' ? (f.default ?? '') : value;
  }
  return out;
}

const DISCORD_WEBHOOK = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+\/?$/;

const isHttpUrl = (value: string): boolean => /^https?:\/\/[^\s/?#@]+(?:[/?#][^\s]*)?$/i.test(value);

/** Email addresses in a comma-separated list, with or without a display name. */
export const emailList = (value: string): string[] =>
  value
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);

const looksLikeEmail = (value: string): boolean => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(/<([^>]*)>\s*$/.exec(value)?.[1] ?? value);

/**
 * What's missing or wrong in a channel's settings, by field key, as short sentences. Empty when it's ready to send.
 */
export function channelFieldProblems(input: Pick<ChannelInput, 'kind' | 'config'>): Record<string, string> {
  const info = channelKindInfo(input.kind);
  const c = normalizeChannelConfig(input.kind, input.config);
  const problems: Record<string, string> = {};
  for (const f of info.fields) if (f.required && !c[f.key]) problems[f.key] = `Fill in ${f.label}`;
  const bad = (key: string, ok: boolean, message: string) => {
    if (c[key] && !ok && !problems[key]) problems[key] = message;
  };
  switch (input.kind) {
    case 'ntfy':
      bad('server', isHttpUrl(c.server ?? ''), 'Server must be a web address starting with https://');
      bad('topic', /^[-_A-Za-z0-9]{1,64}$/.test(c.topic ?? ''), 'Topic can only use letters, numbers, - and _ (up to 64)');
      if (c.username && !c.password) problems.password = 'Fill in Password to go with the username';
      if (c.password && !c.username) problems.username = 'Fill in Username to go with the password';
      break;
    case 'pushover':
      bad('token', /^[A-Za-z0-9]{30}$/.test(c.token ?? ''), 'API token should be 30 letters and numbers');
      bad('user', /^[A-Za-z0-9]{30}$/.test(c.user ?? ''), 'User key should be 30 letters and numbers');
      bad('device', /^[A-Za-z0-9_-]{1,25}(,[A-Za-z0-9_-]{1,25})*$/.test(c.device ?? ''), 'Device should be a device name from Pushover');
      break;
    case 'telegram':
      bad('botToken', /^\d+:[A-Za-z0-9_-]+$/.test(c.botToken ?? ''), 'Bot token should look like 123456789:AAE…');
      bad('chatId', /^(-?\d+|@[A-Za-z0-9_]{4,})$/.test(c.chatId ?? ''), 'Chat ID should be a number (or @name for a public channel)');
      break;
    case 'discord':
      bad('url', DISCORD_WEBHOOK.test(c.url ?? ''), 'Webhook URL should start with https://discord.com/api/webhooks/');
      break;
    case 'email': {
      const port = Number(c.port);
      bad('port', Number.isInteger(port) && port > 0 && port < 65536, 'Port should be a number like 587 or 465');
      bad('security', ['starttls', 'tls', 'none'].includes(c.security ?? ''), 'Pick a Security option');
      bad('from', looksLikeEmail(c.from ?? ''), 'From should be an email address');
      bad('to', emailList(c.to ?? '').every(looksLikeEmail), 'To should be email addresses separated by commas');
      if (c.password && !c.username) problems.username = 'Fill in Username to go with the password';
      break;
    }
  }
  return problems;
}

/** What's missing or wrong in a channel's settings, as sentences. Empty when it's ready to send. */
export const channelProblems = (input: Pick<ChannelInput, 'kind' | 'config'>): string[] => Object.values(channelFieldProblems(input));
