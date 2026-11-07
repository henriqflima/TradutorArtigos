import type { Config } from '@netlify/functions';
import { PDFDocument } from 'pdf-lib';
import { MAX_OCR_REQUEST_BYTES } from '../../src/ocr-contract.js';
import { authorize, failure, HttpError, json, readBounded } from './_shared/http.js';
import { recognizePdf } from './_shared/mistral.js';

export default async (req: Request) => {
  try {
    authorize(req, 'mistral');
    if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/pdf') {
      throw new HttpError(415, 'Envie uma página em PDF para reconhecimento.');
    }
    const bytes = await readBounded(req, MAX_OCR_REQUEST_BYTES, req.signal);
    if (new TextDecoder('ascii').decode(bytes.subarray(0, 5)) !== '%PDF-') throw new HttpError(400, 'O arquivo não é um PDF válido.');
    let pdf: PDFDocument;
    try { pdf = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true }); }
    catch { throw new HttpError(400, 'O PDF está inválido ou protegido. Envie um documento legível sem senha.'); }
    if (pdf.getPageCount() !== 1) throw new HttpError(400, 'Envie somente uma página por chamada de OCR.');
    const page = pdf.getPage(0), { width, height } = page.getSize();
    if (![width, height].every(value => Number.isFinite(value) && value >= 100 && value <= 3000) || page.getRotation().angle % 180 !== 0) {
      throw new HttpError(400, 'A página tem dimensões ou rotação não suportadas. Gire o PDF antes de analisar.');
    }
    req.signal.throwIfAborted();
    const result = await recognizePdf(bytes, req.signal);
    // Unexpected orientation or aspect ratio would place source crops over the
    // wrong content. Refuse rather than silently scale an incompatible page.
    if (Math.abs((result.page.width / result.page.height) / (width / height) - 1) > 0.03) {
      throw new HttpError(502, 'A Mistral retornou dimensões incompatíveis com a página original. Confira a rotação do PDF.');
    }
    return json(result);
  } catch (error) { return failure(error); }
};

export const config: Config = {
  path: '/api/ocr',
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
