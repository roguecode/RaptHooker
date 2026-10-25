import { t } from '../../i18n';

export function SparkleLine() {
  // i18n: a playful tagline; keep the capitals for emphasis
  const text = t('Create UNLIMITED FREE webhooks');
  return (
    <div className="sparkle-line">
      <span className="spark">✨</span>
      <span className="shine">{text}</span>
      <span className="spark">✨</span>
    </div>
  );
}
