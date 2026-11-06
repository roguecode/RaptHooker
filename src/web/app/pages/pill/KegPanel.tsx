import { useEffect, useId, useMemo, useState } from 'react';
import { kegStartSchema, type Brew, type Keg, type Pill } from '@rapthooker/shared';
import { api, errorText } from '../../api';
import { useLive, useLiveMessages } from '../../live';
import { useUnits } from '../../units';
import { href } from '../../router';
import { dateOnly, dateTime, days, fixed, fromLocalInput, toLocalInput, useNow } from '../../format';
import { Icon } from '../../components/Icon';
import { CollapsiblePanel, usePanelOpen } from '../../components/CollapsiblePanel';
import { Confirm, Modal } from '../../components/ui';
import { FieldError, useFormCheck } from '../../validation';
import { t, tk } from '../../i18n';
import { kegLevels, kegName } from '../devices/keg';

/** How long after kegging up the fullest reading counts as how much went in (as the hub works it out). */
const START_WINDOW_MS = 6 * 3_600_000;

/** The beer kegged up under a Laser Level: how much of it is left, and the ones before it. */
export function KegPanel({ pill }: { pill: Pill }) {
  const { isOwner, toast } = useLive();
  const u = useUnits();
  const now = useNow(60_000);
  const [open, toggle] = usePanelOpen('pill.keg', true);
  const [editing, setEditing] = useState<Keg | 'new' | null>(null);
  const [emptying, setEmptying] = useState<Keg | null>(null);
  const [deleting, setDeleting] = useState<Keg | null>(null);
  const [kegs, setKegs] = useState<Keg[] | null>(null);
  const keg = pill.keg ?? null;
  const own = pill.servingUnit;
  const canEdit = isOwner && !pill.archived;

  useEffect(() => {
    let live = true;
    api
      .kegs(pill.id)
      .then((list) => live && setKegs(list))
      .catch(() => live && setKegs([]));
    return () => {
      live = false;
    };
  }, [pill.id]);
  useLiveMessages((msg) => {
    if (msg.type === 'keg' && msg.keg.pillId === pill.id) {
      setKegs((list) => (list ? [msg.keg, ...list.filter((k) => k.id !== msg.keg.id)].sort((a, b) => b.keggedAt - a.keggedAt) : list));
    } else if (msg.type === 'keg-removed' && msg.pillId === pill.id) {
      setKegs((list) => list?.filter((k) => k.id !== msg.kegId) ?? list);
    }
  });
  const earlier = (kegs ?? []).filter((k) => k.endedAt !== null);
  const levels = keg ? kegLevels(keg, pill.live.latest?.volume) : null;
  const settling = keg !== null && now - keg.keggedAt < START_WINDOW_MS;

  const earlierList = earlier.length > 0 && (
    <div className="stack" style={{ gap: '0.3rem' }}>
      <h3 className="subhead">{t('Earlier kegs')}</h3>
      <ul className="list" aria-label={t('Earlier kegs')}>
        {earlier.map((k) => (
          <li key={k.id} className="list-item">
            <div className="grow">
              <h4>
                {kegName(k)}
                {k.style && <span className="muted"> · {k.style}</span>}
              </h4>
              <p>
                {[
                  t('{from} to {to}', { from: dateOnly(k.keggedAt), to: dateOnly(k.endedAt) }),
                  k.startVolume === null ? null : t('Kegged {amount}', { amount: u.volumeText(k.startVolume, own, true) }),
                  k.abv === null ? null : t('{abv}% ABV', { abv: fixed(k.abv, 1) }),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </div>
            {canEdit && (
              <div className="row" style={{ gap: '0.3rem' }}>
                <button
                  type="button"
                  className="btn small ghost"
                  title={t('Edit')}
                  aria-label={t('Edit {name}', { name: kegName(k) })}
                  onClick={() => setEditing(k)}
                >
                  <Icon name="pencil" size={14} />
                </button>
                <button
                  type="button"
                  className="btn small ghost danger"
                  title={t('Delete')}
                  aria-label={t('Delete {name}', { name: kegName(k) })}
                  onClick={() => setDeleting(k)}
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <>
      {keg && levels ? (
        <CollapsiblePanel
          open={open}
          onToggle={toggle}
          title={
            <>
              <Icon name="beer" /> {kegName(keg)}
            </>
          }
          badges={<span className="chip brew">{t('On tap')}</span>}
          lead={`${keg.style ? `${keg.style} · ` : ''}${t('kegged {date} ({days} ago)', { date: dateTime(keg.keggedAt), days: days(now - keg.keggedAt) })}`}
          actions={
            <>
              {keg.brewId && (
                <a className="btn small" href={href.brew(keg.brewId)}>
                  {/* i18n: a link to the brew a kegged beer came from */}
                  {t('Its brew')} <Icon name="right" size={16} />
                </a>
              )}
              {canEdit && (
                <>
                  <button type="button" className="btn small" onClick={() => setEditing(keg)}>
                    <Icon name="pencil" size={14} /> {t('Edit')}
                  </button>
                  <button type="button" className="btn small danger" onClick={() => setEmptying(keg)}>
                    <Icon name="stop" size={14} /> {t('Keg empty')}
                  </button>
                </>
              )}
            </>
          }
        >
          <div className="stack">
            <div className="stat-row">
              <Stat k={t('Went in')} v={u.volumeText(keg.startVolume, own, true)} />
              <Stat k={t('Left')} v={u.volumeText(levels.left, own)} />
              <Stat k={t('Poured')} v={u.volumeText(levels.poured, own)} />
              <Stat k="ABV" v={keg.abv === null ? '–' : fixed(keg.abv, 1)} s={keg.abv === null ? undefined : '%'} />
            </div>
            {settling && (
              <p className="hint" style={{ margin: 0 }}>
                {t('How much went in is the fullest the keg reads in the 6 hours after kegging up, so fill it before or after.')}
              </p>
            )}
            {earlierList}
          </div>
        </CollapsiblePanel>
      ) : (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>
                <Icon name="beer" /> {t('Keg')}
              </h2>
              <p>{t('Nothing is kegged up here. Keg up a beer to keep track of how much of it is left.')}</p>
            </div>
            {canEdit && (
              <div className="row">
                <button type="button" className="btn primary" onClick={() => setEditing('new')}>
                  <Icon name="plus" size={16} /> {t('Keg up')}
                </button>
              </div>
            )}
          </div>
          {earlierList}
        </section>
      )}
      {editing && <KegModal pill={pill} keg={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {emptying && (
        <Confirm
          title={t('Is "{name}" empty?', { name: kegName(emptying) })}
          body={<p>{t('It moves to the earlier kegs. The Laser Level carries on recording either way.')}</p>}
          confirm={t('Keg empty')}
          danger
          onClose={() => setEmptying(null)}
          onConfirm={async () => {
            try {
              await api.endKeg(emptying.id);
              toast({ tone: 'success', title: t('Keg emptied'), body: t('{name} has been saved.', { name: kegName(emptying) }) });
            } catch (err) {
              toast({ tone: 'error', title: t("Couldn't empty the keg"), body: errorText(err) });
            }
          }}
        />
      )}
      {deleting && (
        <Confirm
          title={t('Delete "{name}"?', { name: kegName(deleting) })}
          body={<p>{t("Only the keg's details are deleted: the Laser Level's readings stay.")}</p>}
          confirm={t('Delete')}
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await api.deleteKeg(deleting.id);
            } catch (err) {
              toast({ tone: 'error', title: t("Couldn't delete it"), body: errorText(err) });
            }
          }}
        />
      )}
    </>
  );
}

function Stat({ k, v, s }: { k: string; v: string; s?: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v">
        {v}
        {s && <small>{s}</small>}
      </div>
    </div>
  );
}

const LABELS = {
  name: tk('Name'),
  style: tk('Style'),
  abv: tk('ABV (%)'),
  brewId: tk('Fill in from a brew'),
  keggedAt: tk('Kegged up at'),
};

/** A brew as a choice to fill a keg in from. */
const brewChoice = (b: Brew): string =>
  [b.name, b.style, b.stats.abv === null ? null : t('{abv}% ABV', { abv: fixed(b.stats.abv, 1) }), dateOnly(b.startedAt)]
    .filter(Boolean)
    .join(' · ');

/** Kegging up a beer (keg null), or changing one. Everything's optional; picking a brew only fills the boxes in. */
export function KegModal({ pill, keg, onClose }: { pill: Pill; keg: Keg | null; onClose: () => void }) {
  const { toast } = useLive();
  const [name, setName] = useState(keg?.name ?? '');
  const [style, setStyle] = useState(keg?.style ?? '');
  const [abv, setAbv] = useState(keg?.abv == null ? '' : String(keg.abv));
  const [brewId, setBrewId] = useState<string | null>(keg?.brewId ?? null);
  const [earlier, setEarlier] = useState(keg !== null);
  const [keggedAt, setKeggedAt] = useState(toLocalInput(keg?.keggedAt ?? Date.now() - 3_600_000));
  const [brews, setBrews] = useState<Brew[] | null>(null);
  const [busy, setBusy] = useState(false);
  const brewField = useId();
  const replacing = keg === null && pill.keg ? pill.keg : null;

  useEffect(() => {
    let live = true;
    api
      .brews()
      .then((list) => live && setBrews(list))
      .catch(() => live && setBrews([]));
    return () => {
      live = false;
    };
  }, []);
  const choices = useMemo(() => [...(brews ?? [])].sort((a, b) => b.startedAt - a.startedAt), [brews]);

  const abvValue = abv.trim() === '' ? null : Number(abv.replace(',', '.'));
  // An unchanged time is left alone: the hub works out again how much went in when it changes.
  const movedAt = earlier && (keg === null || keggedAt !== toLocalInput(keg.keggedAt));
  const body = {
    pillId: pill.id,
    name: name.trim(),
    style: style.trim(),
    abv: abvValue,
    brewId,
    keggedAt: movedAt ? fromLocalInput(keggedAt) : undefined,
  };
  const check = useFormCheck(kegStartSchema, body, LABELS);
  const { errors } = check;
  const failed = keg ? t("Couldn't save the keg") : t("Couldn't keg it up");

  const pick = (id: string) => {
    if (!id) return setBrewId(null);
    const b = choices.find((c) => c.id === id);
    if (!b) return;
    setBrewId(b.id);
    setName(b.name);
    setStyle(b.style ?? '');
    setAbv(b.stats.abv === null ? '' : String(Math.round(b.stats.abv * 10) / 10));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!check.ok(failed)) return;
    setBusy(true);
    try {
      const { pillId, ...input } = body;
      if (keg) {
        await api.updateKeg(keg.id, input);
        toast({ tone: 'success', title: t('Saved') });
      } else {
        const saved = await api.startKeg(pillId, input);
        toast({ tone: 'success', title: t('{name} kegged up', { name: kegName(saved) }), body: t('Cheers! 🍻') });
      }
      onClose();
    } catch (err) {
      toast({ tone: 'error', title: failed, body: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={keg ? t('Edit {name}', { name: kegName(keg) }) : t('Keg up')} onClose={onClose}>
      {!keg && (
        <p className="muted small">
          {t('Under {device}. Everything here is optional: how much is left comes from the Laser Level.', { device: pill.name })}
        </p>
      )}
      {replacing && (
        <div className="notice warning">
          <Icon name="alert" />
          <p>{t('{name} is still on tap: kegging up another beer marks it empty.', { name: kegName(replacing) })}</p>
        </div>
      )}
      <form className="stack" onSubmit={submit}>
        {choices.length > 0 && (
          <div className="field">
            <label className="label" htmlFor={brewField}>
              {t('Fill in from a brew')}
            </label>
            <select id={brewField} className="select" value={brewId ?? ''} onChange={(e) => pick(e.target.value)}>
              <option value="">{t('None')}</option>
              {choices.map((b) => (
                <option key={b.id} value={b.id}>
                  {brewChoice(b)}
                </option>
              ))}
            </select>
            <span className="hint">{t('Only fills in the boxes below: change anything you like.')}</span>
          </div>
        )}
        <label className="field">
          <span>{t('Name')}</span>
          <input className="input" maxLength={60} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Pale ale" />
          <FieldError error={errors.name} />
        </label>
        <div className="form-grid">
          <label className="field">
            <span>{t('Style')}</span>
            <input
              className="input"
              maxLength={60}
              value={style}
              onChange={(e) => setStyle(e.target.value)}
              placeholder="American Pale Ale"
            />
            <FieldError error={errors.style} />
          </label>
          <label className="field">
            <span>{t('ABV (%)')}</span>
            <input
              className="input num"
              type="number"
              inputMode="decimal"
              min={0}
              max={30}
              step={0.1}
              value={abv}
              onChange={(e) => setAbv(e.target.value)}
              placeholder="5.2"
            />
            <FieldError error={errors.abv && tk('Between 0 and 30')} />
          </label>
        </div>
        {!keg && (
          <label className="check">
            <input type="checkbox" checked={earlier} onChange={(e) => setEarlier(e.target.checked)} />
            <span>
              {t('It was kegged earlier')}
              <small>{t('Count the readings since then.')}</small>
            </span>
          </label>
        )}
        {earlier && (
          <label className="field">
            <span>{t('Kegged up at')}</span>
            <input
              className="input"
              type="datetime-local"
              value={keggedAt}
              max={toLocalInput(Date.now())}
              onChange={(e) => setKeggedAt(e.target.value)}
            />
            <FieldError error={errors.keggedAt && tk('Pick a date and time')} />
          </label>
        )}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {keg ? (
              <>
                <Icon name="check" size={16} /> {t('Save')}
              </>
            ) : (
              <>
                <Icon name="beer" size={16} /> {t('Keg up')}
              </>
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}
