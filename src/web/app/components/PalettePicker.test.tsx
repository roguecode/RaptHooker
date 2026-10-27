// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PalettePicker } from './PalettePicker';
import { PALETTE_KEY, setPalette, startTheme } from '../theme';

startTheme();

afterEach(() => {
  cleanup();
  setPalette('violet');
});

describe('PalettePicker', () => {
  it('starts on violet and switches the page to the palette picked, remembering it', () => {
    render(<PalettePicker />);
    const group = screen.getByRole('group', { name: 'Colours' });
    expect(screen.getByRole('button', { name: 'Violet' }).getAttribute('aria-pressed')).toBe('true');
    expect(document.documentElement.dataset.palette).toBe('violet');
    expect(group.querySelectorAll('button')).toHaveLength(6);

    fireEvent.click(screen.getByRole('button', { name: 'Ocean' }));
    expect(document.documentElement.dataset.palette).toBe('ocean');
    expect(window.localStorage.getItem(PALETTE_KEY)).toBe('ocean');
    expect(screen.getByRole('button', { name: 'Ocean' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Violet' }).getAttribute('aria-pressed')).toBe('false');

    // Back to the default forgets the choice, like the theme does.
    fireEvent.click(screen.getByRole('button', { name: 'Violet' }));
    expect(window.localStorage.getItem(PALETTE_KEY)).toBeNull();
  });

  it('names each swatch when only the swatches are shown', () => {
    render(<PalettePicker compact />);
    fireEvent.click(screen.getByRole('button', { name: 'Amber' }));
    expect(document.documentElement.dataset.palette).toBe('amber');
    expect(screen.getByRole('button', { name: 'Amber' }).textContent).toBe('');
  });
});
