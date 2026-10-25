import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { BackupTargetStatus, BleStatus, DiskStatus, HubStatus, HubWarning, MqttStatus } from '@rapthooker/shared';
import { api } from '../../api';
import { bytes, dateTime, duration, timeAgo, useNow } from '../../format';
import { useLive } from '../../live';
import { t, tk, tp } from '../../i18n';
import { Icon } from '../../components/Icon';
import './StatusSection.css';

const DISMISSED_KEY = 'rapthooker.dismissedWarnings';
/** A dismissed warning comes back after this long if it still applies. */
const DISMISS_MS = 7 * 86_400_000;

// i18n: the Bluetooth scanner's state and scan mode, shown in lower case after "Bluetooth"
const BLE_STATE: Record<BleStatus['state'], string> = {
  starting: tk('starting'),
  scanning: tk('scanning'),
  error: tk('error'),
  unavailable: tk('unavailable'),
  mock: tk('mock'),
};
const SCAN_MODE: Record<NonNullable<BleStatus['mode']>, string> = { passive: tk('passive'), active: tk('active') };

function loadDismissed(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '{}') as Record<string, number>;
    const now = Date.now();
    return Object.fromEntries(Object.entries(raw).filter(([, at]) => typeof at === 'number' && now - at < DISMISS_MS));
  } catch {
    return {};
  }
}

function saveDismissed(d: Record<string, number>): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(d));
  } catch {
    // Private browsing: they just won't be remembered.
  }
}

/** Shows `commands` in backticks as code. */
function withCode(text: string): ReactNode[] {
  return text.split(/`([^`]+)`/).map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));
}

export function StatusSection() {
  const { isOwner } = useLive();
  const [status, setStatus] = useState<HubStatus | null>(null);
  const [dismissed, setDismissed] = useState(loadDismissed);
  const now = useNow(30_000);
  const load = useCallback(() => {
    api.status().then(setStatus, () => undefined);
  }, []);
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);
  if (!status) return null;

  const dismiss = (id: string) => {
    const next = { ...dismissed, [id]: Date.now() };
    setDismissed(next);
    saveDismissed(next);
  };
  const showAll = () => {
    setDismissed({});
    saveDismissed({});
  };
  const shown = status.warnings.filter((w) => w.level === 'error' || !dismissed[w.id]);
  const hidden = status.warnings.length - shown.length;
  const ble = status.ble;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          <Icon name="cpu" /> {t('Hub status')}
        </h2>
        <button type="button" className="btn small ghost" onClick={load}>
          <Icon name="refresh" size={14} /> {t('Refresh')}
        </button>
      </div>
      {(shown.length > 0 || hidden > 0) && (
        <div className="status-warnings">
          {shown.map((w) => (
            <Warning key={w.id} warning={w} onDismiss={w.level === 'error' ? undefined : () => dismiss(w.id)} />
          ))}
          {hidden > 0 && (
            <button type="button" className="btn small ghost status-show-hidden" onClick={showAll}>
              {tp(hidden, 'Show {count} hidden warning', 'Show {count} hidden warnings')}
            </button>
          )}
        </div>
      )}
      <dl className="kv">
        <dt>{t('Version')}</dt>
        <dd>RaptHooker {status.version}</dd>
        <dt>{t('Running for')}</dt>
        <dd>{duration(status.now - status.startedAt)}</dd>
        <dt>{t('Bluetooth')}</dt>
        <dd>
          {t(BLE_STATE[ble.state] ?? ble.state)}
          {bleDetails(ble) && (
            <span title={ble.mode === 'passive' ? t('Passive: only listens for RAPT broadcasts, which is kinder to the Wi-Fi') : undefined}>
              {` (${bleDetails(ble)})`}
            </span>
          )}
          {ble.error ? `: ${ble.error}` : ''}
          {ble.lastAdvertAt ? ` · ${t('last pill heard {ago}', { ago: timeAgo(ble.lastAdvertAt, now) })}` : ''}
        </dd>
        <dt>{t('Clock')}</dt>
        <dd>{status.clockSynced ? t('Synced') : t('Waiting for network time (readings are held until then)')}</dd>
        <dt>{t('Storage')}</dt>
        <dd>{status.disk ? <Disk disk={status.disk} /> : t('Unknown')}</dd>
        <dt>{t('Database')}</dt>
        <dd>
          {bytes(status.dbSizeBytes)} · {tp(status.readings, '{count} reading', '{count} readings')}
        </dd>
        <dt>{t('Backups')}</dt>
        <dd>{backupsText(status, now)}</dd>
        <dt>MQTT</dt>
        <dd>{mqttText(status.mqtt, now, isOwner)}</dd>
        <dt>{t('Runtime')}</dt>
        <dd>{t('Node {version} on {platform}', { version: status.node, platform: status.platform })}</dd>
      </dl>
    </section>
  );
}

const WARNING_STYLE: Record<HubWarning['level'], { notice: string; icon: 'alert' | 'info' }> = {
  error: { notice: 'notice danger', icon: 'alert' },
  warn: { notice: 'notice warning', icon: 'alert' },
  info: { notice: 'notice', icon: 'info' },
};

function Warning({ warning, onDismiss }: { warning: HubWarning; onDismiss?: () => void }) {
  const style = WARNING_STYLE[warning.level];
  return (
    <div className={style.notice} role={warning.level === 'error' ? 'alert' : undefined}>
      <Icon name={style.icon} size={18} />
      <p className="grow">{withCode(warning.message)}</p>
      {onDismiss && (
        <button
          type="button"
          className="icon-btn"
          onClick={onDismiss}
          aria-label={t('Hide this warning for a week')}
          title={t('Hide for a week')}
        >
          <Icon name="x" size={16} />
        </button>
      )}
    </div>
  );
}

function Disk({ disk }: { disk: DiskStatus }) {
  const used = disk.totalBytes > 0 ? Math.min(1, Math.max(0, 1 - disk.freeBytes / disk.totalBytes)) : 0;
  const tone = disk.freeBytes < 100 * 1024 ** 2 ? ' danger' : disk.freeBytes < 500 * 1024 ** 2 ? ' warn' : '';
  return (
    <div className="status-disk">
      <div className={`bar${tone}`} role="img" aria-label={t('{percent}% used', { percent: Math.round(used * 100) })}>
        <i style={{ width: `${used * 100}%` }} />
      </div>
      <span>
        {t('{free} free of {total}', { free: bytes(disk.freeBytes), total: bytes(disk.totalBytes) })} ·{' '}
        {t("RaptHooker's data {size}", { size: bytes(disk.dataBytes) })}
      </span>
    </div>
  );
}

/** "hci0, passive": the adapters in use and the scan mode. */
function bleDetails(ble: BleStatus): string {
  const adapters = ble.adapters.length ? ble.adapters : ble.adapter ? [ble.adapter] : [];
  return [...adapters, ...(ble.mode ? [t(SCAN_MODE[ble.mode] ?? ble.mode)] : [])].join(', ');
}

const TARGET_LABEL: Record<BackupTargetStatus['target'], string> = { local: tk('On the hub'), usb: tk('USB stick'), s3: tk('Cloud') };

function backupsText(status: HubStatus, now: number): string {
  const targets = status.backups ?? [];
  if (!targets.length)
    return status.lastBackup ? t('Last {date}', { date: dateTime(status.lastBackup.at) }) : (status.backupError ?? t('None yet'));
  return targets
    .map((b) => {
      const what =
        b.ok === true
          ? t('done {ago}', { ago: timeAgo(b.at, now) })
          : b.ok === false
            ? /\boff\b/i.test(b.error ?? '')
              ? t('off')
              : b.error
                ? t('failed ({error})', { error: b.error.replace(/^Backup failed:\s*/i, '') })
                : t('failed')
            : t('none yet');
      return `${TARGET_LABEL[b.target] ? t(TARGET_LABEL[b.target]) : b.target}: ${what}`;
    })
    .join(' · ');
}

function mqttText(mqtt: MqttStatus, now: number, isOwner: boolean): string {
  switch (mqtt.state) {
    case 'off':
      return t('Off');
    case 'connecting':
      return t('Connecting…');
    case 'connected':
      return mqtt.lastPublishAt ? `${t('Connected')} · ${t('last sent {ago}', { ago: timeAgo(mqtt.lastPublishAt, now) })}` : t('Connected');
    case 'error':
      return isOwner && mqtt.error ? `${t('Not connected')}: ${mqtt.error}` : t('Not connected');
  }
}
