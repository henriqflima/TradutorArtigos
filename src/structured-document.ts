/** Coordinates are PDF points, with origin at the top left of the source page. */
export type SourceRect = { x: number; y: number; width: number; height: number };
export type RunStyle = { bold?: boolean; italic?: boolean; superscript?: boolean };
/** Source appearance is advisory PDF layout metadata, separate from translated runs. */
export type BlockAppearance = {
  fontSize?: number;
  fontFamily?: 'serif' | 'sans-serif' | 'monospace';
  lineHeight?: number;
  alignment?: 'left' | 'center' | 'right' | 'justify';
  bold?: boolean;
  italic?: boolean;
  confidence?: 'native' | 'estimated';
};
export type ContentRun =
  | { type: 'text'; text: string; style?: RunStyle }
  | { type: 'asset'; assetId: string };
export type DocumentAsset = {
  id: string;
  kind: 'equation-inline' | 'equation-block' | 'figure' | 'table';
  page: number;
  rect: SourceRect;
  widthPt: number;
  heightPt: number;
  png: Uint8Array;
  dataUrl: string;
  sha256: string;
  alt: string;
  baselineOffsetPt?: number;
  /** Explicit text-to-crop association when OCR only locates whole blocks. */
  sourceText?: { blockId: string; text: string; occurrence?: number };
};
export type DocumentBlock = {
  id: string;
  kind: 'paragraph' | 'heading' | 'caption' | 'equation' | 'figure' | 'table';
  page: number;
  rect: SourceRect;
  runs: ContentRun[];
  fontSize: number;
  appearance?: BlockAppearance;
  /** Original OCR classification, including headers, footers and references. */
  sourceRole?: string;
  assetId?: string;
  captionId?: string;
  geometry?: 'block';
  /** Original recognized text, before user corrections or crop replacement. */
  originalText?: string;
  /** A paragraph may continue in another column or on the following page. */
  fragments?: { page: number; rect: SourceRect }[];
};
export type DocumentIssue = {
  id: string;
  page: number;
  blockId?: string;
  message: string;
  severity: 'warning' | 'blocking';
};
export type StructuredDocument = {
  version: 1;
  sourceName: string;
  sourceHash: string;
  sourceKind: 'pdf';
  pages: { width: number; height: number }[];
  blocks: DocumentBlock[];
  assets: DocumentAsset[];
  issues: DocumentIssue[];
};
export type TranslatedDocument = {
  document: StructuredDocument;
  blocks: Record<string, ContentRun[]>;
  sourceLanguage: string;
  targetLanguage: string;
};
export function blockText(block: DocumentBlock) {
  return block.runs.map(run => run.type === 'text' ? run.text : '〔objeto preservado〕').join('');
}
export function translatableBlocks(document: StructuredDocument) {
  return document.blocks.filter(block => !['equation', 'figure', 'table'].includes(block.kind) && block.runs.some(run => run.type === 'text' && run.text.trim()));
}
export function abortIfNeeded(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Operação cancelada.', 'AbortError');
}
export async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
