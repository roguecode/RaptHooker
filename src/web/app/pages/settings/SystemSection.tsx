import { useCallback, useEffect, useRef, useState } from 'react';
import type { HubAddress, HubStatus, LogEntry, LogLevel } from '@rapthooker/shared';
import { errorText, http } from '../../api';
import { useLive } from '../../live';
import { intlLocale } from '../../format';
import { t, tk } from '../../i18n';
import { Trans } from '../../i18n/Trans';
import { Icon } from '../../components/Icon';
import { Confirm, Switch } from '../../components/ui';
import { copyText } from './copy';
import './SystemSection.css';

type Address = HubAddress & { qrSvg: string };

const ISSUES_URL = 'https://github.com/roguecode/RaptHooker/issues';

/** The hub as a machine: its addresses with QR codes, the log viewer, restarting and the diagnostics bundle. */
export function SystemSection() {
  const { isOwner } = useLive();
  return (
    <>
      <AddressesPanel />
      {isOwner && <LogsPanel />}
      {isOwner && <MaintenancePanel />}
    </>
  );
}

const ADDRESS_INFO: Record<HubAddress['kind'], { title: string; hint: string }> = {
  lan: {
    title: tk('On your network'),
    hint: tk('Works on any device on the same network. It can change unless your router always gives the hub the same address.'),
  },
  mdns: {
    title: tk('By name'),
    hint: tk("Easy to remember. Most computers and iPhones find .local names; some Android phones can't."),
  },
  tailscale: {
    title: tk('Tailscale (HTTPS)'),
    hint: tk('Works anywhere your device is signed in to Tailscale, and is needed for notifications and installing the app.'),
  },
};

function AddressesPanel() {
  const { isOwner, toast } = useLive();
  const [addresses, setAddresses] = useState<Address[] | null>(null);
  useEffect(() => {
    let live = true;
    http.get<Address[]>('/api/system/addresses').then(
      (list) => live && setAddresses(list),
      () => live && setAddresses([]),
    );
    return () => {
      live = false;
    };
  }, [isOwner]);
  if (!addresses?.length) return null;

  const copy = async (url: string) => {
    const ok = await copyText(url);
    toast(ok ? { tone: 'success', title: t('Address copied') } : { tone: 'error', title: t("Couldn't copy"), body: url });
  };
  const here = window.location.origin;

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>
            <Icon name="external" /> {t('Open on another device')}
          </h2>
          <p>{t("Point your phone's camera at a code, or copy an address.")}</p>
        </div>
      </div>
      <div className="sys-addresses">
        {addresses.map((a) => (
          <div key={a.url} className="sys-address">
            <div className="sys-qr">
              <img src={`data:image/svg+xml;utf8,${encodeURIComponent(a.qrSvg)}`} alt={t('QR code for {url}', { url: a.url })} />
            </div>
            <div className="row">
              <strong className="spacer">{t(ADDRESS_INFO[a.kind].title)}</strong>
              {new URL(a.url).origin === here && <span className="chip success">{t("You're here")}</span>}
            </div>
            <div className="row sys-url-row">
              <a className="sys-url spacer" href={a.url}>
                {a.url}
              </a>
              <button
                type="button"
                className="btn small ghost"
                onClick={() => void copy(a.url)}
                aria-label={t('Copy {url}', { url: a.url })}
              >
                <Icon name="copy" size={14} /> {t('Copy')}
              </button>
            </div>
            <p className="hint">{t(ADDRESS_INFO[a.kind].hint)}</p>
          </div>
        ))}
      </div>
      {!isOwner && <p className="hint">{t("The owner also sees the hub's Tailscale address here, if it has one.")}</p>}
    </section>
  );
}

const LEVELS: { level: LogLevel; label: string }[] = [
  { level: 'debug', label: tk('All') },
  { level: 'info', label: tk('Info') },
  { level: 'warn', label: tk('Warnings') },
  { level: 'error', label: tk('Errors') },
];

const LEVEL_CHIP: Record<LogLevel, string> = { debug: 'chip', info: 'chip', warn: 'chip warning', error: 'chip danger' };

function logTime(at: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString(intlLocale(), { day: 'numeric', month: 'short' })} ${time}`;
}

function prettyDetail(detail: string): string {
  try {
    return JSON.stringify(JSON.parse(detail), null, 2);
  } catch {
    return detail;
  }
}

const logLine = (e: LogEntry) =>
  `${new Date(e.at).toISOString()} ${e.level.toUpperCase().padEnd(5)} ${e.svc ? `[${e.svc}] ` : ''}${e.msg}${e.detail ? ` ${e.detail}` : ''}`;

function LogsPanel() {
  const { toast } = useLive();
  const [level, setLevel] = useState<LogLevel>('info');
  const [auto, setAuto] = useState(false);
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  const load = useCallback(() => {
    http.get<LogEntry[]>(`/api/system/logs?level=${level}&limit=200`).then(
      (list) => {
        setEntries(list);
        setError(null);
      },
      (err: unknown) => setError(errorText(err)),
    );
  }, [level]);

  useEffect(() => {
    load();
    if (!auto) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [load, auto]);

  const newestFirst = entries ? [...entries].reverse() : [];
  const seen = new Map<string, number>();
  const keys = newestFirst.map((e) => {
    const base = `${e.at}:${e.level}:${e.msg}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return `${base}:${n}`;
  });
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const copyAll = async () => {
    const ok = await copyText((entries ?? []).map(logLine).join('\n'));
    toast(ok ? { tone: 'success', title: t('Log copied') } : { tone: 'error', title: t("Couldn't copy the log") });
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>
            <Icon name="list" /> {t('Logs')}
          </h2>
          <p>{t('What the hub has been doing lately, newest first. Click a line with more detail to open it.')}</p>
        </div>
        <div className="row">
          <button type="button" className="btn small ghost" onClick={load}>
            <Icon name="refresh" size={14} /> {t('Refresh')}
          </button>
          <button type="button" className="btn small ghost" onClick={() => void copyAll()} disabled={!entries?.length}>
            <Icon name="copy" size={14} /> {t('Copy')}
          </button>
        </div>
      </div>
      <div className="row sys-log-tools">
        <div className="segmented" role="group" aria-label={t('Show')}>
          {LEVELS.map((l) => (
            <button key={l.level} type="button" className={level === l.level ? 'on' : ''} onClick={() => setLevel(l.level)}>
              {t(l.label)}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <label className="row small muted">
          <Switch on={auto} onChange={setAuto} label={t('Refresh every 5 seconds')} /> {t('Auto-refresh')}
        </label>
      </div>
      {error && <p className="field-error">{error}</p>}
      <div className="sys-logs">
        {entries && !newestFirst.length && <p className="muted sys-log-empty">{t('Nothing logged at this level yet.')}</p>}
        {newestFirst.map((e, i) => {
          const key = keys[i]!;
          const expanded = open.has(key);
          const line = (
            <>
              <span className="t">{logTime(e.at)}</span>
              <span className={LEVEL_CHIP[e.level]}>{e.level}</span>
              {e.svc && <span className="svc">{e.svc}</span>}
              <span className="msg">{e.msg}</span>
            </>
          );
          return e.detail ? (
            <div key={key} className={`sys-log has-detail${expanded ? ' open' : ''}`}>
              <button type="button" className="sys-log-line" aria-expanded={expanded} onClick={() => toggle(key)}>
                {line}
              </button>
              {expanded && <pre>{prettyDetail(e.detail)}</pre>}
            </div>
          ) : (
            <div key={key} className="sys-log">
              <div className="sys-log-line">{line}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

type RestartPhase = 'idle' | 'restarting' | 'stopped';

function MaintenancePanel() {
  const { toast } = useLive();
  const [confirming, setConfirming] = useState(false);
  const [phase, setPhase] = useState<RestartPhase>('idle');
  const polling = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearInterval(polling.current), []);

  const restart = async () => {
    let before: number | null = null;
    try {
      before = (await http.get<HubStatus>('/api/status')).startedAt;
    } catch {
      // Carry on: we'll wait for it to answer again.
    }
    let supervised: boolean;
    try {
      supervised = (await http.post<{ supervised: boolean }>('/api/system/restart')).supervised;
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't restart"), body: errorText(err) });
      return;
    }
    if (!supervised) {
      setPhase('stopped');
      toast({ tone: 'warning', title: t('RaptHooker has stopped'), body: t("It doesn't restart by itself here: start it again.") });
      return;
    }
    setPhase('restarting');
    const started = Date.now();
    window.clearInterval(polling.current);
    polling.current = window.setInterval(() => {
      if (Date.now() - started > 120_000) {
        window.clearInterval(polling.current);
        setPhase('idle');
        toast({ tone: 'warning', title: t("The hub hasn't come back yet"), body: t('Give it a minute, then reload the page.') });
        return;
      }
      http.get<HubStatus>('/api/status').then(
        (s) => {
          if (before !== null && s.startedAt === before) return;
          window.clearInterval(polling.current);
          setPhase('idle');
          toast({ tone: 'success', title: t('RaptHooker is back') });
        },
        () => undefined,
      );
    }, 2000);
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>
            <Icon name="cpu" /> {t('Restart and diagnostics')}
          </h2>
          <p>{t("For when something seems stuck, or you'd like help with a problem.")}</p>
        </div>
      </div>
      <div className="sys-action">
        <div className="grow">
          <h3>{t('Restart the hub')}</h3>
          <p>{t('Starts RaptHooker again. Recording pauses for a few seconds; your data and brews carry on.')}</p>
          {phase === 'restarting' && <p className="sys-status">{t('Restarting… this page reconnects by itself.')}</p>}
          {phase === 'stopped' && <p className="sys-status">{t('Stopped. Start it again, then reload this page.')}</p>}
        </div>
        <button type="button" className="btn" disabled={phase === 'restarting'} onClick={() => setConfirming(true)}>
          <Icon name="refresh" size={16} /> {phase === 'restarting' ? t('Restarting…') : t('Restart')}
        </button>
      </div>
      <div className="sys-action">
        <div className="grow">
          <h3>{t('Download diagnostics')}</h3>
          <p>
            <Trans
              text={t(
                "A file to attach to a {link}: the hub's status and settings, Bluetooth details, the last 500 log lines and the last 200 Bluetooth broadcasts heard.",
              )}
              values={{
                link: (
                  <a href={ISSUES_URL} target="_blank" rel="noreferrer">
                    {t('GitHub issue')}
                  </a>
                ),
              }}
            />{' '}
            {t(
              "Bluetooth and IP addresses, names, web addresses, tokens and passwords are taken out, so it's safe to share, but have a quick look through it first.",
            )}
          </p>
        </div>
        <a className="btn" href="/api/system/diagnostics" download>
          <Icon name="download" size={16} /> {t('Download')}
        </a>
      </div>
      {confirming && (
        <Confirm
          title={t('Restart the hub?')}
          body={t(
            'Recording pauses for a few seconds while RaptHooker starts again (a reading sent just then may be missed). Your data and running brews are kept.',
          )}
          confirm={t('Restart')}
          onConfirm={restart}
          onClose={() => setConfirming(false)}
        />
      )}
    </section>
  );
}
