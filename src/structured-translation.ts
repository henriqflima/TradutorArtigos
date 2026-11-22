import { requestTranslations } from './translation-transport';
import { parseTranslationMarkup, type Marker } from './translation-markup';
import { splitInlineMath, splitMathRuns } from './inline-math';
import { MAX_PDF_PAGES, SOURCE_LANGUAGES, TARGET_LANGUAGES, TRANSLATION_ENGINE, TRANSLATION_PROMPT_VERSION } from './shared';
import {
  abortIfNeeded, sha256, translatableBlocks,
  type ContentRun, type DocumentAsset, type DocumentBlock,
  type DocumentIssue, type StructuredDocument, type TranslatedDocument,
} from './structured-document';

export type TranslationState = {
  sourceHash?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  engine?: string;
  completed: Record<string, { sourceSignature: string; runs: ContentRun[] }>;
};

type Options = { source: string; target: string; code: string };
type Serialized = { block: DocumentBlock; xml: string; markers: Map<string, Marker>; signature: string };
const encoder = new TextEncoder();
const MAX_BATCH_BYTES = 24_000;
const MAX_BATCH_BLOCKS = 4;
// Bound generated text as well as request bytes: eight dense paragraphs can
// exceed the deployed function's 30s response window even in a small request.
// Keep a single longer paragraph intact, subject to the existing hard limit.
const TARGET_BATCH_CHARACTERS = 3_000;
const MAX_CONTEXT_CHARS = 1_200;

function fail(message: string): never { throw new Error(message); }
function byteLength(value: string) { return encoder.encode(value).byteLength; }
function escapeXml(value: string) {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u.test(value)) {
    fail('O texto extraído contém caracteres de controle incompatíveis com XML.');
  }
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function cloneRuns(runs: ContentRun[]): ContentRun[] {
  return runs.map(run => run.type === 'text' ? { type: 'text', text: run.text, ...(run.style ? { style: { ...run.style } } : {}) } : { ...run });
}

function serialize(block: DocumentBlock, blockIndex: number, assets: Map<string, DocumentAsset>) {
  const markers = new Map<string, Marker>();
  let ordinal = 0;
  const body = splitMathRuns(block.runs).map(run => {
    if (run.type === 'asset') {
      const asset = assets.get(run.assetId);
      if (!asset) fail(`O bloco ${block.id} referencia um objeto inexistente.`);
      const id = `m${++ordinal}`;
      const tag = asset.kind.startsWith('equation') ? 'eq' : 'obj';
      const token = `LUME_${id.toUpperCase()}_PROTECTED`;
      markers.set(id, { id, tag, token, assetId: run.assetId });
      return `<${tag} id="${id}">${token}</${tag}>`;
    }
    let content: string;
    if (run.type === 'math') {
      const id = 'm' + ++ordinal, token = 'LUME_' + id.toUpperCase() + '_PROTECTED';
      markers.set(id, { id, tag: 'eq', token, mathText: run.text });
      content = '<eq id="' + id + '">' + token + '</eq>';
    } else content = escapeXml(run.text);
    if (run.style?.superscript) content = `<sup>${content}</sup>`;
    if (run.style?.italic) content = `<i>${content}</i>`;
    if (run.style?.bold) content = `<b>${content}</b>`;
    return content;
  }).join('');
  return { xml: `<p id="b${blockIndex}">${body}</p>`, markers };
}

function numericTokens(runs: ContentRun[]) {
  const plain = runs.map(run => run.type === 'text' ? run.text : ' ').join('');
  return (plain.match(/(?<![\p{L}\p{N}])[+\-−]?\d+(?:[.,]\d+)*(?:[eE][+\-−]?\d+)?\s*%?/gu) || [])
    .map(token => token.replace(/\s/g, '').replace(/−/g, '-').replace(/,/g, '.')).sort();
}
function numericIssue(block: DocumentBlock, runs: ContentRun[]): DocumentIssue | undefined {
  const before = numericTokens(block.runs), after = numericTokens(runs);
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  return {
    id: `translation-numeric-${block.id}`, page: block.page, blockId: block.id,
    severity: 'warning',
    message: 'Confira números, porcentagens e referências neste trecho: os valores extraídos antes e depois da tradução diferem.',
  };
}

function markerPositionIssue(block: DocumentBlock, runs: ContentRun[]): DocumentIssue | undefined {
  const sourceRuns = splitMathRuns(block.runs), translatedRuns = splitMathRuns(runs);
  const markerKey = (run: typeof sourceRuns[number]) => run.type === 'asset' ? `asset:${run.assetId}` :
    run.type === 'math' ? `math:${run.text}` : undefined;
  const touchesLettersOnBothSides = (items: typeof sourceRuns, index: number) => {
    let before = '', after = '';
    for (let cursor = index - 1; cursor >= 0; cursor--) {
      const run = items[cursor];
      if (run.type !== 'text') break;
      if (run.text) { before = Array.from(run.text).at(-1) || ''; break; }
    }
    for (let cursor = index + 1; cursor < items.length; cursor++) {
      const run = items[cursor];
      if (run.type !== 'text') break;
      if (run.text) { after = Array.from(run.text)[0] || ''; break; }
    }
    return /\p{L}/u.test(before) && /\p{L}/u.test(after);
  };
  const sourcePositions = new Map<string, number[]>();
  sourceRuns.forEach((run, index) => {
    const key = markerKey(run);
    if (key) sourcePositions.set(key, [...(sourcePositions.get(key) || []), index]);
  });
  const seen = new Map<string, number>();
  const embeddedInWord = translatedRuns.some((run, index) => {
    const key = markerKey(run);
    if (!key) return false;
    const occurrence = seen.get(key) || 0;
    seen.set(key, occurrence + 1);
    const sourceIndex = sourcePositions.get(key)?.[occurrence];
    return sourceIndex !== undefined && !touchesLettersOnBothSides(sourceRuns, sourceIndex) &&
      touchesLettersOnBothSides(translatedRuns, index);
  });

  const clusters: string[][] = [];
  let cluster: string[] = [];
  for (const run of sourceRuns) {
    const key = markerKey(run);
    if (key) cluster.push(key);
    else if (run.type === 'text' && run.text.trim()) {
      if (cluster.length > 1) clusters.push(cluster);
      cluster = [];
    }
  }
  if (cluster.length > 1) clusters.push(cluster);
  const hasCluster = (keys: string[]) => translatedRuns.some((run, index) => {
    if (markerKey(run) !== keys[0]) return false;
    let cursor = index;
    for (const key of keys.slice(1)) {
      cursor++;
      while (true) {
        const spacer = translatedRuns[cursor];
        if (spacer?.type !== 'text' || spacer.text.trim()) break;
        cursor++;
      }
      const next = translatedRuns[cursor];
      if (!next || markerKey(next) !== key) return false;
    }
    return true;
  });
  if (!embeddedInWord && clusters.every(hasCluster)) return;
  return {
    id: `translation-marker-${block.id}`, page: block.page, blockId: block.id, severity: 'warning',
    message: 'Confira a posição dos símbolos neste trecho: um marcador ficou dentro de uma palavra ou um grupo matemático foi separado.',
  };
}

function superscriptIssue(block: DocumentBlock, runs: ContentRun[]): DocumentIssue | undefined {
  const content = (items: ContentRun[]) => items.filter(run => run.type === 'text' && run.style?.superscript)
    .map(run => run.type === 'text' ? run.text : '').join('');
  if (content(block.runs) === content(runs)) return;
  return {
    id: `translation-superscript-${block.id}`, page: block.page, blockId: block.id, severity: 'warning',
    message: 'Confira os expoentes e sobrescritos neste trecho: seu conteúdo mudou durante a tradução.',
  };
}

function contextFor(document: StructuredDocument, first: DocumentBlock, last: DocumentBlock) {
  const positions = new Map(document.blocks.map((block, index) => [block.id, index]));
  const start = positions.get(first.id) ?? 0, end = positions.get(last.id) ?? start;
  const relevant: string[] = [];
  const heading = first.kind === 'heading' ? first : document.blocks.slice(0, start).reverse().find(block => block.kind === 'heading');
  if (heading) relevant.push(heading.runs.filter(run => run.type === 'text').map(run => run.type === 'text' ? run.text : '').join(''));
  for (const index of [start - 1, end + 1]) {
    const block = document.blocks[index];
    if (block && ['paragraph', 'heading', 'caption'].includes(block.kind)) {
      relevant.push(block.runs.filter(run => run.type === 'text').map(run => run.type === 'text' ? run.text : '').join(''));
    }
  }
  return splitInlineMath(relevant.join('\n')).map(segment => segment.type === 'math' ? '[protected mathematical expression]' : segment.text)
    .join('').slice(0, MAX_CONTEXT_CHARS);
}

/** Translates only prose blocks; original assets and their source hashes never leave the browser. */
export async function translateStructured(
  document: StructuredDocument, options: Options, state: TranslationState,
  onProgress: (message: string) => void, signal: AbortSignal,
): Promise<TranslatedDocument> {
  abortIfNeeded(signal);
  if (document.version !== 1 || document.sourceKind !== 'pdf' || !document.sourceHash) fail('O documento estruturado é inválido.');
  if (!document.pages.length || document.pages.length > MAX_PDF_PAGES) fail(`O PDF deve ter entre 1 e ${MAX_PDF_PAGES} páginas.`);
  if (document.issues.some(issue => issue.severity === 'blocking')) fail('Revise os problemas de extração antes de traduzir.');
  if (!TARGET_LANGUAGES.some(([code]) => code === options.target) ||
      (options.source && !SOURCE_LANGUAGES.some(([code]) => code === options.source)) ||
      (options.source && options.target.split('-')[0] === options.source)) fail('Selecione idiomas válidos e diferentes para a tradução.');
  const engine = `${TRANSLATION_ENGINE}:${TRANSLATION_PROMPT_VERSION}`;
  if (!state.completed || state.sourceHash !== document.sourceHash || state.sourceLanguage !== options.source ||
      state.targetLanguage !== options.target || state.engine !== engine) {
    state.completed = {};
  }
  state.sourceHash = document.sourceHash;
  state.sourceLanguage = options.source;
  state.targetLanguage = options.target;
  state.engine = engine;
  const ids = new Set<string>();
  for (const block of document.blocks) {
    if (!/^[A-Za-z][A-Za-z0-9_:-]{0,79}$/.test(block.id) || ids.has(block.id)) fail('Há IDs de bloco ausentes, inválidos ou duplicados.');
    ids.add(block.id);
  }
  const assetIds = new Set<string>();
  for (const asset of document.assets) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(asset.id) || assetIds.has(asset.id)) fail('Há IDs de objetos inválidos ou duplicados.');
    assetIds.add(asset.id);
  }
  const assets = new Map(document.assets.map(asset => [asset.id, asset]));
  // Pure mathematical content has nothing to translate; retain it exactly for local typesetting.
  const candidates = translatableBlocks(document).filter(block => splitMathRuns(block.runs).some(run => run.type === 'text' && run.text.trim()));
  const candidateIds = new Set(candidates.map(block => block.id));
  for (const id of Object.keys(state.completed)) if (!candidateIds.has(id)) delete state.completed[id];
  const serialized: Serialized[] = await Promise.all(candidates.map(async block => {
    const index = document.blocks.indexOf(block);
    const value = serialize(block, index, assets);
    const mathematicalContent = [...value.markers.values()].flatMap(marker => marker.mathText === undefined ? [] : [marker.mathText]);
    return { block, ...value, signature: await sha256(encoder.encode(JSON.stringify([value.xml, mathematicalContent]))) };
  }));
  const pending: Serialized[] = [];
  for (const item of serialized) {
    const cached = Object.prototype.hasOwnProperty.call(state.completed, item.block.id) ? state.completed[item.block.id] : undefined;
    const expectedAssets = item.block.runs.filter(run => run.type === 'asset').map(run => run.type === 'asset' ? run.assetId : '').sort();
    const cachedAssets = Array.isArray(cached?.runs) ? cached.runs.filter(run => run.type === 'asset').map(run => run.type === 'asset' ? run.assetId : '').sort() : [];
    if (!cached || cached.sourceSignature !== item.signature || !Array.isArray(cached.runs) ||
        !cached.runs.every(run => run && (run.type === 'text' ? typeof run.text === 'string' : run.type === 'asset' && typeof run.assetId === 'string')) ||
        JSON.stringify(cachedAssets) !== JSON.stringify(expectedAssets)) {
      delete state.completed[item.block.id]; pending.push(item);
    }
  }
  let completed = serialized.length - pending.length;
  onProgress(`${completed} de ${serialized.length} trechos traduzidos.`);
  for (let cursor = 0; cursor < pending.length;) {
    abortIfNeeded(signal);
    let batch: Serialized[] = [];
    let requestBody: Record<string, unknown> = {};
    while (cursor + batch.length < pending.length && batch.length < MAX_BATCH_BLOCKS) {
      const candidate = [...batch, pending[cursor + batch.length]];
      if (batch.length && candidate.reduce((sum, item) => sum + item.xml.length, 0) > TARGET_BATCH_CHARACTERS) break;
      const context = contextFor(document, candidate[0].block, candidate[candidate.length - 1].block);
      const body = {
        text: candidate.map(item => item.xml), target_lang: options.target,
        ...(options.source ? { source_lang: options.source } : {}),
        ...(context ? { context } : {}),
      };
      if (byteLength(JSON.stringify(body)) > MAX_BATCH_BYTES) break;
      batch = candidate; requestBody = body;
    }
    if (!batch.length) fail(`O trecho ${pending[cursor].block.id} é grande demais para tradução segura em um lote.`);
    const translated = await requestTranslations(requestBody, options.code, signal);
    if (translated.length !== batch.length) fail('A tradução devolveu quantidade inesperada de trechos.');
    const validated = batch.map((item, index) => ({
      item, runs: parseTranslationMarkup(translated[index], `b${document.blocks.indexOf(item.block)}`, item.markers),
    }));
    abortIfNeeded(signal);
    for (const { item, runs } of validated) {
      state.completed[item.block.id] = { sourceSignature: item.signature, runs };
    }
    cursor += batch.length;
    completed += batch.length;
    onProgress(`${completed} de ${serialized.length} trechos traduzidos.`);
  }
  const blocks: Record<string, ContentRun[]> = Object.create(null);
  const issues = [...document.issues];
  for (const block of document.blocks) {
    const cached = Object.prototype.hasOwnProperty.call(state.completed, block.id) ? state.completed[block.id] : undefined;
    const runs = cached ? cloneRuns(cached.runs) : cloneRuns(block.runs);
    blocks[block.id] = runs;
    if (cached) {
      for (const issue of [numericIssue(block, runs), markerPositionIssue(block, runs), superscriptIssue(block, runs)]) {
        if (issue) issues.push(issue);
      }
      if (block.runs.some(run => run.type === 'asset' && assets.get(run.assetId)?.kind === 'equation-inline')) {
        issues.push({ id: `translation-protected-${block.id}`, page: block.page, blockId: block.id,
          severity: 'warning', message: 'Confira a frase ao redor dos símbolos preservados: a tradução pode alterar espaços, unidades ou a posição da expressão.' });
      }
    }
  }
  return { document: { ...document, issues }, blocks, sourceLanguage: options.source, targetLanguage: options.target };
}
