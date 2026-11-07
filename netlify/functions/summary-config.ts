import type { Config } from '@netlify/functions';
import { env, failure, json } from './_shared/http';
import { ocrModel } from './_shared/mistral';
import { SUMMARY_PROMPT_VERSION, summaryModel } from './_shared/summary-openai';

export default async () => {
  try { return json({ configured: Boolean(env('OPENAI_API_KEY')), ocrConfigured: Boolean(env('MISTRAL_API_KEY')),
    accessRequired: Boolean(env('APP_ACCESS_CODE')), model: summaryModel(), ocrModel: ocrModel(), promptVersion: SUMMARY_PROMPT_VERSION }); }
  catch (error) { return failure(error); }
};
export const config: Config = { path: '/api/summary-config', method: 'GET' };
