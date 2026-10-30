import { z } from 'zod';

/** Request bodies and queries the API accepts. The web app checks its forms against the same schemas before sending. */

export const SG_LIMITS = { min: 0.95, max: 1.2 } as const;

export const sgSchema = z.number().min(SG_LIMITS.min).max(SG_LIMITS.max);
export const pillColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i, 'A colour like #a78bfa');
export const pillIdsSchema = z.union([z.literal('all'), z.array(z.string().min(1).max(64)).max(200)]);

// Session

export const loginSchema = z.object({ pin: z.string().max(64) });

export const ownerPinSchema = z.object({ pin: z.string().max(64), currentPin: z.string().max(64).optional() });

// Pills

export const adoptPillSchema = z.object({
  address: z.string().min(11).max(17),
  name: z.string().trim().max(60).optional(),
  color: pillColorSchema.optional(),
});

export const tiltPointSchema = z.object({
  tilt: z.number().min(0).max(90),
  sg: sgSchema,
  at: z.number().int().nonnegative(),
});

export const pillModelSchema = z.object({
  gravitySource: z.enum(['pill', 'tilt']),
  tiltPoints: z.array(tiltPointSchema).max(20),
  velocitySource: z.enum(['pill', 'computed']),
  velocityHours: z.number().int().min(6).max(72),
  smoothing: z.enum(['off', 'light', 'strong']),
});

export const pillPatchSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  color: pillColorSchema.optional(),
  offsets: z.object({ gravity: z.number().min(-0.05).max(0.05), temperature: z.number().min(-10).max(10) }).optional(),
  archived: z.boolean().optional(),
  model: pillModelSchema.partial().optional(),
  order: z.number().int().min(0).max(10_000).optional(),
});

export const pillOrderSchema = z.object({ ids: z.array(z.string().min(1).max(64)).max(200) });

/** A range of a device's history to leave out of its charts. */
export const chartExclusionSchema = z
  .object({ from: z.number().int().positive(), to: z.number().int().positive() })
  .refine((e) => e.to > e.from, { message: '"to" must be after "from"', path: ['to'] });

/** An advert heard by a Bluetooth relay (e.g. an ESP32 running ESPHome). */
export const relayAdvertSchema = z.object({
  address: z.string().regex(/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/, 'A Bluetooth address like AA:BB:CC:DD:EE:FF'),
  rssi: z.number().int().min(-127).max(20).nullable().default(null),
  /** Company id → manufacturer data (hex, without the company id). */
  manufacturerData: z.record(
    z.string().regex(/^\d+$/),
    z
      .string()
      .regex(/^([0-9A-Fa-f]{2})*$/)
      .max(64),
  ),
  /** How long ago the relay heard it, in ms, when it sends adverts in batches. */
  ageMs: z.number().int().min(0).max(300_000).optional(),
});

export const relayBodySchema = z.object({
  relay: z.string().trim().min(1).max(60).default('relay'),
  adverts: z.array(relayAdvertSchema).min(1).max(50),
});

export const nearbyIgnoreSchema = z.object({ address: z.string().min(11).max(17), ignored: z.boolean().default(true) });

export const historyQuerySchema = z.object({
  from: z.coerce.number().int(),
  to: z.coerce.number().int(),
  points: z.coerce.number().int().min(10).max(4000).default(800),
  /** "1": leave out the pill's excluded ranges (as its charts do). */
  exclude: z.enum(['0', '1']).default('0'),
});

export const csvExportQuerySchema = z.object({ from: z.coerce.number().int().default(0), to: z.coerce.number().int().optional() });

// Brews

export const brewFields = {
  name: z.string().trim().min(1).max(100),
  style: z.string().trim().max(100),
  notes: z.string().max(5000),
  og: sgSchema.nullable(),
  targetFg: sgSchema.nullable(),
};

export const brewListQuerySchema = z.object({ pill: z.string().optional() });

export const startBrewSchema = z.object({
  pillId: z.string().min(1),
  name: brewFields.name,
  style: brewFields.style.default(''),
  notes: brewFields.notes.default(''),
  og: brewFields.og.default(null),
  targetFg: brewFields.targetFg.default(null),
  startedAt: z.number().int().positive().optional(),
});

export const brewPatchSchema = z.object({
  name: brewFields.name.optional(),
  style: brewFields.style.optional(),
  notes: brewFields.notes.optional(),
  og: brewFields.og.optional(),
  targetFg: brewFields.targetFg.optional(),
  startedAt: z.number().int().positive().optional(),
  endedAt: z.number().int().positive().nullable().optional(),
});

export const endBrewSchema = z.object({ endedAt: z.number().int().positive().optional() });

export const brewEventInputSchema = z.object({
  at: z.number().int().positive(),
  kind: z.enum(['dry_hop', 'temp_change', 'cold_crash', 'addition', 'note']),
  text: z.string().trim().max(500).default(''),
});

export const brewCompareQuerySchema = z.object({
  ids: z
    .string()
    .transform((s) => s.split(',').filter(Boolean))
    .pipe(z.array(z.string().min(1).max(64)).min(1).max(8)),
});

// Webhooks

export const webhookInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  preset: z.string().max(40).default('custom'),
  url: z.string().trim().min(1).max(2000),
  method: z.enum(['POST', 'PUT', 'PATCH', 'GET']).default('POST'),
  headers: z
    .array(
      z.object({
        name: z
          .string()
          .trim()
          .max(200)
          .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]*$/, 'Header names can only use letters, digits and -'),
        value: z.string().max(4000),
      }),
    )
    .max(30)
    .default([]),
  bodyFormat: z.enum(['json', 'form', 'text', 'none']).default('json'),
  body: z.string().max(20_000).default(''),
  intervalMin: z.number().min(1).max(10_080).default(15),
  pillIds: pillIdsSchema.default('all'),
  onlyDuringBrew: z.boolean().default(false),
  onlyNewReadings: z.boolean().default(true),
  gravityUnit: z.enum(['sg', 'plato']).default('sg'),
  temperatureUnit: z.enum(['C', 'F']).default('C'),
  timeoutSec: z.number().int().min(1).max(60).default(15),
  skipImplausible: z.boolean().default(true),
  batch: z.boolean().default(false),
  batchBody: z.string().max(20_000).default(''),
  minChangeGravity: z.number().min(0).max(100).nullable().default(null),
  minChangeTemp: z.number().min(0).max(50).nullable().default(null),
  maxSilenceMin: z.number().min(1).max(10_080).nullable().default(null),
  pausedUntil: z.number().int().positive().nullable().default(null),
  catchUp: z.boolean().default(false),
});

export const webhookImportSchema = z.object({
  app: z.literal('rapthooker'),
  kind: z.literal('webhooks'),
  version: z.literal(1),
  webhooks: z.array(webhookInputSchema).max(500),
});

export const webhookPauseSchema = z.object({ until: z.number().int().positive().nullable() });

export const webhookEnabledSchema = z.object({ enabled: z.boolean() });

export const deliveriesQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

export const webhookTestSchema = z.object({
  webhook: webhookInputSchema,
  webhookId: z.string().nullable().default(null),
  pillId: z.string().nullable().default(null),
});

// Alerts

export const alertInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  pillIds: pillIdsSchema.default('all'),
  kind: z.enum(['temp_above', 'temp_below', 'gravity_below', 'gravity_stable', 'battery_below', 'offline']),
  threshold: z.number().finite(),
  hours: z
    .number()
    .min(1)
    .max(24 * 14)
    .default(48),
  onlyDuringBrew: z.boolean().default(false),
  cooldownMin: z.number().int().min(0).max(10_080).default(60),
  channelIds: z.union([z.literal('all'), z.array(z.string().min(1).max(64)).max(50)]).default('all'),
});

export const alertEventsQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) });

// Notification channels

export const channelInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['ntfy', 'pushover', 'telegram', 'discord', 'email']),
  enabled: z.boolean().default(true),
  config: z.record(z.string().max(64), z.string().max(2000)).default({}),
});

// API tokens

export const tokenInputSchema = z.object({ name: z.string().trim().min(1).max(60), scope: z.enum(['read', 'relay']) });

// Push notifications

export const pushUnsubscribeSchema = z.object({ endpoint: z.string().url() });

// Settings

export const settingsBodySchema = z.object({
  units: z.object({ temperature: z.enum(['C', 'F']), gravity: z.enum(['sg', 'plato']) }),
});

export const hubSettingsSchema = z.object({
  name: z.string().trim().min(1).max(40),
  units: z.object({ temperature: z.enum(['C', 'F']), gravity: z.enum(['sg', 'plato']) }),
  abvFormula: z.enum(['standard', 'alternative']),
  updateCheck: z.boolean(),
});

export const mqttSettingsSchema = z.object({
  enabled: z.boolean(),
  url: z
    .string()
    .trim()
    .max(500)
    .regex(/^$|^(mqtts?|wss?):\/\/\S+$/, 'A broker address like mqtt://homeassistant.local:1883'),
  username: z.string().max(200),
  password: z.string().max(500),
  topic: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[^#+\s]+$/, 'No spaces, # or +'),
  discovery: z.boolean(),
  discoveryPrefix: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[^#+\s]+$/, 'No spaces, # or +'),
  retain: z.boolean(),
  skipImplausible: z.boolean(),
});

export const backupSettingsSchema = z.object({
  usb: z.boolean(),
  s3: z.object({
    enabled: z.boolean(),
    endpoint: z
      .string()
      .trim()
      .max(500)
      .regex(/^$|^https?:\/\/\S+$/, 'A URL like https://s3.eu-west-1.amazonaws.com'),
    region: z.string().trim().max(60),
    bucket: z.string().trim().max(100),
    prefix: z.string().trim().max(200),
    accessKeyId: z.string().trim().max(200),
    secretAccessKey: z.string().max(500),
    pathStyle: z.boolean(),
  }),
  weeklyCsv: z.boolean(),
});

export type AdoptPillBody = z.input<typeof adoptPillSchema>;
export type PillPatchBody = z.input<typeof pillPatchSchema>;
export type HistoryQuery = z.output<typeof historyQuerySchema>;
export type StartBrewBody = z.input<typeof startBrewSchema>;
export type BrewPatchBody = z.input<typeof brewPatchSchema>;
export type SettingsBody = z.input<typeof settingsBodySchema>;

// Checking forms

/** First problem for each field, keyed by its path ("name", "headers.0.value"). Empty when the input is fine. */
export type FieldErrors = Partial<Record<string, string>>;

/** Plainer wording for the web forms. Messages set on a schema win, and the API keeps zod's own wording. */
export const formErrorMap: z.core.$ZodErrorMap = (iss) => {
  switch (iss.code) {
    case 'invalid_type':
      if (iss.input === undefined || iss.input === null) return 'Required';
      if (iss.expected === 'int') return 'Use a whole number';
      return iss.expected === 'number' ? 'Enter a number' : undefined;
    case 'too_small': {
      const min = Number(iss.minimum);
      if (iss.origin === 'string') return min <= 1 ? 'Required' : `Use at least ${min} characters`;
      if (iss.origin === 'number' || iss.origin === 'int')
        return iss.inclusive === false ? `Must be more than ${min}` : `Must be at least ${min}`;
      return undefined;
    }
    case 'too_big': {
      const max = Number(iss.maximum);
      if (iss.origin === 'string') return `Use at most ${max} characters`;
      if (iss.origin === 'number' || iss.origin === 'int')
        return iss.inclusive === false ? `Must be less than ${max}` : `Must be at most ${max}`;
      if (iss.origin === 'array') return `No more than ${max}`;
      return undefined;
    }
    case 'invalid_value':
      return 'Pick one of the options';
    case 'invalid_format':
      return iss.format === 'url' ? 'Enter a full URL' : undefined;
    default:
      return undefined;
  }
};

/** Turns a zod problem into a message (or undefined for zod's own). */
export type FormErrorMap = z.core.$ZodErrorMap;

/** Checks a payload the way the API will, with `formErrorMap` wording (or another map's, e.g. translated). */
export function checkInput(schema: z.ZodType, value: unknown, errorMap: FormErrorMap = formErrorMap): FieldErrors {
  const result = schema.safeParse(value, { error: errorMap });
  if (result.success) return {};
  const errors: FieldErrors = {};
  for (const issue of result.error.issues) errors[issue.path.join('.')] ??= issue.message;
  return errors;
}
