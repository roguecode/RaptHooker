// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setCatalog, t } from './index';
import { Trans } from './Trans';

afterEach(() => {
  cleanup();
  setCatalog('en', {});
});

describe('Trans', () => {
  it('puts elements into a translated sentence', () => {
    setCatalog('de', { 'Open {link} to add one.': 'Öffne {link}, um eine hinzuzufügen.' });
    const { container } = render(<Trans text={t('Open {link} to add one.')} values={{ link: <a href="#/settings">Settings</a> }} />);
    expect(container.textContent).toBe('Öffne Settings, um eine hinzuzufügen.');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('#/settings');
  });

  it('keeps text placeholders filled by t() and leaves unknown ones alone', () => {
    const { container } = render(<Trans text={t('{name} has {link} and {other}', { name: 'Ann' })} values={{ link: <b>x</b> }} />);
    expect(container.textContent).toBe('Ann has x and {other}');
  });
});
