import { useEffect, useState } from 'react';
import { api, errorText } from '../../api';
import { useLive } from '../../live';
import { href } from '../../router';
import { t } from '../../i18n';
import { Icon } from '../../components/Icon';
import { Confirm } from '../../components/ui';

/** Archived and ignored pills. */
export function PillsSection() {
  const { pills, isOwner, toast, upsertPill } = useLive();
  const [ignored, setIgnored] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<string | null>(null);
  useEffect(() => {
    api.settings().then(
      (s) => setIgnored(s.ignored),
      () => undefined,
    );
  }, []);
  const archived = pills.filter((p) => p.archived);
  if (archived.length === 0 && ignored.length === 0) return null;
  const pill = pills.find((p) => p.id === deleting);
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          <Icon name="archive" /> {t('Archived and ignored pills')}
        </h2>
      </div>
      <div className="list">
        {archived.map((p) => (
          <div key={p.id} className="list-item">
            <span className="status-dot" style={{ background: p.color }} />
            <div className="grow">
              <h4>
                <a href={href.pill(p.id)}>{p.name}</a>
              </h4>
              <p>{t('Archived: not recording. History and brews are kept.')}</p>
            </div>
            {isOwner && (
              <>
                <button
                  type="button"
                  className="btn small"
                  onClick={() =>
                    api
                      .updatePill(p.id, { archived: false })
                      .then(upsertPill, (e) => toast({ tone: 'error', title: t('Failed'), body: errorText(e) }))
                  }
                >
                  <Icon name="play" size={14} /> {t('Record again')}
                </button>
                <button
                  type="button"
                  className="btn small icon ghost"
                  aria-label={t('Delete {name}', { name: p.name })}
                  title={t('Delete')}
                  onClick={() => setDeleting(p.id)}
                >
                  <Icon name="trash" size={16} />
                </button>
              </>
            )}
          </div>
        ))}
        {ignored.map((a) => (
          <div key={a} className="list-item">
            <span className="status-dot" />
            <div className="grow">
              <h4 className="num">{a}</h4>
              <p>{t('Ignored: not shown when heard nearby.')}</p>
            </div>
            {isOwner && (
              <button
                type="button"
                className="btn small"
                onClick={() =>
                  api.ignoreNearby(a, false).then(
                    (r) => setIgnored(r.ignored),
                    (e) => toast({ tone: 'error', title: t('Failed'), body: errorText(e) }),
                  )
                }
              >
                {t('Stop ignoring')}
              </button>
            )}
          </div>
        ))}
      </div>
      {pill && (
        <Confirm
          title={t('Delete {name}?', { name: pill.name })}
          body={<p>{t('All of its readings and brews are deleted for good.')}</p>}
          confirm={t('Delete everything')}
          danger
          onClose={() => setDeleting(null)}
          onConfirm={() => api.deletePill(pill.id).catch((e) => toast({ tone: 'error', title: t('Failed'), body: errorText(e) }))}
        />
      )}
    </section>
  );
}
