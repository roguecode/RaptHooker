import type { BodyFormat, HttpMethod, RenderedRequest, WebhookHeader } from './types.js';

export type TemplateValue = string | number | boolean | null;
export type TemplateContext = Record<string, TemplateValue>;

/** Where a value is inserted decides how it's escaped. */
export type TemplateMode = 'json' | 'url' | 'form' | 'text' | 'header';

/** `{{name}}` or `{{name|fallback}}` (the fallback is used when the value is empty/null). */
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*(?:\|([^}]*))?\}\}/g;

export interface RenderResult {
  text: string;
  unknown: string[];
}

function escape(text: string, mode: TemplateMode): string {
  switch (mode) {
    case 'json':
      return JSON.stringify(text).slice(1, -1);
    case 'url':
    case 'form':
      return encodeURIComponent(text);
    case 'header':
      return text.replace(/[\r\n]+/g, ' ');
    default:
      return text;
  }
}

/**
 * Replaces `{{variables}}`. In JSON, strings are escaped without adding quotes (write `"{{name}}"`), numbers are
 * inserted bare (write `{{gravity}}`), and a missing value becomes `null` unless a fallback is given. `raw` values are
 * inserted exactly as they are (for already-rendered pieces like a batch's `{{items}}`).
 */
export function renderTemplate(template: string, ctx: TemplateContext, mode: TemplateMode, raw: Record<string, string> = {}): RenderResult {
  const unknown = new Set<string>();
  const text = template.replace(PLACEHOLDER, (_match, key: string, fallback: string | undefined) => {
    if (Object.hasOwn(raw, key)) return raw[key]!;
    if (!Object.hasOwn(ctx, key)) unknown.add(key);
    // Only the context's own values: {{constructor}} or {{toString}} must not reach Object.prototype.
    const value = Object.hasOwn(ctx, key) ? ctx[key] : undefined;
    if (value === null || value === undefined || value === '') {
      if (fallback !== undefined) return mode === 'json' ? fallback.trim() : escape(fallback, mode);
      if (mode === 'json' && (value === null || value === undefined)) return 'null';
      return '';
    }
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : mode === 'json' ? 'null' : '';
    if (typeof value === 'boolean') return String(value);
    return escape(value, mode);
  });
  return { text, unknown: [...unknown] };
}

/** Placeholder names used in a template. */
export function templateVariables(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
}

export const CONTENT_TYPES: Record<BodyFormat, string | null> = {
  json: 'application/json',
  form: 'application/x-www-form-urlencoded',
  text: 'text/plain; charset=utf-8',
  none: null,
};

/** `<SOMETHING>` left in a URL, header or body from a preset that still needs filling in. */
export const UNFILLED = /<[A-Z][A-Z0-9_ ]*>/;

export interface RequestTemplate {
  url: string;
  method: HttpMethod;
  headers: WebhookHeader[];
  bodyFormat: BodyFormat;
  body: string;
}

export interface BatchTemplate extends RequestTemplate {
  batchBody: string;
}

/** Body formats that can carry several pills in one request. */
export const BATCH_FORMATS: readonly BodyFormat[] = ['json', 'text'];

/** What separates the pills' rendered bodies in `{{items}}`: commas in JSON, new lines in plain text. */
export const batchSeparator = (format: BodyFormat): string => (format === 'text' ? '\n' : ',');

const bodyMode = (format: BodyFormat): TemplateMode => (format === 'json' ? 'json' : format === 'form' ? 'form' : 'text');

class Renderer {
  readonly unknown = new Set<string>();
  readonly warnings: string[] = [];

  render(template: string, ctx: TemplateContext, mode: TemplateMode, raw?: Record<string, string>): string {
    const r = renderTemplate(template, ctx, mode, raw);
    for (const u of r.unknown) this.unknown.add(u);
    return r.text;
  }

  /** URL and headers, then the checks every request gets. */
  finish(hook: RequestTemplate, ctx: TemplateContext, body: string | null, templates: string[]): RenderedRequest {
    const url = this.render(hook.url.trim(), ctx, 'url');
    const headers = hook.headers
      .filter((h) => h.name.trim() !== '')
      .map((h) => ({ name: h.name.trim(), value: this.render(h.value, ctx, 'header') }));
    const sendsBody = body !== null;
    const warnings: string[] = [];
    if (!/^https?:\/\/[^\s/]+/i.test(url)) warnings.push('The URL must start with http:// or https://');
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]*@/i.test(url)) {
      warnings.push('Put a username or password in an Authorization header rather than in the URL');
    }
    if (
      UNFILLED.test(hook.url) ||
      hook.headers.some((h) => UNFILLED.test(h.value)) ||
      (sendsBody && templates.some((t) => UNFILLED.test(t)))
    ) {
      warnings.push('Replace the <PLACEHOLDERS> from the preset with your own details');
    }
    warnings.push(...this.warnings);
    for (const u of this.unknown) warnings.push(`Unknown variable {{${u}}}`);
    if (body !== null && hook.bodyFormat === 'json') {
      try {
        JSON.parse(body);
      } catch (err) {
        warnings.push(`The body isn't valid JSON: ${(err as Error).message}`);
      }
    }
    const contentType = sendsBody ? CONTENT_TYPES[hook.bodyFormat] : null;
    return { method: hook.method, url, headers, body, contentType, warnings };
  }
}

/** Renders a webhook's URL, headers and body for one reading. */
export function renderRequest(hook: RequestTemplate, ctx: TemplateContext): RenderedRequest {
  const r = new Renderer();
  const sendsBody = hook.method !== 'GET' && hook.bodyFormat !== 'none';
  const body = sendsBody ? r.render(hook.body, ctx, bodyMode(hook.bodyFormat)) : null;
  return r.finish(hook, ctx, body, [hook.body]);
}

/**
 * Renders one request carrying several pills (batch mode): `body` is rendered for each pill and the results, joined
 * with commas (JSON) or new lines (plain text), go into `{{items}}` in `batchBody`. The URL, headers and batch body
 * get `batchCtx` (no pill variables).
 */
export function renderBatchRequest(hook: BatchTemplate, items: TemplateContext[], batchCtx: TemplateContext): RenderedRequest {
  const r = new Renderer();
  const mode = bodyMode(hook.bodyFormat);
  if (hook.method === 'GET' || !BATCH_FORMATS.includes(hook.bodyFormat)) {
    r.warnings.push('Sending all pills in one request needs a JSON or plain-text body (and not GET)');
  }
  if (!/\{\{\s*items\s*\}\}/.test(hook.batchBody)) r.warnings.push('Put {{items}} in the batch body where the readings go');
  const joined = items.map((ctx) => r.render(hook.body, ctx, mode).trim()).join(batchSeparator(hook.bodyFormat));
  const sendsBody = hook.method !== 'GET' && hook.bodyFormat !== 'none';
  const body = sendsBody ? r.render(hook.batchBody, batchCtx, mode, { items: joined }) : null;
  return r.finish(hook, batchCtx, body, [hook.body, hook.batchBody]);
}
