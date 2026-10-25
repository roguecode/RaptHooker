import { mqttSettingsSchema, type MqttSettings, type MqttStatus } from '@rapthooker/shared';
import { MASKED, maskMqtt } from '../settings.js';
import type { RouteContext } from './context.js';

export interface MqttTestResult {
  ok: boolean;
  error: string | null;
}

const badRequest = (message: string): Error => Object.assign(new Error(message), { statusCode: 400 });

/** MQTT settings (owner only, password hidden), a connection test, and the connection status (anyone). */
export function mqttRoutes({ app, s, owner }: RouteContext): void {
  const { settings, mqtt } = s;

  /** The masked password sent back means "keep the saved one". */
  const withSavedPassword = (input: MqttSettings): MqttSettings =>
    input.password === MASKED ? { ...input, password: settings.mqtt().password } : input;

  app.get('/api/mqtt/status', async (): Promise<MqttStatus> => mqtt.status);

  app.get('/api/settings/mqtt', owner, async (): Promise<MqttSettings> => maskMqtt(settings.mqtt()));

  app.put('/api/settings/mqtt', owner, async (req): Promise<MqttSettings> => {
    const input = withSavedPassword(mqttSettingsSchema.parse(req.body));
    if (input.enabled && !input.url) throw badRequest('Enter the broker address, or switch MQTT off');
    if (input.password && !input.username) throw badRequest('Enter the username too: MQTT only sends a password along with a username');
    // Saving emits 'mqtt', which the MQTT service listens for to reconnect.
    return maskMqtt(settings.setMqtt(input));
  });

  app.post('/api/settings/mqtt/test', owner, async (req): Promise<MqttTestResult> => {
    const input = withSavedPassword(mqttSettingsSchema.parse(req.body));
    if (!input.url) throw badRequest('Enter the broker address first');
    try {
      await mqtt.test(input);
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
