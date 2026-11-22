import type { Config } from '@netlify/functions';
import { OCR_ENGINE } from '../../src/ocr-contract.js';
import { TRANSLATION_ENGINE } from '../../src/shared.js';
import { env, json, processingService } from './_shared/http.js';

export default async () => json({
  configured: Boolean(processingService('translation')), accessRequired: Boolean(env('APP_ACCESS_CODE')),
  provider: 'translation', model: TRANSLATION_ENGINE,
  ocr: { configured: Boolean(processingService('ocr')), provider: 'ocr', model: OCR_ENGINE },
});
export const config: Config = { path: '/api/config', method: 'GET' };
