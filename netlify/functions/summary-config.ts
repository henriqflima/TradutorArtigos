import type { Config } from '@netlify/functions';
import { OCR_ENGINE } from '../../src/ocr-contract.js';
import { SUMMARY_ENGINE } from '../../src/summary-contract.js';
import { env, json, processingService } from './_shared/http.js';
import { SUMMARY_PROMPT_VERSION } from './_shared/summary-service.js';

export default async () => json({
  configured: Boolean(processingService('summary')), ocrConfigured: Boolean(processingService('ocr')),
  accessRequired: Boolean(env('APP_ACCESS_CODE')), model: SUMMARY_ENGINE, ocrModel: OCR_ENGINE,
  promptVersion: SUMMARY_PROMPT_VERSION,
});
export const config: Config = { path: '/api/summary-config', method: 'GET' };
