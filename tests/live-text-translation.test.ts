import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LIVE_TEXT_INTERVAL_MS, LiveTextTranslation,
  type LiveTextInput, type LiveTextSnapshot,
} from '../src/live-text-translation';
import { type PlainTextState, type TextProgress, translatePlainText } from '../src/plain-text-translation';

type PendingRun = {
  text: string;
  options: Parameters<typeof translatePlainText>[1];
  cache: PlainTextState;
  progress: (value: TextProgress) => void;
  signal: AbortSignal;
  resolve: (value: string) => void;
  reject: (reason: unknown) => void;
};

const input = (text: string, changes: Partial<LiveTextInput> = {}): LiveTextInput => ({
  text, source: 'EN', target: 'PT-BR', code: 'private', ...changes,
});
const partial = (text: string): TextProgress => ({ text, completed: 1, total: 2 });
const controllers: LiveTextTranslation[] = [];

function harness() {
  const updates: LiveTextSnapshot[] = [];
  const requests: PendingRun[] = [];
  const run = vi.fn((...args: Parameters<typeof translatePlainText>) => new Promise<string>((resolve, reject) => {
    const [text, options, cache, progress, signal] = args;
    requests.push({ text, options, cache, progress, signal, resolve, reject });
  }));
  const controller = new LiveTextTranslation(snapshot => {
    updates.push({ ...snapshot, progress: snapshot.progress ? { ...snapshot.progress } : null });
  }, run);
  controllers.push(controller);
  return { controller, requests, run, updates, latest: () => updates.at(-1)! };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-17T00:00:00Z'));
});
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.useRealTimers();
});

describe('continuous live text translation', () => {
  it('starts with the first input immediately and completes without a debounce', async () => {
    const h = harness();
    h.controller.update(input('Hello'));
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.latest().status).toBe('translating');
    expect(h.requests[0].options).toEqual({ source: 'EN', target: 'PT-BR', code: 'private' });
    h.requests[0].resolve('Olá');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.latest()).toMatchObject({ status: 'complete', text: 'Olá', error: '' });
    h.controller.update(input('Hello'));
    await vi.advanceTimersByTimeAsync(LIVE_TEXT_INTERVAL_MS * 3);
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it('continues translating during sustained typing and coalesces pending appends', async () => {
    const h = harness();
    h.controller.update(input('Hello'));
    h.requests[0].progress(partial('Olá'));
    for (const text of ['Hello w', 'Hello wo', 'Hello world']) {
      await vi.advanceTimersByTimeAsync(100);
      h.controller.update(input(text));
    }
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.requests[0].signal.aborted).toBe(false);
    expect(h.latest().text).toBe('Olá');
    h.requests[0].resolve('Olá');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.latest().status).not.toBe('complete');
    await vi.advanceTimersByTimeAsync(LIVE_TEXT_INTERVAL_MS - 301);
    expect(h.run).toHaveBeenCalledTimes(1);
    h.controller.update(input('Hello world!'));
    await vi.advanceTimersByTimeAsync(1);
    expect(h.run).toHaveBeenCalledTimes(2);
    expect(h.requests[1].text).toBe('Hello world!');
    h.requests[1].resolve('Olá, mundo!');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.latest()).toMatchObject({ status: 'complete', text: 'Olá, mundo!' });
  });

  it('waits for active work even after the cadence interval has elapsed', async () => {
    const h = harness();
    h.controller.update(input('Hello'));
    h.controller.update(input('Hello world'));
    await vi.advanceTimersByTimeAsync(LIVE_TEXT_INTERVAL_MS * 2);
    expect(h.run).toHaveBeenCalledTimes(1);
    h.requests[0].resolve('Olá');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.run).toHaveBeenCalledTimes(2);
    expect(h.requests[1].text).toBe('Hello world');
  });

  it('keeps visible output when a later append initially has no reusable translated chunks', async () => {
    const h = harness();
    h.controller.update(input('Hello'));
    h.requests[0].resolve('Olá');
    await vi.advanceTimersByTimeAsync(0);
    h.controller.update(input('Hello world'));
    expect(h.latest().text).toBe('Olá');
    await vi.advanceTimersByTimeAsync(LIVE_TEXT_INTERVAL_MS);
    h.requests[1].progress({ text: '', completed: 0, total: 1 });
    expect(h.latest().text).toBe('Olá');
    h.requests[1].progress({ text: 'Olá, mundo', completed: 1, total: 1 });
    expect(h.latest().text).toBe('Olá, mundo');
  });

  it('keeps the full visible result while a shorter cached paragraph prefix catches up', async () => {
    const h = harness(), original = 'word '.repeat(1000);
    h.controller.update(input(original));
    h.requests[0].resolve('Full translated document');
    await vi.advanceTimersByTimeAsync(0);
    h.controller.update(input(original + 'More text.'));
    await vi.advanceTimersByTimeAsync(LIVE_TEXT_INTERVAL_MS);
    h.requests[1].progress({ text: 'Only the first paragraph', completed: 1, total: 3 });
    expect(h.latest().text).toBe('Full translated document');
    h.requests[1].resolve('Full translated document with more text.');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.latest()).toMatchObject({ status: 'complete', text: 'Full translated document with more text.' });
  });

  it.each([
    ['destructive edit', input('Goodbye')],
    ['source change', input('Hello', { source: 'FR' })],
    ['target change', input('Hello', { target: 'ES' })],
    ['access code change', input('Hello', { code: 'new-code' })],
  ])('cancels and clears on %s while rejecting stale progress and results', async (_label, next) => {
    const h = harness();
    h.controller.update(input('Hello'));
    h.requests[0].progress(partial('Olá'));
    await vi.advanceTimersByTimeAsync(100);
    h.controller.update(next);
    expect(h.requests[0].signal.aborted).toBe(true);
    expect(h.latest().text).toBe('');
    h.requests[0].progress(partial('Resposta obsoleta'));
    expect(h.latest().text).toBe('');
    await vi.advanceTimersByTimeAsync(LIVE_TEXT_INTERVAL_MS - 100);
    expect(h.run).toHaveBeenCalledTimes(2);
    h.requests[1].progress(partial('Resposta atual'));
    h.requests[0].resolve('Resposta obsoleta');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.latest()).toMatchObject({ status: 'translating', text: 'Resposta atual' });
    h.requests[1].resolve('Resposta final');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.latest()).toMatchObject({ status: 'complete', text: 'Resposta final' });
  });

  it('does not restart an existing cadence timer as queued text changes', async () => {
    const h = harness();
    h.controller.update(input('First'));
    await vi.advanceTimersByTimeAsync(400);
    h.controller.update(input('Replacement'));
    await vi.advanceTimersByTimeAsync(500);
    h.controller.update(input('Replacement text'));
    await vi.advanceTimersByTimeAsync(500);
    h.controller.update(input('Replacement text latest'));
    await vi.advanceTimersByTimeAsync(LIVE_TEXT_INTERVAL_MS - 1_400);
    expect(h.run).toHaveBeenCalledTimes(2);
    expect(h.requests[1].text).toBe('Replacement text latest');
  });

  it('null input cancels work, clears output, and discards queued translation', async () => {
    const h = harness();
    h.controller.update(input('Hello'));
    h.requests[0].progress(partial('Olá'));
    h.controller.update(input('Hello world'));
    h.controller.update(null);
    expect(h.requests[0].signal.aborted).toBe(true);
    expect(h.latest()).toMatchObject({ status: 'idle', text: '', progress: null, error: '' });
    h.requests[0].progress(partial('Obsoleto'));
    h.requests[0].resolve('Obsoleto');
    await vi.advanceTimersByTimeAsync(LIVE_TEXT_INTERVAL_MS * 2);
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.latest().text).toBe('');
  });

  it('disabling cancels while preserving output and re-enabling resumes the current input', async () => {
    const h = harness(), value = input('Hello');
    h.controller.update(value);
    h.requests[0].progress(partial('Olá'));
    h.controller.update(value, false);
    expect(h.requests[0].signal.aborted).toBe(true);
    expect(h.latest().text).toBe('Olá');
    await vi.advanceTimersByTimeAsync(LIVE_TEXT_INTERVAL_MS * 2);
    expect(h.run).toHaveBeenCalledTimes(1);
    h.controller.update(value, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.run).toHaveBeenCalledTimes(2);
    expect(h.requests[1].text).toBe('Hello');
  });

  it('does not repeat a current complete translation when disabled and re-enabled', async () => {
    const h = harness(), value = input('Hello');
    h.controller.update(value);
    h.requests[0].resolve('Olá');
    await vi.advanceTimersByTimeAsync(0);
    h.controller.update(value, false);
    h.controller.update(value, true);
    await vi.advanceTimersByTimeAsync(LIVE_TEXT_INTERVAL_MS * 2);
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.latest().text).toBe('Olá');
  });

  it('pause retains partial progress and resumes explicitly without losing completed chunks', async () => {
    const h = harness();
    h.controller.update(input('Hello world'));
    h.requests[0].cache.completed.push('Olá ');
    h.requests[0].progress(partial('Olá '));
    h.controller.pause();
    expect(h.requests[0].signal.aborted).toBe(true);
    expect(h.latest()).toMatchObject({ status: 'paused', text: 'Olá ' });
    h.controller.update(input('Hello world'));
    await vi.advanceTimersByTimeAsync(LIVE_TEXT_INTERVAL_MS * 2);
    expect(h.run).toHaveBeenCalledTimes(1);
    h.controller.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.run).toHaveBeenCalledTimes(2);
    expect(h.requests[1].cache.completed).toEqual(['Olá ']);
  });

  it('changed input resumes paused translation using the newest text', async () => {
    const h = harness();
    h.controller.update(input('Hello'));
    h.controller.pause();
    h.controller.update(input('Hello again'));
    await vi.advanceTimersByTimeAsync(LIVE_TEXT_INTERVAL_MS);
    expect(h.run).toHaveBeenCalledTimes(2);
    expect(h.requests[1].text).toBe('Hello again');
  });

  it('reports an error without looping unchanged failed work, then allows an explicit retry', async () => {
    const h = harness(), value = input('Hello');
    h.controller.update(value);
    h.requests[0].reject(new Error('Service unavailable'));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.latest()).toMatchObject({ status: 'error', error: 'Service unavailable' });
    h.controller.update(value);
    await vi.advanceTimersByTimeAsync(LIVE_TEXT_INTERVAL_MS * 3);
    expect(h.run).toHaveBeenCalledTimes(1);
    h.controller.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it('proceeds with changed queued input when the older translation fails', async () => {
    const h = harness();
    h.controller.update(input('Hello'));
    h.controller.update(input('Hello world'));
    h.requests[0].reject(new Error('Temporary failure'));
    await vi.advanceTimersByTimeAsync(LIVE_TEXT_INTERVAL_MS);
    expect(h.run).toHaveBeenCalledTimes(2);
    expect(h.requests[1].text).toBe('Hello world');
    h.requests[1].resolve('Olá, mundo');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.latest()).toMatchObject({ status: 'complete', text: 'Olá, mundo', error: '' });
    await vi.advanceTimersByTimeAsync(LIVE_TEXT_INTERVAL_MS * 2);
    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it('dispose aborts active work and prevents stale callbacks or queued timers updating observers', async () => {
    const h = harness();
    h.controller.update(input('Hello'));
    h.controller.update(input('Hello world'));
    h.controller.dispose();
    const count = h.updates.length;
    expect(h.requests[0].signal.aborted).toBe(true);
    h.requests[0].progress(partial('Obsoleto'));
    h.requests[0].resolve('Obsoleto');
    await vi.advanceTimersByTimeAsync(LIVE_TEXT_INTERVAL_MS * 2);
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.updates).toHaveLength(count);
  });
});
