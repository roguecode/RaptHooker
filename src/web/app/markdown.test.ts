import { describe, expect, it } from 'vitest';
import changelog from '../../../CHANGELOG.md?raw';
import { version } from '../../../package.json';
import { changelogSections, parseMarkdown } from './markdown';

describe('parseMarkdown', () => {
  it('reads headings, lists, paragraphs and link definitions', () => {
    const { blocks, refs } = parseMarkdown(
      [
        '## [0.2.0] - 2026-10-24',
        '',
        '### Added',
        '',
        '- **Bold** thing with a [link](https://example.com)',
        '  that wraps onto a second line.',
        '* Another',
        '',
        '1. First',
        '2. Second',
        '',
        'A paragraph',
        'over two lines.',
        '',
        '[0.2.0]: https://example.com/releases/v0.2.0',
      ].join('\r\n'),
    );
    expect(blocks).toEqual([
      { type: 'heading', level: 2, text: '[0.2.0] - 2026-10-24' },
      { type: 'heading', level: 3, text: 'Added' },
      {
        type: 'list',
        ordered: false,
        items: ['**Bold** thing with a [link](https://example.com) that wraps onto a second line.', 'Another'],
      },
      { type: 'list', ordered: true, items: ['First', 'Second'] },
      { type: 'paragraph', text: 'A paragraph over two lines.' },
    ]);
    expect(refs.get('0.2.0')).toBe('https://example.com/releases/v0.2.0');
  });
});

describe('changelogSections', () => {
  it('splits the real changelog by version', () => {
    const sections = changelogSections(changelog);
    expect(sections[0]?.version).toBe('Unreleased');
    const current = sections.find((s) => s.version === version);
    expect(current, `CHANGELOG.md needs a section for ${version}`).toBeDefined();
    expect(current?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(current?.body).toContain('### Added');
  });
});
