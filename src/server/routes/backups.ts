import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { backupSettingsSchema, type BackupOverview, type BackupSettings, type RestoreResult } from '@rapthooker/shared';
import { MASKED, maskBackups } from '../settings.js';
import { localStamp, snapshot } from '../backup/files.js';
import { testS3 } from '../backup/s3.js';
import { foldWal, inspectBackup, PENDING_NAME, RestoreError } from '../restore.js';
import type { RouteContext } from './context.js';

/** The biggest database that can be uploaded to restore. */
export const RESTORE_LIMIT = 500 * 1024 * 1024;

const fileQuery = z.object({ file: z.string().min(1).max(200) });

const isStream = (body: unknown): body is Readable => typeof (body as Readable | null)?.pipe === 'function';

const tooBig = () => new RestoreError(`That file is too big (the limit is ${RESTORE_LIMIT / 1024 / 1024} MB)`, 413);

/** Copies an upload to a file, refusing more than RESTORE_LIMIT bytes. */
async function saveUpload(body: Readable, file: string): Promise<number> {
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > RESTORE_LIMIT) cb(tooBig());
      else cb(null, chunk);
    },
  });
  await pipeline(body, counter, createWriteStream(file));
  return bytes;
}

/** Backup settings, the list of backups, downloads, "back up now", the S3 test and restoring. All owner only. */
export function backupRoutes({ app, s, owner }: RouteContext): void {
  const { store, settings, maintenance } = s;
  const dataDir = maintenance.dataDir;

  app.get('/api/settings/backups', owner, async (): Promise<BackupSettings> => maskBackups(settings.backups()));

  app.put('/api/settings/backups', owner, async (req): Promise<BackupSettings> => {
    const body = backupSettingsSchema.parse(req.body);
    if (body.s3.secretAccessKey === MASKED) body.s3.secretAccessKey = settings.backups().s3.secretAccessKey;
    return maskBackups(settings.setBackups(body));
  });

  app.get('/api/backups', owner, async (): Promise<BackupOverview> => maintenance.overview());

  app.get('/api/backups/download', owner, async (req, reply) => {
    const { file } = fileQuery.parse(req.query);
    const path = maintenance.fileByName(file);
    if (!path) return reply.code(404).send({ error: 'There is no backup with that name' });
    // Pre-restore copies made by older versions can still have recent changes in a -wal file beside them.
    foldWal(path);
    const { size } = await stat(path);
    return reply
      .header('Content-Type', 'application/vnd.sqlite3')
      .header('Content-Length', size)
      .header('Content-Disposition', `attachment; filename="${file}"`)
      .send(createReadStream(path));
  });

  // A fresh, consistent copy made on the spot, streamed and then deleted.
  app.get('/api/backups/now.db', owner, async (_req, reply) => {
    const tmp = join(dataDir, `download-${randomBytes(6).toString('hex')}.partial`);
    try {
      await snapshot(store, tmp);
      const { size } = await stat(tmp);
      const stream = createReadStream(tmp);
      stream.once('close', () => void rm(tmp, { force: true }).catch(() => undefined));
      return reply
        .header('Content-Type', 'application/vnd.sqlite3')
        .header('Content-Length', size)
        .header('Content-Disposition', `attachment; filename="rapthooker-${localStamp(new Date())}.db"`)
        .send(stream);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  });

  app.post('/api/backups/run', owner, async (): Promise<BackupOverview> => {
    await maintenance.backupNow();
    return maintenance.overview();
  });

  app.post('/api/backups/test-s3', owner, async (req) => {
    const s3 = backupSettingsSchema.shape.s3.parse(req.body);
    if (s3.secretAccessKey === MASKED) s3.secretAccessKey = settings.backups().s3.secretAccessKey;
    try {
      const { warning } = await testS3(s3);
      return { ok: true, error: null, warning };
    } catch (err) {
      return { ok: false, error: (err as Error).message, warning: null };
    }
  });

  let restoring = false;
  // Uploads come in as raw bytes (application/octet-stream), so this route gets its own body parser and size limit.
  void app.register(async (sub) => {
    sub.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
    sub.post('/api/backups/restore', { ...owner, bodyLimit: RESTORE_LIMIT }, async (req): Promise<RestoreResult> => {
      if (restoring) throw new RestoreError('A restore is already under way', 409);
      restoring = true;
      const upload = join(dataDir, 'restore-upload.partial');
      try {
        await rm(upload, { force: true });
        if (isStream(req.body)) {
          const declared = Number(req.headers['content-length']);
          if (declared > RESTORE_LIMIT) throw tooBig();
          const bytes = await saveUpload(req.body, upload);
          if (bytes === 0) throw new RestoreError('That file is empty');
          if (Number.isFinite(declared) && bytes !== declared) throw new RestoreError('The upload was cut short: try again');
        } else {
          const { file } = fileQuery.parse(req.body);
          const path = maintenance.fileByName(file);
          if (!path) throw new RestoreError('There is no backup with that name', 404);
          foldWal(path);
          await copyFile(path, upload);
        }
        const summary = inspectBackup(upload);
        const pending = join(dataDir, PENDING_NAME);
        for (const suffix of ['', '-wal', '-shm']) await rm(`${pending}${suffix}`, { force: true });
        await rename(upload, pending);
        req.log.warn({ ...summary }, 'a backup is ready to be restored');
        const restarting = maintenance.restart();
        return { restarting, pills: summary.pills, brews: summary.brews, readings: summary.readings };
      } finally {
        restoring = false;
        await rm(upload, { force: true }).catch(() => undefined);
      }
    });
  });
}
