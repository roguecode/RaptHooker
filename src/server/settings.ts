import { EventEmitter } from 'node:events';
import {
  DEFAULT_BACKUP_SETTINGS,
  DEFAULT_HUB_SETTINGS,
  DEFAULT_MQTT_SETTINGS,
  type BackupSettings,
  type GravityUnit,
  type HubSettings,
  type MqttSettings,
  type TemperatureUnit,
} from '@rapthooker/shared';
import type { Store } from './db.js';

export interface NotificationUnits {
  temperature: TemperatureUnit;
  gravity: GravityUnit;
}

/**
 * Hub-wide settings kept in the database. Emits 'hub' (HubSettings), 'mqtt' (MqttSettings) and 'backups'
 * (BackupSettings) when they change.
 */
export class Settings extends EventEmitter {
  constructor(private readonly store: Store) {
    super();
  }

  private read<T extends object>(key: string, defaults: T): T {
    const raw = this.store.getMeta(key);
    if (!raw) return structuredClone(defaults);
    try {
      return mergeDefaults(defaults, JSON.parse(raw) as Partial<T>);
    } catch {
      return structuredClone(defaults);
    }
  }

  hub(): HubSettings {
    const hub = this.read('hub', DEFAULT_HUB_SETTINGS);
    // Before hub settings existed, the notification units were kept on their own.
    const legacy = this.store.getMeta('units');
    if (!this.store.getMeta('hub') && legacy) hub.units = JSON.parse(legacy) as NotificationUnits;
    return hub;
  }

  setHub(hub: HubSettings): HubSettings {
    this.store.setMeta('hub', JSON.stringify(hub));
    this.emit('hub', hub);
    return hub;
  }

  /** Units for notifications, and for browsers that haven't picked their own. */
  units(): NotificationUnits {
    return this.hub().units;
  }

  setUnits(units: NotificationUnits): void {
    this.setHub({ ...this.hub(), units });
  }

  mqtt(): MqttSettings {
    return this.read('mqtt', DEFAULT_MQTT_SETTINGS);
  }

  setMqtt(mqtt: MqttSettings): MqttSettings {
    this.store.setMeta('mqtt', JSON.stringify(mqtt));
    this.emit('mqtt', mqtt);
    return mqtt;
  }

  backups(): BackupSettings {
    return this.read('backups', DEFAULT_BACKUP_SETTINGS);
  }

  setBackups(backups: BackupSettings): BackupSettings {
    this.store.setMeta('backups', JSON.stringify(backups));
    this.emit('backups', backups);
    return backups;
  }
}

/** Saved settings over the defaults, one level of nesting deep (so new fields get their default). */
function mergeDefaults<T extends object>(defaults: T, saved: Partial<T>): T {
  const out = structuredClone(defaults) as Record<string, unknown>;
  for (const [k, v] of Object.entries(saved)) {
    const d = out[k];
    out[k] = d && typeof d === 'object' && !Array.isArray(d) && v && typeof v === 'object' ? { ...d, ...v } : v;
  }
  return out as T;
}

/** Hides secrets from someone who isn't the owner. */
export function maskMqtt(m: MqttSettings): MqttSettings {
  return { ...m, password: m.password ? '••••••' : '' };
}

export function maskBackups(b: BackupSettings): BackupSettings {
  return { ...b, s3: { ...b.s3, secretAccessKey: b.s3.secretAccessKey ? '••••••' : '' } };
}

/** The placeholder a masked secret is sent back as: keep the saved value. */
export const MASKED = '••••••';
