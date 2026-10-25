import { useMemo, type ReactNode } from 'react';
import './markdown.css';

/**
 * Just enough Markdown for release notes and the changelog: headings, lists, paragraphs, **bold**, `code` and links.
 * Anything else shows as plain text. React escapes the text, and only http(s), mailto and relative links are kept.
 */
export type MarkdownBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'paragraph'; text: string };

const REFERENCE = /^ {0,3}\[([^\]]+)\]:\s*(\S+)/;

export function parseMarkdown(md: string): { blocks: MarkdownBlock[]; refs: Map<string, string> } {
  const blocks: MarkdownBlock[] = [];
  const refs = new Map<string, string>();
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let fence = false;

  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
    if (list) blocks.push({ type: 'list', ...list });
    paragraph = [];
    list = null;
  };

  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      fence = !fence;
      continue;
    }
    if (fence) {
      if (line.trim()) blocks.push({ type: 'paragraph', text: `\`${line.trim().replace(/`/g, "'")}\`` });
      continue;
    }
    const ref = REFERENCE.exec(line);
    if (ref) {
      refs.set(ref[1]!.toLowerCase(), ref[2]!);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: 'heading', level: heading[1]!.length, text: heading[2]! });
      continue;
    }
    const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      const ordered = /\d/.test(item[1]!);
      if (paragraph.length || (list && list.ordered !== ordered && !/^\s{2,}/.test(line))) flush();
      list ??= { ordered, items: [] };
      list.items.push(item[2]!);
      continue;
    }
    // A wrapped line carries on the list item or paragraph above it.
    if (list && /^\s+/.test(raw)) list.items[list.items.length - 1] += ` ${line.trim()}`;
    else {
      if (list) flush();
      paragraph.push(line.trim());
    }
  }
  flush();
  return { blocks, refs };
}

const INLINE = /\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|\[([^\]]+)\]/g;

function safeUrl(url: string): string | null {
  return /^(https?:|mailto:|#|\/)/i.test(url) ? url : null;
}

function link(url: string, children: ReactNode, key: number): ReactNode {
  const safe = safeUrl(url);
  if (!safe) return <span key={key}>{children}</span>;
  const external = /^https?:/i.test(safe);
  return (
    <a key={key} href={safe} {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}>
      {children}
    </a>
  );
}

export function inline(text: string, refs: Map<string, string> = new Map()): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) out.push(<strong key={key++}>{inline(m[1], refs)}</strong>);
    else if (m[2] !== undefined) out.push(link(m[3]!, inline(m[2], refs), key++));
    else if (m[4] !== undefined) out.push(<code key={key++}>{m[4]}</code>);
    else if (m[5] !== undefined) out.push(link(m[5], m[5], key++));
    else {
      // [text] on its own: a reference-style link if it's defined, otherwise just the text in brackets.
      const url = refs.get(m[6]!.toLowerCase());
      out.push(url ? link(url, m[6], key++) : m[0]);
    }
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, minLevel = 3, className }: { text: string; minLevel?: number; className?: string }) {
  const { blocks, refs } = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className={`markdown${className ? ` ${className}` : ''}`}>
      {blocks.map((b, i) => {
        if (b.type === 'heading') {
          const Tag = `h${Math.min(6, Math.max(minLevel, b.level))}` as 'h3';
          return <Tag key={i}>{inline(b.text, refs)}</Tag>;
        }
        if (b.type === 'list') {
          const Tag = b.ordered ? 'ol' : 'ul';
          return (
            <Tag key={i}>
              {b.items.map((item, j) => (
                <li key={j}>{inline(item, refs)}</li>
              ))}
            </Tag>
          );
        }
        return <p key={i}>{inline(b.text, refs)}</p>;
      })}
    </div>
  );
}

export interface ChangelogSection {
  /** "0.3.0", or "Unreleased". */
  version: string;
  date: string | null;
  body: string;
}

/** Splits a Keep a Changelog file into its "## [version] - date" sections. Link definitions are kept with each section. */
export function changelogSections(md: string): ChangelogSection[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const refs = lines.filter((l) => REFERENCE.test(l));
  const sections: { version: string; date: string | null; lines: string[] }[] = [];
  for (const line of lines) {
    const head = /^##\s+\[?([^\]\s]+)\]?(?:\s+[-–]\s+(\S+))?/.exec(line);
    if (head) {
      sections.push({ version: head[1]!.replace(/^v/, ''), date: head[2] ?? null, lines: [] });
      continue;
    }
    if (!REFERENCE.test(line)) sections.at(-1)?.lines.push(line);
  }
  return sections.map((s) => ({ version: s.version, date: s.date, body: [...s.lines, '', ...refs].join('\n').trim() }));
}
