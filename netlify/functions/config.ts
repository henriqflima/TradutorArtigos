import type { Config } from '@netlify/functions';
import { TRANSLATION_MODEL } from '../../src/shared';
import { env, json } from './_shared/http';

export default async () => json({ configured: Boolean(env('OPENAI_API_KEY')), accessRequired: Boolean(env('APP_ACCESS_CODE')), provider: 'openai', model: TRANSLATION_MODEL });
export const config: Config = { path: '/api/config', method: 'GET' };
