import { PRESETS, presetTrust, UNTESTED_PRESET_NOTE, type WebhookPreset } from '@rapthooker/shared';
import { t, tk } from '../../i18n';
import { Trans } from '../../i18n/Trans';
import { Icon } from '../../components/Icon';
import './webhooks.css';

const ISSUES_URL = 'https://github.com/roguecode/RaptHooker/issues';
const VERIFIED_NOTE = tk('Tried against the real service and working.');

/** "Verified" or "Untested" (nothing for presets that go to your own server). */
export function PresetTrust({ preset }: { preset: WebhookPreset }) {
  const trust = presetTrust(preset);
  if (trust === null) return null;
  return trust === 'verified' ? (
    <span className="chip success preset-trust" title={t(VERIFIED_NOTE)}>
      <Icon name="check" size={12} /> {t('Verified')}
    </span>
  ) : (
    <span className="chip warning preset-trust" title={t(UNTESTED_PRESET_NOTE)}>
      {t('Untested')}
    </span>
  );
}

export function PresetGrid({ onPick }: { onPick: (p: WebhookPreset) => void }) {
  return (
    <div className="stack">
      <div className="presets">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" className="preset" onClick={() => onPick(p)}>
            <span className="badge">{p.badge}</span>
            <span className="preset-text">
              <span className="preset-name">
                <strong>{p.name}</strong>
                <PresetTrust preset={p} />
              </span>
              <span>{t(p.tagline)}</span>
            </span>
          </button>
        ))}
      </div>
      <p className="hint" style={{ margin: 0 }}>
        <Trans
          text={t(
            "{untested} presets are built from each service's documentation and other open-source projects, but haven't been tried against the real service yet.",
          )}
          values={{ untested: <strong>{t('Untested')}</strong> }}
        />{' '}
        <Trans
          text={t('Use {send} and check the delivery log, and please {link} whether it works.')}
          values={{
            send: <em>{t('Send a test now')}</em>,
            link: (
              <a href={ISSUES_URL} target="_blank" rel="noreferrer">
                {t('tell us on GitHub')}
              </a>
            ),
          }}
        />
      </p>
    </div>
  );
}

/** Setup steps and notes for the chosen service. */
export function PresetSetup({ preset }: { preset: WebhookPreset }) {
  const untested = presetTrust(preset) === 'untested';
  if (preset.setup.length === 0 && preset.notes.length === 0 && !untested) return null;
  return (
    <section className="panel stack">
      <h3 style={{ margin: 0 }}>
        {preset.badge} {t('Setting up {name}', { name: preset.name })} <PresetTrust preset={preset} />
      </h3>
      {untested && (
        <div className="notice warning small wh-notice">
          <Icon name="alert" />
          <p className="grow">
            {t(UNTESTED_PRESET_NOTE)}{' '}
            <a href={ISSUES_URL} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>
              {t('Report on GitHub')}
            </a>
          </p>
        </div>
      )}
      {preset.setup.length > 0 && (
        <ol className="steps">
          {preset.setup.map((s) => (
            <li key={s}>{t(s)}</li>
          ))}
        </ol>
      )}
      {preset.notes.map((n) => (
        <p key={n} className="small muted" style={{ margin: 0 }}>
          ℹ️ {t(n)}
        </p>
      ))}
      {preset.docsUrl && (
        <a className="small" href={preset.docsUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--violet-2)' }}>
          {t('{name} documentation', { name: preset.name })} <Icon name="external" size={12} />
        </a>
      )}
    </section>
  );
}
