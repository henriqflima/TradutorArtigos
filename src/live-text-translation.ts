import { translatePlainText, type PlainTextState, type TextProgress } from './plain-text-translation';
import { splitPlainText } from './plain-text';

export const LIVE_TEXT_INTERVAL_MS = 2_100;
export type LiveTextInput = { text: string; source: string; target: string; code: string };
export type LiveTextSnapshot = {
  status: 'idle' | 'waiting' | 'translating' | 'complete' | 'paused' | 'error';
  text: string;
  progress: TextProgress | null;
  error: string;
};
export const EMPTY_LIVE_TRANSLATION: LiveTextSnapshot = { status: 'idle', text: '', progress: null, error: '' };

function sameOptions(a: LiveTextInput, b: LiveTextInput) {
  return a.source === b.source && a.target === b.target && a.code === b.code;
}
function sameInput(a: LiveTextInput | null, b: LiveTextInput | null) {
  return a === b || Boolean(a && b && sameOptions(a, b) && a.text === b.text);
}

/** Start on the first edit and coalesce newer text without starving active work. */
export class LiveTextTranslation {
  private latest: LiveTextInput | null = null;
  private completed: LiveTextInput | null = null;
  private displayedSourceLength = 0;
  private cache: PlainTextState = { completed: [] };
  private active: { input: LiveTextInput; controller: AbortController } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastStarted = -Infinity;
  private enabled = true;
  private paused = false;
  private disposed = false;
  private snapshot: LiveTextSnapshot = { ...EMPTY_LIVE_TRANSLATION };

  constructor(private onUpdate: (snapshot: LiveTextSnapshot) => void, private run = translatePlainText) {}

  update(input: LiveTextInput | null, enabled = true) {
    if (this.disposed) return;
    const changed = !sameInput(input, this.latest);
    const wasEnabled = this.enabled;
    const previous = this.latest;
    this.enabled = enabled;
    this.latest = input ? { ...input } : null;
    if (!input) {
      this.cancel(); this.cache = { completed: [] }; this.completed = null; this.paused = false; this.displayedSourceLength = 0;
      this.publish({ ...EMPTY_LIVE_TRANSLATION }); return;
    }
    if (changed) {
      this.paused = false;
      const appended = previous && sameOptions(input, previous) && input.text.startsWith(previous.text);
      if (!appended) {
        this.cancel(); this.completed = null; this.displayedSourceLength = 0;
        this.publish({ ...EMPTY_LIVE_TRANSLATION });
      } else this.publish({ error: '' });
    }
    if (!enabled) {
      this.cancel(); this.publish({ status: 'idle' }); return;
    }
    if (!changed && wasEnabled && (this.paused || this.snapshot.status === 'error')) return;
    this.pump();
  }

  pause() {
    if (this.disposed) return;
    this.paused = true; this.cancel(); this.publish({ status: 'paused' });
  }

  resume() {
    if (this.disposed) return;
    this.paused = false; this.publish({ error: '' }); this.pump();
  }

  dispose() { this.cancel(); this.disposed = true; }

  private cancel() {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    const active = this.active;
    this.active = null;
    active?.controller.abort();
  }

  private publish(change: Partial<LiveTextSnapshot>) {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...change };
    this.onUpdate(this.snapshot);
  }

  private pump() {
    if (this.disposed || !this.enabled || this.paused || !this.latest) return;
    if (this.active) { this.publish({ status: 'translating' }); return; }
    if (sameInput(this.latest, this.completed)) { this.publish({ status: 'complete' }); return; }
    const wait = Math.max(0, this.lastStarted + LIVE_TEXT_INTERVAL_MS - Date.now());
    if (wait > 0) {
      this.publish({ status: 'waiting' });
      // Appends replace latest, but never postpone this fixed update window.
      if (this.timer === null) this.timer = setTimeout(() => { this.timer = null; this.pump(); }, wait);
      return;
    }
    void this.start();
  }

  private async start() {
    const input = this.latest!;
    const chunks = splitPlainText(input.text);
    const active = { input, controller: new AbortController() };
    const state: PlainTextState = { ...this.cache, completed: [...this.cache.completed] };
    this.active = active; this.lastStarted = Date.now();
    const isCurrent = () => this.active === active && !active.controller.signal.aborted && !this.disposed;
    const keepCache = () => { this.cache = { ...state, completed: [...state.completed] }; };
    this.publish({ status: 'translating', error: '' });
    let failed = false;
    try {
      const text = await this.run(input.text, { source: input.source, target: input.target, code: input.code }, state, progress => {
        if (!isCurrent()) return;
        keepCache();
        // Keep the last visible result while the changed tail catches up,
        // even when the reusable prefix contains fewer translated paragraphs.
        const covered = chunks.slice(0, progress.completed).reduce((sum, chunk) => sum + chunk.before.length + chunk.text.length + chunk.after.length, 0);
        const show = Boolean(progress.text) && covered >= this.displayedSourceLength;
        if (show) this.displayedSourceLength = covered;
        this.publish({ progress, ...(show ? { text: progress.text } : {}) });
      }, active.controller.signal);
      if (!isCurrent()) return;
      keepCache(); this.completed = input; this.displayedSourceLength = input.text.length;
      this.publish({ text, status: sameInput(input, this.latest) ? 'complete' : 'waiting' });
    } catch (error) {
      if (!isCurrent()) return;
      keepCache();
      if (sameInput(input, this.latest)) {
        failed = true;
        this.publish({ status: 'error', error: error instanceof Error ? error.message : 'Não foi possível traduzir o texto.' });
      }
    } finally {
      // A cancelled response must never release a newer run or restart it.
      if (this.active === active) {
        this.active = null;
        if (!failed) this.pump();
      }
    }
  }
}
