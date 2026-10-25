import { Fragment, type ReactNode } from 'react';

/**
 * A translated sentence with links or other elements in it, so the sentence stays whole for translators:
 * `<Trans text={t('Open {link} to add one.')} values={{ link: <a href="#/settings">{t('Settings')}</a> }} />`.
 * `{placeholders}` without a value are left as they are.
 */
export function Trans({ text, values }: { text: string; values: Record<string, ReactNode> }) {
  const parts = text.split(/\{(\w+)\}/);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 0 ? part : <Fragment key={i}>{Object.prototype.hasOwnProperty.call(values, part) ? values[part] : `{${part}}`}</Fragment>,
      )}
    </>
  );
}
