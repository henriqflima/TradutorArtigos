import type { Config } from '@netlify/functions';
import { TRANSLATION_MODEL } from '../../src/shared.js';
import { env, json } from './_shared/http.js';
import { ocrModel } from './_shared/mistral.js';

export default async () => json({ configured: Boolean(env('OPENAI_API_KEY')), accessRequired: Boolean(env('APP_ACCESS_CODE')), provider: 'openai', model: TRANSLATION_MODEL,
  ocr: { configured: Boolean(env('MISTRAL_API_KEY')), provider: 'mistral', model: ocrModel() } });
export const config: Config = { path: '/api/config', method: 'GET' };
