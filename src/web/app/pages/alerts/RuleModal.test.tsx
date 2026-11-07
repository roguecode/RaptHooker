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

  it('sets up an alert on how fast the gravity is dropping', async () => {
    const { onSave } = await open();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'velocity_slow' } });
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Fermentation slows');
    const threshold = screen.getByLabelText(/^Slower than \(points\/day\)/) as HTMLInputElement;
    expect(threshold.value).toBe('3');
    fireEvent.change(threshold, { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save alert' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0]).toMatchObject({ kind: 'velocity_slow', name: 'Fermentation slows', threshold: 10 });
  });

  it('says what a velocity threshold means as it is typed, and what else decides when it goes off', async () => {
    await open();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'velocity_slow' } });
    const example = () => document.querySelector('.rule-example')?.textContent ?? '';
    expect(example()).toContain("Alerts when the gravity drops by less than 0.003 in a day (that's 1.050 to 1.047).");
    expect(example()).toContain('a velocity of −12 /day is 12 points: 0.012 a day.');

    const threshold = screen.getByLabelText(/^Slower than/);
    fireEvent.change(threshold, { target: { value: '0.5' } });
    expect(example()).toContain("Alerts when the gravity drops by less than 0.0005 in a day (that's 1.0500 to 1.0495).");
    expect(example()).toContain('It clears once the gravity drops by more than 0.00075 a day.');
    expect(example()).toContain('it waits until the gravity has dropped 0.002 from the OG');
    expect(example()).toContain("It notifies you at most once every 60 minutes (Don't repeat for).");
    expect(example()).not.toContain('°P');

    fireEvent.change(screen.getByLabelText(/^Don't repeat for/), { target: { value: '0' } });
    expect(example()).toContain('It notifies you every time it goes off');

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'velocity_fast' } });
    expect(example()).toContain("Alerts when the gravity drops by more than 0.010 in a day (that's 1.050 to 1.040).");
    expect(example()).toContain('It clears once the gravity drops by less than 0.009 a day.');
    expect(example()).not.toContain('from the OG');
  });

  it('wants a velocity threshold as the points it drops, not the velocity', async () => {
    const { onSave } = await open();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'velocity_slow' } });
    const threshold = screen.getByLabelText(/^Slower than/);
    fireEvent.change(threshold, { target: { value: '-12' } });
    expect(document.querySelector('.rule-example')).toBeNull();
    fireEvent.submit(threshold.closest('form')!);
    await waitFor(() => expect(screen.getByText('More than 0: the points it drops a day (12 for a velocity of −12)')).toBeTruthy());
    expect(onSave).not.toHaveBeenCalled();
  });

  it('gives the example in °P too, and explains fermentation stable', async () => {
    await open(emptyRule(), { hub: { units: { gravity: 'plato', temperature: 'C' } } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'velocity_slow' } });
    const example = () => document.querySelector('.rule-example')?.textContent ?? '';
    expect(example()).toMatch(/In °P, that's about 0\.\d+\./);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'gravity_stable' } });
    expect(example()).toContain("Alerts when the gravity moves by less than 0.001 over 48 hours (that's 1.012 to 1.011).");
    expect(example()).toContain('It clears once the gravity moves by more than 0.002 over the window.');
    expect(example()).toContain('It needs readings covering the whole window');
    expect(example()).toContain('A point is 0.001.');
    fireEvent.change(screen.getByLabelText(/^Over \(hours\)/), { target: { value: '' } });
    expect(document.querySelector('.rule-example')).toBeNull();
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
