import { useCallback, useEffect, useState } from 'react';
import {
  backupSettingsSchema,
  DEFAULT_BACKUP_SETTINGS,
  type BackupFile,
  type BackupOverview,
  type BackupSettings,
  type BackupTarget,
  type BackupTargetStatus,
  type HubStatus,
  type RestoreResult,
  type S3Settings,
} from '@rapthooker/shared';
import { errorText, http } from '../../api';
import { useLive } from '../../live';
import { bytes, dateTime, timeAgo, useNow } from '../../format';
import { t, tk, tp } from '../../i18n';
import { Trans } from '../../i18n/Trans';
import { Icon, type IconName } from '../../components/Icon';
import { Modal, OwnerOnly, Switch } from '../../components/ui';
import { FieldError, useFormCheck } from '../../validation';
import './BackupSection.css';

const DOCS_URL = 'https://github.com/roguecode/RaptHooker/blob/main/docs/backups.md';
/** The same limit as the server's. */
const RESTORE_LIMIT = 500 * 1024 * 1024;

const TARGETS: Record<BackupTarget, { name: string; icon: IconName }> = {
  local: { name: tk('On the hub'), icon: 'hardDrive' },
  usb: { name: tk('USB stick'), icon: 'download' },
  s3: { name: tk('Cloud storage (S3)'), icon: 'cloud' },
};

const LABELS: Record<string, string> = {
  endpoint: tk('Endpoint'),
  region: tk('Region'),
  bucket: tk('Bucket'),
  prefix: tk('Folder'),
  accessKeyId: tk('Access key ID'),
  secretAccessKey: tk('Secret access key'),
};

/** S3 settings as the API checks them, plus what an upload can't do without. */
const s3Schema = backupSettingsSchema.shape.s3.superRefine((s, ctx) => {
  if (!s.enabled) return;
  if (!s.endpoint.trim() && !s.region.trim())
    ctx.addIssue({ code: 'custom', path: ['endpoint'], message: tk('Enter the endpoint (or a region for AWS)') });
  if (!s.bucket.trim()) ctx.addIssue({ code: 'custom', path: ['bucket'], message: tk('Enter the bucket name') });
  if (!s.accessKeyId.trim()) ctx.addIssue({ code: 'custom', path: ['accessKeyId'], message: tk('Enter the access key ID') });
  if (!s.secretAccessKey) ctx.addIssue({ code: 'custom', path: ['secretAccessKey'], message: tk('Enter the secret access key') });
});

interface S3TestResult {
  ok: boolean;
  error: string | null;
  warning: string | null;
}

function chipFor(s: BackupTargetStatus): { className: string; text: string } {
  if (s.ok === false) return { className: 'chip danger', text: t('Failed') };
  if (s.ok === true) return { className: s.note ? 'chip warning' : 'chip success', text: t('OK') };
  if (s.note) return { className: 'chip', text: s.target === 'usb' ? t('Not plugged in') : t('Waiting') };
  return { className: 'chip', text: t('Not yet') };
}

const fileName = (path: string | null) => (path ? (path.split(/[\\/]/).pop() ?? path) : null);

function TargetList({ targets, now }: { targets: BackupTargetStatus[]; now: number }) {
  return (
    <div className="list backup-targets">
      {targets.map((s) => {
        const chip = chipFor(s);
        return (
          <div key={s.target} className="list-item">
            <span className="backup-icon">
              <Icon name={TARGETS[s.target].icon} />
            </span>
            <div className="grow">
              <h4>{t(TARGETS[s.target].name)}</h4>
              <p title={s.at ? dateTime(s.at) : undefined}>
                {s.at ? t('Last backup {ago}', { ago: timeAgo(s.at, now) }) : t('No backup yet')}
                {s.at && s.file && s.target !== 'local' ? ` · ${s.target === 'usb' ? fileName(s.file) : s.file}` : ''}
              </p>
              {s.error && <p className="backup-error">{s.error}</p>}
              {s.note && <p className="backup-note">{s.note}</p>}
            </div>
            <span className={chip.className}>{chip.text}</span>
          </div>
        );
      })}
    </div>
  );
}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/** Sends a database file as raw bytes, reporting progress (fetch can't report upload progress). */
function uploadBackup(file: File, onProgress: (fraction: number) => void): Promise<RestoreResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/backups/restore');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data: unknown;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as RestoreResult);
      else reject(new Error((data as { error?: string } | undefined)?.error ?? `${xhr.status} ${xhr.statusText}`));
    };
    xhr.onerror = () => reject(new Error(t("The upload didn't get through. Check the connection and try again.")));
    xhr.send(file);
  });
}

type Phase = 'choose' | 'uploading' | 'checking' | 'restarting' | 'manual' | 'done';

function RestoreModal({ files, initial, onClose }: { files: BackupFile[]; initial: string | null; onClose: () => void }) {
  const [source, setSource] = useState<'upload' | 'hub'>(initial ? 'hub' : 'upload');
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState(initial ?? files[0]?.name ?? '');
  const [understood, setUnderstood] = useState(false);
  const [phase, setPhase] = useState<Phase>('choose');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<RestoreResult | null>(null);
  const busy = phase !== 'choose' && phase !== 'manual';
  const tooBig = !!file && file.size > RESTORE_LIMIT;
  const ready = understood && !tooBig && (source === 'upload' ? !!file : !!name);

  const run = async () => {
    setError(null);
    const startedAt = await http.get<HubStatus>('/api/status').then(
      (s) => s.startedAt,
      () => null,
    );
    let result: RestoreResult;
    try {
      if (source === 'upload' && file) {
        setPhase('uploading');
        setProgress(0);
        result = await uploadBackup(file, (p) => {
          setProgress(p);
          if (p >= 1) setPhase('checking');
        });
      } else {
        setPhase('checking');
        result = await http.post<RestoreResult>('/api/backups/restore', { file: name });
      }
    } catch (err) {
      setPhase('choose');
      setError(errorText(err));
      return;
    }
    setSummary(result);
    if (!result.restarting) {
      setPhase('manual');
      return;
    }
    setPhase('restarting');
    if (startedAt === null) await sleep(10_000);
    const until = Date.now() + 3 * 60_000;
    while (Date.now() < until) {
      await sleep(2000);
      try {
        const s = await http.get<HubStatus>('/api/status');
        if (s.startedAt !== startedAt) {
          setPhase('done');
          window.setTimeout(() => window.location.reload(), 1200);
          return;
        }
      } catch {
        // Still restarting.
      }
    }
    setError(t("The hub hasn't come back yet. Give it another minute, then reload this page."));
  };

  const counts = summary
    ? {
        pills: tp(summary.pills, '{count} pill', '{count} pills'),
        brews: tp(summary.brews, '{count} brew', '{count} brews'),
        readings: tp(summary.readings, '{count} reading', '{count} readings'),
      }
    : null;

  return (
    <Modal title={t('Restore a backup')} onClose={busy ? () => undefined : onClose}>
      {phase === 'choose' && (
        <div className="stack">
          <div className="segmented">
            <button type="button" className={source === 'upload' ? 'on' : ''} onClick={() => setSource('upload')}>
              <Icon name="upload" size={16} /> {t('Upload a file')}
            </button>
            <button type="button" className={source === 'hub' ? 'on' : ''} disabled={files.length === 0} onClick={() => setSource('hub')}>
              <Icon name="hardDrive" size={16} /> {t('A backup on the hub')}
            </button>
          </div>
          {source === 'upload' ? (
            <label className="field">
              <span>{t('Backup file ({name})', { name: 'rapthooker-….db' })}</span>
              <input
                className="input"
                type="file"
                accept=".db,.sqlite,.sqlite3,application/vnd.sqlite3"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              {tooBig ? (
                <FieldError error={t('That file is bigger than 500 MB, which is more than a RaptHooker backup should ever be')} />
              ) : (
                <span className="hint">
                  {t('A file from "Download a copy now", the backups list, the USB stick or your S3 bucket.')}
                  {file ? ` ${file.name}, ${bytes(file.size)}.` : ''}
                </span>
              )}
            </label>
          ) : (
            <label className="field">
              <span>{t('Backup')}</span>
              <select className="select" value={name} onChange={(e) => setName(e.target.value)}>
                {files.map((f) => (
                  <option key={f.name} value={f.name}>
                    {dateTime(f.at)} · {bytes(f.bytes)}
                    {f.kind === 'pre-restore' ? ` · ${t('from before a restore')}` : ''}
                    {f.kind === 'pre-update' ? ` · ${t('from before an update')}` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="notice danger backup-warning">
            <Icon name="alert" />
            <div className="grow">
              <strong>{t('This replaces everything on the hub with the backup.')}</strong>
              <p>
                {t(
                  "Pills, brews, readings, webhooks, alerts and settings (including the owner PIN) all come from the backup. Readings recorded after it was made won't be there.",
                )}
              </p>
              <p>
                {t(
                  'The current data isn\'t deleted: it\'s kept on the hub as a "before restore" copy you can download or restore. The hub then restarts, which takes about half a minute; recording carries on after that.',
                )}
              </p>
            </div>
          </div>
          <label className="check">
            <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
            <span>{t("I understand the hub's current data will be replaced")}</span>
          </label>
          {error && (
            <div className="notice danger">
              <Icon name="alert" />
              <p className="grow">
                <strong>{t("That didn't work.")}</strong> {error}
              </p>
            </div>
          )}
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={onClose}>
              {t('Cancel')}
            </button>
            <button type="button" className="btn danger" disabled={!ready} onClick={() => void run()}>
              <Icon name="undo" size={16} /> {t('Replace and restart')}
            </button>
          </div>
        </div>
      )}
      {phase !== 'choose' && (
        <div className="stack backup-progress">
          <ol className="backup-steps">
            <li className={phase === 'uploading' ? 'now' : 'done'}>
              {source === 'upload'
                ? phase === 'uploading'
                  ? t('Uploading ({percent}%)', { percent: Math.round(progress * 100) })
                  : t('Uploading')
                : t('Picking the backup')}
            </li>
            <li className={phase === 'checking' ? 'now' : phase === 'uploading' ? '' : 'done'}>
              {t("Checking it's a good RaptHooker backup")}
            </li>
            <li className={phase === 'restarting' ? 'now' : phase === 'done' || phase === 'manual' ? 'done' : ''}>
              {t('Restarting the hub')}
            </li>
          </ol>
          {phase === 'uploading' && (
            <div className="bar" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
              <i style={{ width: `${progress * 100}%` }} />
            </div>
          )}
          {counts && <p className="small muted">{t('The backup has {pills}, {brews} and {readings}.', counts)}</p>}
          {phase === 'restarting' && !error && <p className="muted">{t('Waiting for the hub to come back…')}</p>}
          {phase === 'done' && <p className="chip success">{t('Restored. Reloading…')}</p>}
          {phase === 'manual' && (
            <>
              <div className="notice warning">
                <Icon name="info" />
                <p className="grow">
                  <strong>{t('Restart RaptHooker to finish.')}</strong>{' '}
                  {t(
                    "This hub isn't running as a service (development mode), so it can't restart itself. The backup is swapped in when it next starts.",
                  )}
                </p>
              </div>
              <div className="modal-actions">
                <button type="button" className="btn" onClick={onClose}>
                  {t('Close')}
                </button>
              </div>
            </>
          )}
          {error && (
            <div className="notice danger">
              <Icon name="alert" />
              <p className="grow">{error}</p>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Backups: what's been saved where, download, restore, USB stick, S3 and the weekly CSV export. */
export function BackupSection() {
  const { isOwner, toast } = useLive();
  const now = useNow(30_000);
  const [overview, setOverview] = useState<BackupOverview | null>(null);
  const [viewerTargets, setViewerTargets] = useState<BackupTargetStatus[] | null>(null);
  const [settings, setSettings] = useState<BackupSettings | null>(null);
  const [s3, setS3] = useState<S3Settings | null>(null);
  const [busy, setBusy] = useState<'run' | 'save' | 'test' | null>(null);
  const [test, setTest] = useState<S3TestResult | null>(null);
  const [restore, setRestore] = useState<{ file: string | null } | null>(null);
  const check = useFormCheck(s3Schema, s3 ?? DEFAULT_BACKUP_SETTINGS.s3, LABELS);

  const load = useCallback(() => {
    if (isOwner) {
      http.get<BackupOverview>('/api/backups').then(setOverview, () => undefined);
    } else {
      http.get<HubStatus>('/api/status').then(
        (s) => setViewerTargets(s.backups),
        () => undefined,
      );
    }
  }, [isOwner]);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!isOwner) return;
    http.get<BackupSettings>('/api/settings/backups').then(
      (b) => {
        setSettings(b);
        setS3(b.s3);
      },
      (err) => toast({ tone: 'error', title: t("Couldn't load the backup settings"), body: errorText(err) }),
    );
  }, [isOwner, toast]);

  const saveSettings = async (next: BackupSettings, message: string) => {
    setBusy('save');
    try {
      const saved = await http.put<BackupSettings>('/api/settings/backups', next);
      setSettings(saved);
      setS3(saved.s3);
      toast({ tone: 'success', title: message });
      load();
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't save"), body: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const runNow = async () => {
    setBusy('run');
    try {
      const o = await http.post<BackupOverview>('/api/backups/run');
      setOverview(o);
      const failed = o.targets.filter((s) => s.ok === false);
      if (failed.length) {
        toast({
          tone: 'warning',
          title: t('Backed up, with problems'),
          body: failed.map((s) => `${t(TARGETS[s.target].name)}: ${s.error}`).join(' '),
        });
      } else toast({ tone: 'success', title: t('Backed up') });
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't back up"), body: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const setS3Field = <K extends keyof S3Settings>(k: K, v: S3Settings[K]) => {
    setS3((d) => (d ? { ...d, [k]: v } : d));
    setTest(null);
  };

  const saveS3 = () => {
    if (!settings || !s3 || !check.ok(t("Couldn't save"))) return;
    void saveSettings({ ...settings, s3 }, s3.enabled ? t('Cloud backups saved') : t('Cloud backups switched off'));
  };

  const testS3 = async () => {
    if (!s3 || !check.ok(t("Couldn't test"))) return;
    setBusy('test');
    setTest(null);
    try {
      setTest(await http.post<S3TestResult>('/api/backups/test-s3', s3));
    } catch (err) {
      setTest({ ok: false, error: errorText(err), warning: null });
    } finally {
      setBusy(null);
    }
  };

  const targets = isOwner ? (overview?.targets ?? null) : viewerTargets;
  const errors = check.errors;
  const s3Dirty = !!settings && !!s3 && JSON.stringify(settings.s3) !== JSON.stringify(s3);
  const recentRestore = overview?.lastRestore && now - overview.lastRestore.at < 7 * 86_400_000 ? overview.lastRestore : null;

  return (
    <section className="panel backup-section">
      <div className="panel-head">
        <div>
          <h2>
            <Icon name="archive" /> {t('Backups')}
          </h2>
          <p>
            {overview
              ? t('Every night at {time} the hub saves a copy of everything it has recorded and keeps the last {keep}.', {
                  time: overview.time,
                  keep: overview.keep,
                })
              : t('Every night the hub saves a copy of everything it has recorded.')}{' '}
            {t('Copy them off the Pi too (a USB stick or cloud storage), in case its SD card fails.')}
          </p>
        </div>
        {isOwner && (
          <button type="button" className="btn small ghost" onClick={load}>
            <Icon name="refresh" size={14} /> {t('Refresh')}
          </button>
        )}
      </div>

      {targets ? <TargetList targets={targets} now={now} /> : <div className="skeleton" style={{ height: '4rem' }} />}

      {!isOwner ? (
        <OwnerOnly isOwner={false}>{null}</OwnerOnly>
      ) : (
        <>
          {recentRestore && (
            <div className="notice backup-restored">
              <Icon name="info" />
              <p className="grow">
                {t('Restored from a backup {ago}.', { ago: timeAgo(recentRestore.at, now) })}
                {recentRestore.previous
                  ? ` ${t('The data from before is kept as {file} (in the list below).', { file: recentRestore.previous })}`
                  : ''}
              </p>
            </div>
          )}
          <div className="row backup-actions">
            <button type="button" className="btn primary" disabled={busy === 'run' || overview?.running} onClick={() => void runNow()}>
              <Icon name="archive" size={16} /> {busy === 'run' || overview?.running ? t('Backing up…') : t('Back up now')}
            </button>
            <a className="btn" href="/api/backups/now.db" download>
              <Icon name="download" size={16} /> {t('Download a copy now')}
            </a>
            <button type="button" className="btn ghost danger-text" onClick={() => setRestore({ file: null })}>
              <Icon name="undo" size={16} /> {t('Restore…')}
            </button>
          </div>

          <h3 className="backup-subhead">{t('Saved on the hub')}</h3>
          {overview && overview.files.length === 0 && (
            <p className="muted small">{t('None yet: the first one is made tonight, or press Back up now.')}</p>
          )}
          {overview && overview.files.length > 0 && (
            <div className="list backup-files">
              {overview.files.map((f) => (
                <div key={f.name} className="list-item">
                  <div className="grow">
                    <h4>
                      {dateTime(f.at)} {f.kind === 'pre-restore' && <span className="chip warning">{t('From before a restore')}</span>}
                      {f.kind === 'pre-update' && <span className="chip">{t('From before an update')}</span>}
                    </h4>
                    <p className="mono small">
                      {f.name} · {bytes(f.bytes)}
                    </p>
                  </div>
                  <a className="btn small" href={`/api/backups/download?file=${encodeURIComponent(f.name)}`} download>
                    <Icon name="download" size={14} /> {t('Download')}
                  </a>
                  <button type="button" className="btn small ghost" onClick={() => setRestore({ file: f.name })}>
                    <Icon name="undo" size={14} /> {t('Restore')}
                  </button>
                </div>
              ))}
            </div>
          )}
          {overview && <p className="hint">{t('Kept in {folder} on the Pi.', { folder: overview.dir })}</p>}

          {settings && s3 ? (
            <div className="stack backup-options">
              <hr className="divider" />
              <div className="backup-option">
                <div className="row">
                  <Switch
                    on={settings.usb}
                    disabled={busy === 'save'}
                    onChange={(on) =>
                      void saveSettings({ ...settings, usb: on }, on ? t('Copying backups to a USB stick') : t('USB copies switched off'))
                    }
                    label={t('Copy backups to a USB stick')}
                  />
                  <strong className="grow">{t('Copy to a USB stick')}</strong>
                  {settings.usb && overview?.usbPresent !== null && overview?.usbPresent !== undefined && (
                    <span className={overview.usbPresent ? 'chip success' : 'chip'}>
                      {overview.usbPresent ? t('Stick plugged in') : t('No stick')}
                    </span>
                  )}
                </div>
                <p className="hint">
                  <Trans
                    text={t('Format a USB stick as {fat32} or {exfat}, name it {label} and plug it into the Pi.')}
                    values={{ fat32: <strong>FAT32</strong>, exfat: <strong>exFAT</strong>, label: <strong>RAPTHOOKER</strong> }}
                  />{' '}
                  {t("Each night's backup is copied onto it and the last 30 are kept, so you can take it away and keep a copy safe.")}{' '}
                  {t('Wait a minute after a backup before pulling it out.')}
                </p>
              </div>

              <hr className="divider" />
              <div className="backup-option">
                <div className="row">
                  <Switch
                    on={s3.enabled}
                    disabled={busy === 'save'}
                    onChange={(on) => {
                      if (!on && settings.s3.enabled)
                        void saveSettings({ ...settings, s3: { ...s3, enabled: false } }, t('Cloud backups switched off'));
                      else setS3Field('enabled', on);
                    }}
                    label={t('Upload backups to cloud storage')}
                  />
                  <strong className="grow">{t('Upload to cloud storage (S3)')}</strong>
                </div>
                <p className="hint">
                  {t('Amazon S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO or anything else with an S3-compatible API.')}{' '}
                  {t(
                    "Each night's backup is uploaded to the folder below and the newest 30 are kept: older ones are deleted, so the key needs permission to list and delete as well as upload (or set a lifecycle rule on the bucket instead).",
                  )}
                </p>
                {s3.enabled && (
                  <div className="stack">
                    <div className="form-grid">
                      <label className="field backup-wide">
                        <span>{t('Endpoint')}</span>
                        <input
                          className="input mono"
                          value={s3.endpoint}
                          spellCheck={false}
                          placeholder="https://s3.eu-west-2.amazonaws.com"
                          onChange={(e) => setS3Field('endpoint', e.target.value)}
                        />
                        <FieldError error={errors.endpoint} />
                        <span className="hint">{t('Leave it empty for Amazon S3 (the region picks the address).')}</span>
                      </label>
                      <label className="field">
                        <span>{t('Region')}</span>
                        <input
                          className="input mono"
                          value={s3.region}
                          spellCheck={false}
                          placeholder="us-east-1"
                          onChange={(e) => setS3Field('region', e.target.value)}
                        />
                        <FieldError error={errors.region} />
                        <span className="hint">
                          <Trans text={t('{auto} for Cloudflare R2.')} values={{ auto: <code>auto</code> }} />
                        </span>
                      </label>
                      <label className="field">
                        <span>{t('Bucket')}</span>
                        <input
                          className="input mono"
                          value={s3.bucket}
                          spellCheck={false}
                          onChange={(e) => setS3Field('bucket', e.target.value)}
                        />
                        <FieldError error={errors.bucket} />
                      </label>
                      <label className="field">
                        <span>{t('Folder in the bucket')}</span>
                        <input
                          className="input mono"
                          value={s3.prefix}
                          spellCheck={false}
                          placeholder="rapthooker/"
                          onChange={(e) => setS3Field('prefix', e.target.value)}
                        />
                        <FieldError error={errors.prefix} />
                      </label>
                      <label className="field">
                        <span>{t('Access key ID')}</span>
                        <input
                          className="input mono"
                          value={s3.accessKeyId}
                          autoComplete="off"
                          spellCheck={false}
                          onChange={(e) => setS3Field('accessKeyId', e.target.value)}
                        />
                        <FieldError error={errors.accessKeyId} />
                      </label>
                      <label className="field">
                        <span>{t('Secret access key')}</span>
                        <input
                          className="input mono"
                          type="password"
                          value={s3.secretAccessKey}
                          autoComplete="new-password"
                          onFocus={(e) => e.currentTarget.select()}
                          onChange={(e) => setS3Field('secretAccessKey', e.target.value)}
                        />
                        <FieldError error={errors.secretAccessKey} />
                      </label>
                    </div>
                    <label className="check">
                      <input type="checkbox" checked={s3.pathStyle} onChange={(e) => setS3Field('pathStyle', e.target.checked)} />
                      <span>
                        {t('Path-style addresses')}
                        <small>
                          {t(
                            'endpoint/bucket rather than bucket.endpoint. MinIO, most NAS boxes and Cloudflare R2 want this; Amazon S3 works either way.',
                          )}
                        </small>
                      </span>
                    </label>
                    <div className="row">
                      <button
                        type="button"
                        className="btn primary"
                        disabled={busy !== null || (!s3Dirty && settings.s3.enabled)}
                        onClick={saveS3}
                      >
                        <Icon name="check" /> {busy === 'save' ? t('Saving…') : t('Save')}
                      </button>
                      <button type="button" className="btn" disabled={busy !== null} onClick={() => void testS3()}>
                        <Icon name="zap" /> {busy === 'test' ? t('Testing…') : t('Test')}
                      </button>
                      {test?.ok && !test.warning && <span className="chip success">{t('Uploaded and deleted a test file')}</span>}
                    </div>
                    {test && !test.ok && (
                      <div className="notice danger">
                        <Icon name="alert" />
                        <p className="grow">
                          <strong>{t("The test didn't work.")}</strong> {test.error}
                        </p>
                      </div>
                    )}
                    {test?.ok && test.warning && (
                      <div className="notice warning">
                        <Icon name="info" />
                        <p className="grow">{test.warning}</p>
                      </div>
                    )}
                    <details className="backup-help">
                      <summary>{t('Settings for popular services')}</summary>
                      <ul>
                        <li>
                          <strong>Amazon S3:</strong>{' '}
                          <Trans
                            text={t("endpoint empty (or {endpoint}), region {region} (your bucket's).")}
                            values={{ endpoint: <code>https://s3.eu-west-2.amazonaws.com</code>, region: <code>eu-west-2</code> }}
                          />
                        </li>
                        <li>
                          <strong>Cloudflare R2:</strong>{' '}
                          <Trans
                            text={t('endpoint {endpoint}, region {region}, path-style on.')}
                            values={{
                              endpoint: <code>https://&lt;account id&gt;.r2.cloudflarestorage.com</code>,
                              region: <code>auto</code>,
                            }}
                          />
                        </li>
                        <li>
                          <strong>Backblaze B2:</strong>{' '}
                          <Trans
                            text={t("endpoint {endpoint}, region {region} (both as shown on your bucket's page).")}
                            values={{ endpoint: <code>https://s3.us-west-004.backblazeb2.com</code>, region: <code>us-west-004</code> }}
                          />
                        </li>
                        <li>
                          <strong>Wasabi:</strong>{' '}
                          <Trans
                            text={t('endpoint {endpoint}, region {region}.')}
                            values={{ endpoint: <code>https://s3.eu-central-1.wasabisys.com</code>, region: <code>eu-central-1</code> }}
                          />
                        </li>
                        <li>
                          <strong>{t('MinIO or a NAS:')}</strong>{' '}
                          <Trans
                            text={t('endpoint like {endpoint}, region {region}, path-style on.')}
                            values={{ endpoint: <code>http://nas.local:9000</code>, region: <code>us-east-1</code> }}
                          />
                        </li>
                      </ul>
                      <p className="small">
                        <a href={DOCS_URL} target="_blank" rel="noreferrer">
                          {t('The backups guide')} <Icon name="external" size={14} />
                        </a>
                      </p>
                    </details>
                  </div>
                )}
              </div>

              <hr className="divider" />
              <div className="backup-option">
                <div className="row">
                  <Switch
                    on={settings.weeklyCsv}
                    disabled={busy === 'save'}
                    onChange={(on) =>
                      void saveSettings(
                        { ...settings, weeklyCsv: on },
                        on ? t('Weekly CSV export switched on') : t('Weekly CSV export switched off'),
                      )
                    }
                    label={t('Weekly CSV export')}
                  />
                  <strong className="grow">{t('Weekly CSV export')}</strong>
                </div>
                <p className="hint">
                  {t(
                    "Every Sunday, each brew from the last 60 days and every pill's last 7 days are also saved as CSV files (they open in any spreadsheet), next to the backups and on the USB stick and in the cloud when those are on.",
                  )}{' '}
                  {t('The last 8 weeks are kept.')}
                </p>
                {overview?.csv.at && (
                  <p className="small muted">
                    {overview.csv.folder
                      ? t('Last saved {ago} in {folder}.', { ago: timeAgo(overview.csv.at, now), folder: overview.csv.folder })
                      : t('Last saved {ago}.', { ago: timeAgo(overview.csv.at, now) })}
                  </p>
                )}
                {overview?.csv.error && <p className="backup-error">{overview.csv.error}</p>}
              </div>
            </div>
          ) : (
            <div className="skeleton" style={{ height: '8rem' }} />
          )}
        </>
      )}

      {restore && overview && <RestoreModal files={overview.files} initial={restore.file} onClose={() => setRestore(null)} />}
    </section>
  );
}
