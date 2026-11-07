import { useEffect, useRef, useState } from 'react';
import type { UpdateInfo } from '@rapthooker/shared';
import { errorText, http } from '../api';
import { useLive, useLiveMessages } from '../live';
import { Markdown } from '../markdown';
import { Confirm, Modal } from './ui';
import { Icon } from './Icon';
import { RELEASES_URL, UPDATE_DOCS_URL } from './WhatsNew';
import { t } from '../i18n';
import './UpdateBanner.css';

const DISMISSED_KEY = 'updateDismissed';
const FAILURE_DISMISSED_KEY = 'updateFailureDismissed';

function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private browsing: the banner comes back next time.
  }
}

/** The hub's release check and update state: fetched on load and after reconnecting, then kept current live. */
export function useUpdateInfo(): [UpdateInfo | null, (info: UpdateInfo) => void] {
  const { connection } = useLive();
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  useEffect(() => {
    // The live "hello" doesn't include it, so ask whenever the connection (re)opens: after an update, the hub is new.
    if (connection !== 'open') return;
    let cancelled = false;
    http.get<UpdateInfo>('/api/update').then(
      (u) => {
        if (!cancelled) setInfo(u);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [connection]);
  useLiveMessages((msg) => {
    if (msg.type === 'update') setInfo(msg.update);
  });
  return [info, setInfo];
}

/** "Update now", with a confirmation first. */
export function UpdateNowButton({
  info,
  onChange,
  small = false,
  label = t('Update now'),
}: {
  info: UpdateInfo;
  onChange: (info: UpdateInfo) => void;
  small?: boolean;
  label?: string;
}) {
  const { toast } = useLive();
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <button type="button" className={`btn primary${small ? ' small' : ''}`} onClick={() => setConfirming(true)}>
        <Icon name="download" size={small ? 15 : 17} /> {label}
      </button>
      {confirming && (
        <Confirm
          title={t('Update to RaptHooker {version}?', { version: info.latest ?? '' })}
          body={
            <>
              <p>
                {t(
                  'The hub downloads the new version, installs it and restarts. That takes a few minutes; recording carries on straight after (a reading or two may be missed while it restarts).',
                )}
              </p>
              <p>
                {t("If the new version doesn't start, the hub goes back to {version} by itself. Your brews and settings stay.", {
                  version: info.current,
                })}
              </p>
            </>
          }
          confirm={t('Update now')}
          onConfirm={async () => {
            try {
              onChange(await http.post<UpdateInfo>('/api/update/apply'));
            } catch (err) {
              toast({ tone: 'error', title: t("Couldn't start the update"), body: errorText(err) });
            }
          }}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  );
}

/** "Switch to release x.y.z" on a development build, with a confirmation first. */
export function SwitchToReleaseButton({ info, onChange }: { info: UpdateInfo; onChange: (info: UpdateInfo) => void }) {
  const { toast } = useLive();
  const [confirming, setConfirming] = useState(false);
  const version = info.latest ?? '';
  return (
    <>
      <button type="button" className="btn primary" onClick={() => setConfirming(true)}>
        <Icon name="download" size={17} /> {t('Switch to release {version}', { version })}
      </button>
      {confirming && (
        <Confirm
          title={t('Switch to RaptHooker {version}?', { version })}
          body={
            <>
              <p>
                {t(
                  'The hub downloads release {version}, installs it in place of this development build and restarts. From then on it updates from releases like any other hub.',
                  { version },
                )}
              </p>
              <p>
                {t(
                  "Anything this build has that the release doesn't goes away. If the release doesn't start, the hub goes back to this build by itself. Your brews and settings stay.",
                )}
              </p>
            </>
          }
          confirm={t('Switch to the release')}
          onConfirm={async () => {
            try {
              onChange(await http.post<UpdateInfo>('/api/update/switch'));
            } catch (err) {
              toast({ tone: 'error', title: t("Couldn't switch to the release"), body: errorText(err) });
            }
          }}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  );
}

/** "Try this beta", or "Go back to release x.y.z" from a beta, with a confirmation first. */
export function InstallVersionButton({
  info,
  version,
  onChange,
}: {
  info: UpdateInfo;
  version: string;
  onChange: (info: UpdateInfo) => void;
}) {
  const { toast } = useLive();
  const [confirming, setConfirming] = useState(false);
  const beta = version.includes('-');
  return (
    <>
      <button type="button" className={`btn${beta ? '' : ' primary'}`} onClick={() => setConfirming(true)}>
        <Icon name={beta ? 'flask' : 'undo'} size={17} /> {beta ? t('Try this beta') : t('Go back to release {version}', { version })}
      </button>
      {confirming && (
        <Confirm
          title={beta ? t('Try RaptHooker {version}?', { version }) : t('Go back to RaptHooker {version}?', { version })}
          body={
            beta ? (
              <>
                <p>
                  {t(
                    'The hub downloads beta {version}, installs it and restarts. That takes a few minutes; recording carries on straight after (a reading or two may be missed while it restarts).',
                    { version },
                  )}
                </p>
                <p>
                  {t(
                    "Betas are for trying out what's coming, so they can have rough edges. Your brews, readings and settings stay, and you can go back to the latest release under Settings → Updates whenever you like.",
                  )}
                </p>
                <p>
                  {info.devBuild
                    ? t("If the beta doesn't start, the hub goes back to this build by itself.")
                    : t("If the beta doesn't start, the hub goes back to {version} by itself.", { version: info.current })}
                </p>
              </>
            ) : (
              <>
                <p>
                  {t(
                    'The hub downloads release {version}, installs it in place of this beta and restarts. From then on it updates from releases.',
                    {
                      version,
                    },
                  )}
                </p>
                <p>
                  {t(
                    'Everything recorded on the beta stays. Anything only the beta has is kept, unused, until the hub is on a version that has it.',
                  )}
                </p>
                <p>{t("If the release doesn't start, the hub goes back to this beta by itself.")}</p>
              </>
            )
          }
          confirm={beta ? t('Install the beta') : t('Go back to the release')}
          onConfirm={async () => {
            try {
              onChange(await http.post<UpdateInfo>('/api/update/install', { version }));
            } catch (err) {
              toast({
                tone: 'error',
                title: beta ? t("Couldn't install the beta") : t("Couldn't go back to the release"),
                body: errorText(err),
              });
            }
          }}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  );
}

/** Says in the top bar that the hub runs a development build or a beta, so it's never mistaken for a release. */
export function DevBuildBadge() {
  const [info] = useUpdateInfo();
  if (info?.devBuild) {
    return (
      <a className="chip warning dev-build-badge" href="#/settings" title={t('This hub runs a development build.')}>
        {t('Development build')}
      </a>
    );
  }
  if (info?.prerelease) {
    return (
      <a className="chip warning dev-build-badge" href="#/settings" title={t('This hub runs beta {version}.', { version: info.current })}>
        {t('Beta')}
      </a>
    );
  }
  return null;
}

/** What the hub runs: a development build can have the same version number as a release, or as the last build. */
function buildId(info: UpdateInfo): string {
  const dev = info.devBuild;
  return dev ? `${info.current}+dev.${dev.commit ?? ''}.${dev.builtAt ?? ''}` : info.current;
}

/** Release notes in a dialog. */
export function ReleaseNotes({ info, onClose }: { info: UpdateInfo; onClose: () => void }) {
  return (
    <Modal wide title={t("What's new in RaptHooker {version}", { version: info.latest ?? '' })} onClose={onClose}>
      {info.notes ? (
        <Markdown text={info.notes} className="release-notes" />
      ) : (
        <p className="muted">{t('This release came without notes.')}</p>
      )}
      <div className="modal-actions">
        <a className="btn ghost" href={info.url ?? RELEASES_URL} target="_blank" rel="noreferrer noopener">
          {t('On GitHub')} <Icon name="external" size={15} />
        </a>
        <button type="button" className="btn primary" onClick={onClose}>
          {t('Done')}
        </button>
      </div>
    </Modal>
  );
}

/** "A new version is available" banner, shown at the top of every page. */
export function UpdateBanner() {
  const { isOwner, connection } = useLive();
  const [info, setInfo] = useUpdateInfo();
  const [notes, setNotes] = useState(false);
  const [dismissed, setDismissed] = useState(() => readKey(DISMISSED_KEY));
  const [failureDismissed, setFailureDismissed] = useState(() => readKey(FAILURE_DISMISSED_KEY));
  const [firstBuild, setFirstBuild] = useState<string | null>(null);
  const sawUpdating = useRef(false);

  useEffect(() => {
    if (!info) return;
    if (firstBuild === null) setFirstBuild(buildId(info));
    if (info.state === 'updating') sawUpdating.current = true;
    // The hub is back on its new version: load the new app to go with it.
    else if (sawUpdating.current && firstBuild && buildId(info) !== firstBuild) window.location.reload();
  }, [info, firstBuild]);

  if (!info) return null;
  // What an update is installing, or didn't: a beta, or a release older than the beta it replaces, isn't `latest`.
  const target = info.target ?? info.latest;

  if (info.state === 'updating') {
    const back = connection === 'open';
    return (
      <div className="notice update-banner" role="status">
        <Icon name="refresh" className="update-spin" />
        <p className="grow">
          <strong>
            {target ? t('Updating to RaptHooker {version}…', { version: target }) : t('Updating RaptHooker to the latest version…')}
          </strong>{' '}
          {back
            ? t('The hub restarts by itself when the new version is in; this page reconnects when it is back.')
            : t('The hub is restarting. This page reconnects by itself.')}
        </p>
      </div>
    );
  }

  if (firstBuild && buildId(info) !== firstBuild) {
    return (
      <div className="notice update-banner" role="status">
        <Icon name="sparkles" />
        <p className="grow">
          <strong>{t('RaptHooker has been updated to {version}.', { version: info.current })}</strong> {t('Reload to use the new version.')}
        </p>
        <button type="button" className="btn primary small" onClick={() => window.location.reload()}>
          <Icon name="refresh" size={15} /> {t('Reload')}
        </button>
      </div>
    );
  }

  const failureKey = `${info.current}:${info.error ?? ''}`;
  if (info.state === 'failed' && failureDismissed !== failureKey) {
    return (
      <div className="notice danger update-banner" role="alert">
        <Icon name="alert" />
        <p className="grow">
          <strong>
            {target ? t("The update to RaptHooker {version} didn't work.", { version: target }) : t("The update didn't work.")}
          </strong>{' '}
          {info.error}
        </p>
        <div className="update-actions">
          {isOwner && info.canSelfUpdate && info.available && (!info.target || info.target === info.latest) && (
            <UpdateNowButton info={info} onChange={setInfo} small label={t('Try again')} />
          )}
          <a className="btn ghost small" href={UPDATE_DOCS_URL} target="_blank" rel="noreferrer noopener">
            {t('Help')}
          </a>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('Dismiss')}
            onClick={() => {
              writeKey(FAILURE_DISMISSED_KEY, failureKey);
              setFailureDismissed(failureKey);
            }}
          >
            <Icon name="x" />
          </button>
        </div>
      </div>
    );
  }

  if (!info.available || !info.latest || dismissed === info.latest) return null;
  const latest = info.latest;
  return (
    <div className="notice update-banner" role="status">
      <Icon name="sparkles" />
      <p className="grow">
        <strong>{t('RaptHooker {version} is available.', { version: latest })}</strong>{' '}
        <span className="muted">{t('You have {version}.', { version: info.current })}</span>
      </p>
      <div className="update-actions">
        <button type="button" className="btn ghost small" onClick={() => setNotes(true)}>
          {t("What's new")}
        </button>
        {isOwner && info.canSelfUpdate ? (
          <UpdateNowButton info={info} onChange={setInfo} small />
        ) : (
          <a className="btn small" href={UPDATE_DOCS_URL} target="_blank" rel="noreferrer noopener">
            {t('How to update')} <Icon name="external" size={14} />
          </a>
        )}
        <button
          type="button"
          className="icon-btn"
          aria-label={t('Hide until the next version after {version}', { version: latest })}
          title={t('Hide until the next version')}
          onClick={() => {
            writeKey(DISMISSED_KEY, latest);
            setDismissed(latest);
          }}
        >
          <Icon name="x" />
        </button>
      </div>
      {notes && <ReleaseNotes info={info} onClose={() => setNotes(false)} />}
    </div>
  );
}
