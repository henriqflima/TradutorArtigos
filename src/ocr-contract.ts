/** Public OCR contract. Coordinates use the returned page dimensions; confidence is 0–100. */
export const OCR_ENGINE = 'ocr-v1';
// Per-page transport stays below Netlify's binary request limit; the input file has its own 7 MB limit.
export const MAX_OCR_REQUEST_BYTES = 4_000_000;
export const MAX_OCR_RESPONSE_BYTES = 2_000_000;
export const MAX_OCR_BLOCKS = 5_000;
export const OCR_TIMEOUT_MS = 50_000;

export type OcrBlock = {
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  content: string;
  confidence: number | null;
};
export type OcrResult = {
  model: string;
  page: { width: number; height: number; confidence: number | null; blocks: OcrBlock[] };
  usage: { pages: number };
};
