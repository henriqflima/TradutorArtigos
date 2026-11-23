import type { OcrResult } from './ocr-contract';
import { splitInlineMath } from './inline-math';
import { associateCaptions } from './caption-links';
import type { ContentRun, DocumentAsset, DocumentBlock, DocumentIssue, SourceRect } from './structured-document';

export type OcrRegion = { index: number; type: string; rect: SourceRect; text: string; confidence: number | null };
export type OcrLayout = { model: string; regions: OcrRegion[]; confidence: number | null; usableCharacters: number; lowConfidenceBlocks: number };

function contentText(content: string) {
  // Keep math delimiters for protection, review and local typesetting; never turn provider HTML into DOM.
  return content.replace(/^#{1,6}\s+/gm, '').replace(/\[([^\]\n]+)\]\((?:https?:\/\/|mailto:)[^)\n]+\)/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1').trim();
}

export function layoutFromOcr(result: OcrResult, width: number, height: number): OcrLayout {
  const sx = width / result.page.width, sy = height / result.page.height;
  if (![sx, sy].every(n => Number.isFinite(n) && n > 0)) throw new Error('O OCR retornou dimensões inválidas.');
  const regions = result.page.blocks.map((block, index): OcrRegion => ({ index, type: block.type,
    rect: { x: block.x * sx, y: block.y * sy, width: block.width * sx, height: block.height * sy },
    text: contentText(block.content), confidence: block.confidence }));
  return { model: result.model, regions, confidence: result.page.confidence,
    usableCharacters: regions.filter(b => !isVisualRegion(b)).reduce((n, b) => n + b.text.replace(/[^\p{L}\p{N}]/gu, '').length, 0),
    lowConfidenceBlocks: regions.filter(b => b.confidence !== null && b.confidence < 65).length };
}

export function isVisualRegion(region: OcrRegion) { return ['image', 'table', 'equation'].includes(region.type); }
export function ocrBlockId(page: number, index: number) { return `p${page}-ocr-${index}`; }
export function ocrAssetId(page: number, index: number) { return `auto-${page}-ocr-${index}`; }
export function hasUnprotectedOcrMath(text: string) {
  return splitInlineMath(text).some(segment => segment.type === 'math');
}
export function ocrMathWarning(page: number, blockId: string): DocumentIssue {
  return { id: `ocr-inline-math-${blockId}`, page, blockId, severity: 'warning',
    message: 'Há uma fórmula reconhecida dentro do texto. Ela será protegida na tradução e desenhada na exportação. Confira a expressão reconhecida e, se necessário, preserve-a como recorte do original. Este aviso não impede a confirmação da página.' };
}
function area(r: SourceRect) { return r.width * r.height; }
function overlap(a: SourceRect, b: SourceRect) {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}
function assetBlock(asset: DocumentAsset): DocumentBlock {
  return { id: `asset:${asset.id}`, page: asset.page, rect: { ...asset.rect },
    kind: asset.kind === 'figure' ? 'figure' : asset.kind === 'table' ? 'table' : 'equation',
    runs: [{ type: 'asset', assetId: asset.id }], assetId: asset.id, fontSize: 10 };
}

/** Use provider reading order and whole-block geometry, never fabricated word boxes. */
export function blocksFromOcr(layout: OcrLayout, page: number, assets: readonly DocumentAsset[]) {
  const issues: DocumentIssue[] = [], blocks: { block: DocumentBlock; order: number }[] = [];
  const used = new Set<string>();
  const problem = (id: string, message: string, blockId?: string) => issues.push({ id, page, message, severity: 'blocking', blockId });
  for (const region of layout.regions) {
    const id = ocrBlockId(page, region.index);
    if (isVisualRegion(region)) {
      const source = assets.find(asset => !asset.sourceText && (asset.id === ocrAssetId(page, region.index) ||
        overlap(asset.rect, region.rect) / area(region.rect) > 0.9));
      if (!source) problem(`ocr-region-${id}`, 'Uma figura, tabela ou equação reconhecida está sem recorte. Preserve essa região do original antes de confirmar a página.');
      else if (!used.has(source.id)) { blocks.push({ block: assetBlock(source), order: region.index }); used.add(source.id); }
      continue;
    }
    if (!region.text) continue;
    const covering = assets.find(asset => !asset.sourceText && asset.rect.x <= region.rect.x + 1e-6 &&
      asset.rect.y <= region.rect.y + 1e-6 && asset.rect.x + asset.rect.width >= region.rect.x + region.rect.width - 1e-6 &&
      asset.rect.y + asset.rect.height >= region.rect.y + region.rect.height - 1e-6);
    if (covering) {
      if (!used.has(covering.id)) { blocks.push({ block: assetBlock(covering), order: region.index }); used.add(covering.id); }
      continue;
    }
    const replacements: { asset: DocumentAsset; start: number; end: number }[] = [];
    for (const asset of assets) {
      if (asset.sourceText?.blockId === id) {
        const text = asset.sourceText.text;
        const matches: number[] = [];
        if (text) for (let from = 0; from < region.text.length;) {
          const position = region.text.indexOf(text, from);
          if (position < 0) break;
          matches.push(position); from = position + 1;
        }
        const occurrence = asset.sourceText.occurrence;
        if (!matches.length || (occurrence === undefined ? matches.length !== 1 :
          !Number.isInteger(occurrence) || occurrence < 1 || occurrence > matches.length)) {
          problem(`ocr-link-${asset.id}`, 'O texto associado ao recorte precisa existir no trecho original. Se a expressão se repete, escolha sua ocorrência no vínculo do recorte.', id);
          continue;
        }
        const start = matches[(occurrence ?? 1) - 1];
        const end = start + text.length;
        if (replacements.some(r => start < r.end && end > r.start)) {
          problem(`ocr-link-overlap-${asset.id}`, 'Dois recortes substituem o mesmo texto. Ajuste seus vínculos.', id);
          continue;
        }
        if (overlap(asset.rect, region.rect) < 1) {
          problem(`ocr-link-position-${asset.id}`, 'O recorte associado está fora do trecho de texto. Confira a região e o vínculo.', id);
          continue;
        }
        replacements.push({ asset, start, end }); used.add(asset.id);
      } else if (!asset.sourceText && overlap(asset.rect, region.rect) > Math.min(area(asset.rect), area(region.rect)) * 0.1) {
        problem(`ocr-partial-${asset.id}-${id}`, 'O recorte intercepta um bloco de OCR. Informe o trecho e o texto original substituído pelo recorte para preservar a prosa ao redor.', id);
      }
    }
    replacements.sort((a, b) => a.start - b.start);
    const runs: ContentRun[] = [];
    let cursor = 0;
    for (const replacement of replacements) {
      if (replacement.start > cursor) runs.push({ type: 'text', text: region.text.slice(cursor, replacement.start) });
      runs.push({ type: 'asset', assetId: replacement.asset.id }); cursor = replacement.end;
    }
    if (cursor < region.text.length) runs.push({ type: 'text', text: region.text.slice(cursor) });
    const remainingText = runs.map(run => run.type === 'text' ? run.text : '').join('');
    if (hasUnprotectedOcrMath(remainingText)) {
      issues.push(ocrMathWarning(page, id));
    }
    blocks.push({ order: region.index, block: { id, page, rect: { ...region.rect }, geometry: 'block', originalText: region.text, sourceRole: region.type,
      kind: region.type === 'title' ? 'heading' : region.type === 'caption' ? 'caption' : 'paragraph',
      runs, fontSize: region.type === 'title' ? 14 : region.type === 'caption' ? 9 : 10 } });
  }
  for (const asset of assets) {
    if (used.has(asset.id)) continue;
    if (asset.sourceText && !issues.some(issue => issue.id.startsWith(`ocr-link-${asset.id}`))) {
      problem(`ocr-unused-link-${asset.id}`, 'O vínculo de texto deste recorte não pôde ser aplicado. Confira o trecho original associado.');
    }
    // Place manually added regions by the nearest original region in provider order.
    const closest = [...layout.regions].sort((a, b) => {
      const distance = (r: OcrRegion) => Math.hypot(r.rect.x - asset.rect.x, r.rect.y - asset.rect.y);
      return distance(a) - distance(b);
    })[0];
    const after = closest && asset.rect.y > closest.rect.y ? 0.5 : -0.5;
    blocks.push({ block: assetBlock(asset), order: closest ? closest.index + after : 0 });
  }
  const ordered = blocks.sort((a, b) => a.order - b.order).map(entry => entry.block);
  const links = associateCaptions(ordered), linkedCaptions = new Set(links.values());
  for (const block of ordered) {
    const captionId = links.get(block.id);
    if (captionId) block.captionId = captionId;
    if (block.kind === 'paragraph' && linkedCaptions.has(block.id)) {
      block.kind = 'caption';
      block.fontSize = 9;
    }
  }
  return { blocks: ordered, issues };
}
