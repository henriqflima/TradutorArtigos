import { SOURCE_LANGUAGES, TARGET_LANGUAGES } from './shared';
import { splitPlainText, validatePlainText } from './plain-text';
import { requestTranslations } from './translation-transport';

export type PlainTextState = { text?: string; source?: string; target?: string; completed: string[] };
type Options = { source: string; target: string; code: string };
export type TextProgress = { text: string; completed: number; total: number };

export async function translatePlainText(
  text: string, options: Options, state: PlainTextState,
  onProgress: (progress: TextProgress) => void, signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const invalid = validatePlainText(text);
  if (invalid) throw new Error(invalid);
  if (!TARGET_LANGUAGES.some(([code]) => code === options.target) ||
      (options.source && !SOURCE_LANGUAGES.some(([code]) => code === options.source)) ||
      (options.source && options.target.split('-')[0] === options.source)) {
    throw new Error('Selecione idiomas válidos e diferentes para a tradução.');
  }
  const chunks = splitPlainText(text);
  if (state.source !== options.source || state.target !== options.target) state.completed = [];
  else if (state.text !== text) {
    // Live edits usually change only the final chunk. Reuse the unchanged prefix.
    const previous = splitPlainText(state.text || '');
    let reusable = 0;
    while (reusable < state.completed.length && reusable < chunks.length) {
      const before = previous[reusable], after = chunks[reusable];
      if (!before || before.text !== after.text || before.before !== after.before || before.after !== after.after) break;
      reusable++;
    }
    state.completed = state.completed.slice(0, reusable);
  }
  Object.assign(state, { text, source: options.source, target: options.target });
  const progress = () => ({ text: state.completed.join(''), completed: state.completed.length, total: chunks.length });
  onProgress(progress());
  for (let index = state.completed.length; index < chunks.length; index++) {
    signal.throwIfAborted();
    const chunk = chunks[index];
    let translated = '';
    if (chunk.text) {
      const result = await requestTranslations({
        text: chunk.text, target_lang: options.target,
        ...(options.source ? { source_lang: options.source } : {}),
      }, options.code, signal, '/api/translate-plain-text');
      if (result.length !== 1 || !result[0].trim()) throw new Error('O serviço devolveu uma tradução incompleta. Tente retomar a tradução.');
      translated = result[0].trim();
    }
    signal.throwIfAborted();
    state.completed.push(chunk.before + translated + chunk.after);
    onProgress(progress());
  }
  return state.completed.join('');
}
