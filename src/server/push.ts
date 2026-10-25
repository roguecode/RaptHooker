import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import webpush from 'web-push';
import type { Store } from './db.js';
import type { Logger } from './log.js';

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** Loads the VAPID keys from the data folder, creating them on first run. */
export function loadVapidKeys(dataDir: string): VapidKeys {
  const file = join(dataDir, 'vapid.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as VapidKeys;
  const keys = webpush.generateVAPIDKeys();
  writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}

export interface PushSubscriptionJson {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

export function isPushSubscription(x: unknown): x is PushSubscriptionJson {
  const s = x as PushSubscriptionJson;
  return (
    !!s &&
    typeof s.endpoint === 'string' &&
    /^https:\/\//.test(s.endpoint) &&
    typeof s.keys?.p256dh === 'string' &&
    typeof s.keys?.auth === 'string'
  );
}

export interface PushMessage {
  title: string;
  body: string;
  tag?: string;
  url?: string;
}

export interface Notifier {
  send(message: PushMessage): Promise<void>;
}

export class PushService implements Notifier {
  constructor(
    private readonly store: Store,
    private readonly keys: VapidKeys,
    private readonly subject: string,
    private readonly log: Logger,
  ) {}

  get publicKey(): string {
    return this.keys.publicKey;
  }

  subscribe(sub: PushSubscriptionJson, user: string): void {
    this.store.savePushSub(sub.endpoint, JSON.stringify(sub), user, Date.now());
  }

  unsubscribe(endpoint: string): void {
    this.store.deletePushSub(endpoint);
  }

  async send(message: PushMessage): Promise<void> {
    const body = JSON.stringify(message);
    await Promise.all(
      this.store.listPushSubs().map(async ({ endpoint, json }) => {
        try {
          await webpush.sendNotification(JSON.parse(json) as PushSubscriptionJson, body, {
            vapidDetails: { subject: this.subject, publicKey: this.keys.publicKey, privateKey: this.keys.privateKey },
            TTL: 6 * 3600,
            urgency: 'high',
          });
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            this.store.deletePushSub(endpoint);
            this.log.info('removed an expired push subscription');
          } else {
            this.log.warn({ status, err: (err as Error).message }, 'push delivery failed');
          }
        }
      }),
    );
  }
}
