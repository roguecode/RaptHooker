import { describe, expect, it } from 'vitest';
import { SCREEN_ITEMS } from '@rapthooker/shared';
import {
  clampSize,
  CONTENT_PRESETS,
  contentPreset,
  CUSTOM,
  DEFAULT_IMAGE_LINK,
  parseImageLinkSettings,
  serializeImageLinkSettings,
  SIZE_PRESETS,
  sizePreset,
} from './imageLinkOptions';

describe('image link choices', () => {
  it('starts on a GeekMagic screen in JPEG with the brew and its graph', () => {
    expect(parseImageLinkSettings(null)).toEqual(DEFAULT_IMAGE_LINK);
    expect(DEFAULT_IMAGE_LINK).toMatchObject({ size: 'geekmagic', width: 240, height: 240, format: 'jpg' });
    expect(contentPreset(DEFAULT_IMAGE_LINK.show)?.id).toBe('graph');
    expect(SIZE_PRESETS.find((p) => p.id === 'geekmagic')).toMatchObject({ width: 240, height: 240, format: 'jpg' });
  });

  it('remembers choices and puts up with anything odd in storage', () => {
    const saved = {
      ...DEFAULT_IMAGE_LINK,
      size: 'fhd',
      width: 1920,
      height: 1080,
      format: 'png' as const,
      brewing: true,
      host: 'http://10.0.0.5:8080',
    };
    expect(parseImageLinkSettings(serializeImageLinkSettings(saved))).toEqual(saved);
    expect(parseImageLinkSettings('not json')).toEqual(DEFAULT_IMAGE_LINK);
    const odd = parseImageLinkSettings(
      JSON.stringify({
        size: 'fhd',
        width: 5,
        height: 'tall',
        format: 'gif',
        show: ['gravity', 'sparkles'],
        range: 'year',
        host: 'javascript:alert(1)',
      }),
    );
    expect(odd).toMatchObject({ size: CUSTOM, width: 64, height: 240, format: 'jpg', show: ['gravity'], range: 'brew', host: null });
  });

  it('knows the size preset for a size, keeping the one picked when two share it', () => {
    expect(sizePreset(800, 480)?.id).toBe('lcd-800');
    expect(sizePreset(800, 480, 'epaper-800')?.id).toBe('epaper-800');
    expect(sizePreset(801, 480)).toBeNull();
    expect(parseImageLinkSettings(JSON.stringify({ size: 'epaper-800', width: 800, height: 480 })).size).toBe('epaper-800');
    expect(parseImageLinkSettings(JSON.stringify({ size: 'geekmagic', width: 800, height: 480 })).size).toBe('lcd-800');
    expect(clampSize(10)).toBe(64);
    expect(clampSize(5000)).toBe(2048);
    expect(clampSize(Number.NaN)).toBe(64);
  });

  it('recognises a content preset whatever the order, and a mix of its own', () => {
    expect(contentPreset(['temperature', 'gravity'])?.id).toBe('big');
    expect(contentPreset([...SCREEN_ITEMS].reverse())?.id).toBe('everything');
    expect(contentPreset(['gravity', 'chart'])).toBeNull();
    expect(new Set(CONTENT_PRESETS.map((p) => p.items.slice().sort().join())).size).toBe(CONTENT_PRESETS.length);
  });
});
