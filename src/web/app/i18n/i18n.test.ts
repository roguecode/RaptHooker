import { afterEach, describe, expect, it } from 'vitest';
import { browserLocale, setCatalog, t, tc, tp } from './index';

afterEach(() => setCatalog('en', {}));

describe('i18n', () => {
  it('falls back to the English text and fills placeholders', () => {
    expect(t('Hello {name}', { name: 'Ann' })).toBe('Hello Ann');
    expect(tp(1, '{count} reading', '{count} readings')).toBe('1 reading');
    expect(tp(1200, '{count} reading', '{count} readings')).toBe('1,200 readings');
  });

  it('uses the catalogue, with the language’s plural rules', () => {
    setCatalog('pl', {
      'Hello {name}': 'Cześć {name}',
      '{count} reading|{count} readings': {
        one: '{count} odczyt',
        few: '{count} odczyty',
        many: '{count} odczytów',
        other: '{count} odczytu',
      },
    });
    expect(t('Hello {name}', { name: 'Ann' })).toBe('Cześć Ann');
    expect(tp(1, '{count} reading', '{count} readings')).toBe('1 odczyt');
    expect(tp(3, '{count} reading', '{count} readings')).toBe('3 odczyty');
    expect(tp(5, '{count} reading', '{count} readings')).toBe('5 odczytów');
    expect(t('Not translated')).toBe('Not translated');
  });

  it('keeps words with two meanings apart by context', () => {
    setCatalog('de', { Light: 'Hell', 'smoothing::Light': 'Leicht' });
    expect(t('Light')).toBe('Hell');
    expect(tc('smoothing', 'Light')).toBe('Leicht');
    expect(tc('smoothing', 'Strong')).toBe('Strong');
  });

  it('picks the closest supported browser language', () => {
    expect(browserLocale(['de-AT', 'en'])).toBe('de');
    expect(browserLocale(['pt-PT'])).toBe('pt-BR');
    expect(browserLocale(['ja'])).toBe('en');
  });
});
