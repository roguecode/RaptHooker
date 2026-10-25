import { useState } from 'react';
import { checkInput, SG_LIMITS, type FieldErrors, type FormErrorMap } from '@rapthooker/shared';
import { useLive } from './live';
import { t, tk, tp } from './i18n';
import { intlLocale, num } from './format';

type Schema = Parameters<typeof checkInput>[0];

/**
 * Messages set on the schemas in @rapthooker/shared (which `npm run i18n` doesn't read), so they're translated when
 * shown. Keep the text exactly as it is there.
 */
export const SCHEMA_MESSAGES = [
  tk('A colour like #a78bfa'),
  tk('Header names can only use letters, digits and -'),
  tk('A broker address like mqtt://homeassistant.local:1883'),
  tk('No spaces, # or +'),
  tk('A URL like https://s3.eu-west-1.amazonaws.com'),
];

const NONE: FieldErrors = {};

const n = (v: unknown): string => num(Number(v), 6, 0);

/** The wording of `formErrorMap` (in @rapthooker/shared), translated. Messages set on a schema win; they're translated afterwards. */
export const webErrorMap: FormErrorMap = (iss) => {
  switch (iss.code) {
    case 'invalid_type':
      if (iss.input === undefined || iss.input === null) return t('Required');
      if (iss.expected === 'int') return t('Use a whole number');
      return iss.expected === 'number' ? t('Enter a number') : undefined;
    case 'too_small': {
      const min = Number(iss.minimum);
      if (iss.origin === 'string')
        return min <= 1 ? t('Required') : tp(min, 'Use at least {count} character', 'Use at least {count} characters');
      if (iss.origin === 'number' || iss.origin === 'int')
        return iss.inclusive === false ? t('Must be more than {min}', { min: n(min) }) : t('Must be at least {min}', { min: n(min) });
      return undefined;
    }
    case 'too_big': {
      const max = Number(iss.maximum);
      if (iss.origin === 'string') return tp(max, 'Use at most {count} character', 'Use at most {count} characters');
      if (iss.origin === 'number' || iss.origin === 'int')
        return iss.inclusive === false ? t('Must be less than {max}', { max: n(max) }) : t('Must be at most {max}', { max: n(max) });
      if (iss.origin === 'array') return t('No more than {max}', { max: n(max) });
      return undefined;
    }
    case 'invalid_value':
      return t('Pick one of the options');
    case 'invalid_format':
      return iss.format === 'url' ? t('Enter a full URL') : undefined;
    default:
      return undefined;
  }
};

/** Checks a payload like `checkInput`, with every message in the language in use. */
export function checkForm(schema: Schema, value: unknown): FieldErrors {
  const errors: FieldErrors = {};
  for (const [path, message] of Object.entries(checkInput(schema, value, webErrorMap))) errors[path] = message && t(message);
  return errors;
}

/** "a, b and c" without the "and" (as in a list of field names), in the language's style. */
function listText(items: string[]): string {
  try {
    return new Intl.ListFormat(intlLocale(), { type: 'unit', style: 'short' }).format(items);
  } catch {
    return items.join(', ');
  }
}

/**
 * Checks a form's payload with the schema the API uses, so problems show before anything is sent. Field errors
 * appear after the first try and clear as the fields are fixed. `labels` names the fields in the toast (English
 * labels marked with tk() are translated here).
 */
export function useFormCheck(schema: Schema, value: unknown, labels: Record<string, string> = {}) {
  const { toast } = useLive();
  const [tried, setTried] = useState(false);
  const errors = tried ? checkForm(schema, value) : NONE;

  /** True when the payload can be sent; otherwise shows what's wrong. */
  const ok = (title: string): boolean => {
    setTried(true);
    const found = Object.entries(checkForm(schema, value));
    if (found.length === 0) return true;
    const fields = new Set(
      found.map(([path, message = '']) => {
        const label = labels[path.split('.')[0]!];
        if (label) return t(label);
        return path ? t('{field} ({problem})', { field: path, problem: message }) : message;
      }),
    );
    toast({ tone: 'error', title, body: t('Check {fields}.', { fields: listText([...fields]) }) });
    return false;
  };

  return { errors, ok };
}

/** A field's problem under it (English messages marked with tk() are translated). */
export function FieldError({ error }: { error?: string | false }) {
  return error ? <span className="field-error">{t(error)}</span> : null;
}

/** A gravity field's error, giving the allowed range in the units on screen. */
export function gravityError(error: string | undefined, sg: number | null, gravityText: (sg: number) => string): string | undefined {
  if (!error || sg === null || !Number.isFinite(sg)) return error;
  return t('Use a gravity between {min} and {max}', { min: gravityText(SG_LIMITS.min), max: gravityText(SG_LIMITS.max) });
}
