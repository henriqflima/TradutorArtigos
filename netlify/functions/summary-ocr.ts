import type { Config } from '@netlify/functions';
import { PDFDocument } from 'pdf-lib';
import { MAX_OCR_REQUEST_BYTES } from '../../src/ocr-contract.js';
import { failure, HttpError, json, readBounded } from './_shared/http.js';
import { recognizePdf } from './_shared/mistral.js';
import { authorizeSummary } from './_shared/summary-openai.js';

export default async (req: Request) => {
  try {
    authorizeSummary(req, 'mistral');
    if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/pdf') throw new HttpError(415, 'Envie uma página PDF para extrair as evidências do resumo.');
    const bytes = await readBounded(req, MAX_OCR_REQUEST_BYTES, req.signal);
    if (new TextDecoder('ascii').decode(bytes.subarray(0, 5)) !== '%PDF-') throw new HttpError(400, 'O arquivo não é um PDF válido.');
    let pdf: PDFDocument;
    try { pdf = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true }); }
    catch { throw new HttpError(400, 'O PDF está inválido ou protegido. Envie um documento legível sem senha.'); }
    if (pdf.getPageCount() !== 1) throw new HttpError(400, 'Envie somente uma página por chamada de extração.');
    const page = pdf.getPage(0), { width, height } = page.getSize();
    if (![width, height].every(value => Number.isFinite(value) && value >= 100 && value <= 3000) || page.getRotation().angle % 180 !== 0) {
      throw new HttpError(400, 'A página tem dimensões ou rotação não suportadas. Gire o PDF antes de analisar.');
    }
    req.signal.throwIfAborted();
    const result = await recognizePdf(bytes, req.signal);
    if (Math.abs((result.page.width / result.page.height) / (width / height) - 1) > 0.03) throw new HttpError(502, 'O OCR retornou dimensões incompatíveis com a página original.');
    return json(result);
  } catch (error) { return failure(error); }
};
export const config: Config = { path: '/api/summary-ocr', rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
