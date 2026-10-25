import { useEffect, useState } from 'react';
import type { HubStatus } from '@rapthooker/shared';
import changelog from '../../../../CHANGELOG.md?raw';
import { http } from '../api';
import { changelogSections, Markdown, type ChangelogSection } from '../markdown';
import { Modal } from './ui';
import { Icon } from './Icon';
import { t } from '../i18n';
import './WhatsNew.css';

export const RELEASES_URL = 'https://github.com/roguecode/RaptHooker/releases';
export const UPDATE_DOCS_URL = 'https://github.com/roguecode/RaptHooker/blob/main/docs/updating.md';

const SECTIONS = changelogSections(changelog);
const SEEN_KEY = 'lastSeenVersion';

/** x.y.z as numbers, ignoring a pre-release tag (0.3.0-dev counts as 0.3.0). */
function core(version: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

/** The changelog entry for one version (bundled with this web app). */
export function changelogFor(version: string): ChangelogSection | null {
  const v = core(version);
  return (v && SECTIONS.find((s) => core(s.version) && compare(core(s.version)!, v) === 0)) || null;
}

/** Entries newer than `from`, up to and including `to`, newest first. */
export function changelogBetween(from: string, to: string): ChangelogSection[] {
  const a = core(from);
  const b = core(to);
  if (!a || !b) return [];
  return SECTIONS.filter((s) => {
    const v = core(s.version);
    return v !== null && compare(v, a) > 0 && compare(v, b) <= 0;
  });
}

function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

function writeSeen(version: string): void {
  try {
    localStorage.setItem(SEEN_KEY, version);
  } catch {
    // Private browsing: it shows again next time, which is harmless.
  }
}

/** "What's new in X", shown once after the hub has been updated. */
export function WhatsNew() {
  const [shown, setShown] = useState<{ version: string; sections: ChangelogSection[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    http.get<HubStatus>('/api/status').then(
      ({ version }) => {
        if (cancelled) return;
        const seen = readSeen();
        if (seen === version) return;
        // A first visit has nothing to compare with: there's no point telling someone new what changed.
        const sections = seen ? changelogBetween(seen, version) : [];
        if (sections.length) setShown({ version, sections });
        else writeSeen(version);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (!shown) return null;
  const close = () => {
    writeSeen(shown.version);
    setShown(null);
  };
  return (
    <Modal
      wide
      onClose={close}
      title={
        <span className="whats-new-title">
          <Icon name="sparkles" /> {t("What's new in RaptHooker {version}", { version: shown.version.replace(/-.*$/, '') })}
        </span>
      }
    >
      {shown.sections.map((s) => (
        <section key={s.version} className="whats-new-section">
          {shown.sections.length > 1 && <h3>{s.version}</h3>}
          <Markdown text={s.body} minLevel={4} />
        </section>
      ))}
      <div className="modal-actions">
        <a className="btn ghost" href={RELEASES_URL} target="_blank" rel="noreferrer noopener">
          {t('All releases')} <Icon name="external" size={15} />
        </a>
        <button type="button" className="btn primary" onClick={close}>
          {t('Got it')}
        </button>
      </div>
    </Modal>
  );
}
