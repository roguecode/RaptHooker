import { useState } from 'react';
import type { DevBuild, UpdateInfo } from '@rapthooker/shared';
import { errorText, http } from '../../api';
import { useLive } from '../../live';
import { timeAgo, useNow } from '../../format';
import { t } from '../../i18n';
import { Markdown } from '../../markdown';
import { Icon } from '../../components/Icon';
import { InstallVersionButton, SwitchToReleaseButton, UpdateNowButton, useUpdateInfo } from '../../components/UpdateBanner';
import { RELEASES_URL, UPDATE_DOCS_URL, changelogFor } from '../../components/WhatsNew';
import './UpdateSection.css';

/** Which commit a development build came from, and when it was built. */
function buildText(dev: DevBuild, now: number): string | null {
  if (!dev.builtAt) return null;
  const time = timeAgo(dev.builtAt, now);
  if (!dev.commit) return t('Built {time}', { time });
  return dev.changes
    ? t('Commit {commit} with uncommitted changes, built {time}', { commit: dev.commit, time })
    : t('Commit {commit}, built {time}', { commit: dev.commit, time });
}

/** The betas the owner can try, looked up on GitHub when the list is first opened. */
function Betas({ info, onChange }: { info: UpdateInfo; onChange: (info: UpdateInfo) => void }) {
  const { toast } = useLive();
  const [looking, setLooking] = useState(false);
  const now = useNow(30_000);
  const look = async () => {
    setLooking(true);
    try {
      const result = await http.post<UpdateInfo>('/api/update/betas');
      onChange(result);
      if (result.betasError) toast({ tone: 'warning', title: t("Couldn't look for betas"), body: result.betasError });
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't look for betas"), body: errorText(err) });
    } finally {
      setLooking(false);
    }
  };
  const busy = info.state === 'updating';

  return (
    <details
      className="update-notes update-betas"
      open={info.prerelease || undefined}
      onToggle={(e) => {
        if (e.currentTarget.open && info.betasCheckedAt === null && !looking) void look();
      }}
    >
      <summary>{t('Beta versions')}</summary>
      <p className="hint">
        {t(
          "Betas are early versions, for trying out what's coming before it's released. They can have rough edges. Your brews, readings and settings stay whichever version the hub is on, and you can go back to the latest release from here at any time.",
        )}
      </p>
      {info.betasCheckedAt !== null &&
        (info.betas.length ? (
          <ul className="update-beta-list">
            {info.betas.map((b) => (
              <li key={b.version} className="update-beta">
                <div className="update-beta-head">
                  <strong>RaptHooker {b.version}</strong>
                  {b.version === info.current && <span className="chip success">{t('This hub')}</span>}
                  {b.version === info.newerBeta && <span className="chip warning">{t('Newer')}</span>}
                  {b.publishedAt !== null && <span className="muted">{timeAgo(b.publishedAt, now)}</span>}
                  <span className="grow" />
                  {b.version !== info.current && !busy && <InstallVersionButton info={info} version={b.version} onChange={onChange} />}
                </div>
                <details className="update-beta-notes">
                  <summary>{t("What's in it")}</summary>
                  {b.notes ? <Markdown text={b.notes} /> : <p className="muted">{t('This release came without notes.')}</p>}
                  <a href={b.url} target="_blank" rel="noreferrer noopener">
                    {t('On GitHub')} <Icon name="external" size={14} />
                  </a>
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{t('There are no betas to try right now.')}</p>
        ))}
      <div className="row update-beta-actions">
        <button type="button" className="btn" onClick={() => void look()} disabled={looking || busy}>
          <Icon name="refresh" size={16} className={looking ? 'update-spin' : undefined} />{' '}
          {info.betasCheckedAt === null ? t('Look for betas') : t('Look again')}
        </button>
        {info.betasCheckedAt !== null && <span className="muted">{t('Looked {time}', { time: timeAgo(info.betasCheckedAt, now) })}</span>}
      </div>
    </details>
  );
}

/** Updates and "What's new". */
export function UpdateSection() {
  const { isOwner, hub, toast } = useLive();
  const [info, setInfo] = useUpdateInfo();
  const [checking, setChecking] = useState(false);
  const now = useNow(30_000);
  if (!info) return null;

  // A beta's own notes come from GitHub: its changelog entry is only written for the release.
  const betaNotes = info.prerelease ? (info.betas.find((b) => b.version === info.current)?.notes ?? null) : null;
  const current = betaNotes ? { body: betaNotes } : changelogFor(info.current);
  const check = async () => {
    setChecking(true);
    try {
      const result = await http.post<UpdateInfo>('/api/update/check');
      setInfo(result);
      if (result.error) toast({ tone: 'warning', title: t("Couldn't check for updates"), body: result.error });
      // A development build isn't compared with releases: what the check found shows as the latest release instead.
      // A beta is newer than the latest release, without being "the latest version".
      else if (!result.available && !result.devBuild && !result.prerelease)
        toast({ tone: 'success', title: t("You're on the latest version") });
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't check for updates"), body: errorText(err) });
    } finally {
      setChecking(false);
    }
  };

  const dev = info.devBuild;
  const build = dev ? buildText(dev, now) : null;
  const status =
    info.state === 'updating' ? (
      <span className="chip warning">{t('Updating…')}</span>
    ) : dev ? (
      <span className="chip warning">{t('Development build')}</span>
    ) : info.available ? (
      <span className="chip warning">{t('Update available')}</span>
    ) : info.prerelease ? (
      <span className="chip warning">{t('Beta')}</span>
    ) : info.latest ? (
      <span className="chip success">{t('Up to date')}</span>
    ) : null;
  // Back from a beta to the latest release (when that's newer, it's an ordinary update).
  const goBack = info.prerelease && info.latest && !info.available ? info.latest : null;

  return (
    <section className="panel update-section" id="updates">
      <div className="panel-head">
        <div>
          <h2>
            <Icon name="download" /> {t('Updates')}
          </h2>
          <p>{t('New versions of RaptHooker, and what changed.')}</p>
        </div>
        {status}
      </div>

      <dl className="kv">
        <dt>{t('This hub')}</dt>
        <dd>RaptHooker {info.current}</dd>
        {build && (
          <>
            <dt>{t('Build')}</dt>
            <dd>{build}</dd>
          </>
        )}
        <dt>{t('Latest release')}</dt>
        <dd>{info.latest ?? (info.checkedAt ? t('None published yet') : t('Not checked yet'))}</dd>
        <dt>{t('Last checked')}</dt>
        <dd>
          {info.checkedAt ? timeAgo(info.checkedAt, now) : t('Never')}
          {!hub.updateCheck && <span className="muted"> · {t('the daily check is off')}</span>}
        </dd>
        {info.error && info.state !== 'failed' && (
          <>
            <dt>{t('Problem')}</dt>
            <dd className="update-problem">{info.error}</dd>
          </>
        )}
      </dl>

      {dev && info.state !== 'updating' && (
        <div className="notice warning update-section-notice">
          <Icon name="alert" />
          <p className="grow">
            <strong>{t('This hub runs a development build.')}</strong>{' '}
            {t(
              "It was built from source and copied to the hub by hand, not installed from a release, so its version number doesn't say exactly what it runs and it doesn't update itself.",
            )}
          </p>
        </div>
      )}

      {info.prerelease && info.state !== 'updating' && (
        <div className="notice warning update-section-notice">
          <Icon name="flask" />
          <p className="grow">
            <strong>{t('This hub runs a beta.')}</strong>{' '}
            {t(
              "It's an early version, for trying out what's coming. Your brews, readings and settings stay whichever version the hub is on.",
            )}
            {info.newerBeta && <> {t('A newer beta of it is out: {version}.', { version: info.newerBeta })}</>}
          </p>
        </div>
      )}

      {info.state === 'failed' && (
        <div className="notice danger update-section-notice">
          <Icon name="alert" />
          <p className="grow">
            <strong>{t("The last update didn't work.")}</strong> {info.error}
          </p>
        </div>
      )}

      <div className="row update-section-actions">
        {isOwner && (
          <button type="button" className="btn" onClick={() => void check()} disabled={checking || info.state === 'updating'}>
            <Icon name="refresh" size={16} className={checking ? 'update-spin' : undefined} /> {t('Check now')}
          </button>
        )}
        {info.available && isOwner && info.canSelfUpdate && info.state !== 'updating' && <UpdateNowButton info={info} onChange={setInfo} />}
        {goBack && isOwner && info.canInstall && info.state !== 'updating' && (
          <InstallVersionButton info={info} version={goBack} onChange={setInfo} />
        )}
        {dev && info.latest && isOwner && info.canSwitchToRelease && info.state !== 'updating' && (
          <SwitchToReleaseButton info={info} onChange={setInfo} />
        )}
        {info.available && !info.canSelfUpdate && (
          <a className="btn" href={UPDATE_DOCS_URL} target="_blank" rel="noreferrer noopener">
            {t('How to update')} <Icon name="external" size={15} />
          </a>
        )}
        <a className="btn ghost" href={RELEASES_URL} target="_blank" rel="noreferrer noopener">
          {t('All releases')} <Icon name="external" size={15} />
        </a>
      </div>
      {!isOwner && <p className="hint">{t('Sign in with the owner PIN to check for updates or update.')}</p>}
      {isOwner && !dev && !info.canSelfUpdate && (
        <p className="hint">
          {t("This hub wasn't set up with the one-line installer, so it can't update itself from here.")}{' '}
          <a href={UPDATE_DOCS_URL} target="_blank" rel="noreferrer noopener">
            {t('How to update')}
          </a>
        </p>
      )}
      {isOwner && dev && !info.canSwitchToRelease && (
        <p className="hint">
          {t('To go back to releases, run the one-line installer on the hub.')}{' '}
          <a href={UPDATE_DOCS_URL} target="_blank" rel="noreferrer noopener">
            {t('How to update')}
          </a>
        </p>
      )}

      {info.available && info.notes && (
        <details className="update-notes" open>
          <summary>{t("What's new in {version}", { version: info.latest ?? '' })}</summary>
          <Markdown text={info.notes} />
        </details>
      )}
      {current && (
        <details className="update-notes">
          <summary>{t("What's in {version} (this version)", { version: info.current })}</summary>
          <Markdown text={current.body} />
        </details>
      )}
      {isOwner && info.canInstall && <Betas info={info} onChange={setInfo} />}
    </section>
  );
}
