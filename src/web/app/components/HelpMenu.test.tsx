// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DISCORD_URL, GITHUB_URL, HelpMenu } from './HelpMenu';

afterEach(cleanup);

describe('HelpMenu', () => {
  it('opens a little window with Discord and GitHub, each opening in a new tab', () => {
    render(<HelpMenu />);
    const button = screen.getByRole('button', { name: 'Help' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('group', { name: 'Help' })).toBeNull();

    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const pop = screen.getByRole('group', { name: 'Help' });
    const discord = screen.getByRole('link', { name: /Discord/ });
    const github = screen.getByRole('link', { name: /GitHub/ });
    expect(discord.getAttribute('href')).toBe(DISCORD_URL);
    expect(github.getAttribute('href')).toBe(GITHUB_URL);
    for (const link of [discord, github]) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toContain('noopener');
      expect(link.querySelector('svg.help-logo')).not.toBeNull();
    }
    expect(pop.contains(document.activeElement)).toBe(true);
  });

  it('closes on Escape and gives the focus back to the button', () => {
    render(<HelpMenu />);
    const button = screen.getByRole('button', { name: 'Help' });
    fireEvent.click(button);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Help' })).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('closes on a click outside it', () => {
    render(<HelpMenu />);
    fireEvent.click(screen.getByRole('button', { name: 'Help' }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('group', { name: 'Help' })).toBeNull();
  });
});
