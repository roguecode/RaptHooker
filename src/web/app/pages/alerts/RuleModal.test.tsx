// @vitest-environment happy-dom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BROWSER_PUSH, type AlertRuleInput, type Channel } from '@rapthooker/shared';
import { makePill, renderWithHub, toastTexts } from '../../test/render';
import { emptyRule, RuleModal, sendToText } from './RuleModal';

const channel = (over: Partial<Channel>): Channel => ({
  id: 'ch-phone',
  name: 'Phone',
  kind: 'ntfy',
  enabled: true,
  config: {},
  createdAt: 0,
  masked: false,
  lastAt: null,
  lastOk: null,
  lastError: null,
  ...over,
});
const channels = [channel({}), channel({ id: 'ch-mail', name: 'Inbox', kind: 'email', enabled: false })];

const chip = (name: string | RegExp) => screen.getByRole('button', { name });
const pressed = (name: string | RegExp) => chip(name).getAttribute('aria-pressed') === 'true';

async function open(initial: AlertRuleInput = emptyRule(), hub = {}) {
  const onSave = vi.fn(async (_rule: AlertRuleInput) => undefined);
  const onClose = vi.fn();
  await renderWithHub(<RuleModal isNew initial={initial} channels={channels} onClose={onClose} onSave={onSave} />, {
    pills: [makePill({ id: 'pill-1', name: 'Hazy IPA' })],
    afterLoad: true,
    ...hub,
  });
  return { onSave, onClose };
}

describe('alert rule editor', () => {
  it('sends everywhere unless told otherwise', async () => {
    await open();
    expect(screen.getByRole('dialog', { name: 'New alert' })).toBeTruthy();
    expect(pressed('Everywhere')).toBe(true);
    expect(pressed('Phone')).toBe(false);
    expect(screen.getByText(/Browser notifications and every service under "Where alerts go" that is switched on/)).toBeTruthy();
    expect(chip('Inbox (off)')).toBeTruthy();
  });

  it('picks where alerts go', async () => {
    const { onSave, onClose } = await open();
    fireEvent.click(chip('Phone'));
    expect(pressed('Phone')).toBe(true);
    expect(pressed('Everywhere')).toBe(false);
    expect(screen.getByText('Alerts always show in this app too.')).toBeTruthy();

    fireEvent.click(chip('Browser notifications'));
    fireEvent.click(chip('Phone'));
    expect(pressed('Browser notifications')).toBe(true);
    expect(pressed('Phone')).toBe(false);

    fireEvent.click(chip('Browser notifications'));
    expect(screen.getByText('Only shown in this app.')).toBeTruthy();

    fireEvent.click(chip('Everywhere'));
    expect(pressed('Everywhere')).toBe(true);
    fireEvent.click(chip('Phone'));
    fireEvent.click(screen.getByRole('button', { name: 'Save alert' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0]).toMatchObject({ name: 'Too warm', kind: 'temp_above', threshold: 24, channelIds: ['ch-phone'] });
  });

  it('works in the units on screen', async () => {
    const { onSave } = await open(emptyRule(), { hub: { units: { gravity: 'sg', temperature: 'F' } } });
    const threshold = screen.getByLabelText(/^Threshold \(°F\)/) as HTMLInputElement;
    expect(threshold.value).toBe('75.2');
    fireEvent.change(threshold, { target: { value: '77' } });
    fireEvent.click(chip('Hazy IPA'));
    fireEvent.click(screen.getByRole('button', { name: 'Save alert' }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const saved = onSave.mock.calls[0]![0];
    expect(saved.threshold).toBeCloseTo(25, 5);
    expect(saved.pillIds).toEqual(['pill-1']);
  });

  it('keeps a threshold that was not changed as it was', async () => {
    const { onSave } = await open({ ...emptyRule(), threshold: 24.25 });
    expect((screen.getByLabelText(/^Threshold \(°C\)/) as HTMLInputElement).value).toBe('24.3');
    fireEvent.click(screen.getByRole('button', { name: 'Save alert' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0].threshold).toBe(24.25);
  });

  it('names the rule after the kind and needs a name', async () => {
    const { onSave } = await open();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'battery_below' } });
    const name = screen.getByLabelText(/^Name/) as HTMLInputElement;
    expect(name.value).not.toBe('Too warm');
    expect(screen.getByLabelText(/^Threshold \(%\)/)).toBeTruthy();

    fireEvent.change(name, { target: { value: ' ' } });
    fireEvent.submit(name.closest('form')!);
    await waitFor(() => expect(toastTexts()).toContain("Couldn't save: Check Name."));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('lets a number be cleared and typed again', async () => {
    const { onSave } = await open({ ...emptyRule(), kind: 'gravity_stable', name: 'Fermentation done', threshold: 1 });
    const hours = screen.getByLabelText(/^Over \(hours\)/) as HTMLInputElement;
    expect(hours.value).toBe('48');
    fireEvent.change(hours, { target: { value: '' } });
    expect(hours.value).toBe('');
    fireEvent.submit(hours.closest('form')!);
    await waitFor(() => expect(toastTexts()).toContain("Couldn't save: Check Over (hours)."));
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.change(hours, { target: { value: '3' } });
    fireEvent.change(hours, { target: { value: '30' } });
    expect(hours.value).toBe('30');
    fireEvent.click(screen.getByRole('button', { name: 'Save alert' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0]).toMatchObject({ kind: 'gravity_stable', hours: 30, cooldownMin: 60 });
  });
});

describe('sendToText', () => {
  it('says where a rule sends to', () => {
    expect(sendToText('all', channels)).toBe('everywhere');
    expect(sendToText([BROWSER_PUSH, 'ch-mail'], channels)).toBe('browser notifications, Inbox');
    expect(sendToText([], channels)).toBe('only in this app');
    expect(sendToText(['deleted'], channels)).toBe('only in this app');
  });
});
