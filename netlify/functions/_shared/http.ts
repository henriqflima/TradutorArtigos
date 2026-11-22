export type ProviderErrorDetails = {
  provider: 'ocr';
  status: number;
  reason: 'monthly_quota' | 'spending_limit' | 'credits' | 'request_rate' | 'page_rate' | 'token_rate' | 'free_tier_capacity' | 'capacity' | 'unknown';
};
export class HttpError extends Error {
  constructor(public status: number, message: string, public providerError?: ProviderErrorDetails) { super(message); }
}
export function headers() {
  return { 'Cache-Control': 'no-store, private, max-age=0', 'Netlify-CDN-Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
}
export function json(value: unknown, status = 200) { return Response.json(value, { status, headers: headers() }); }
export function env(name: string) {
  const value = typeof Netlify === 'undefined' ? process.env[name] : Netlify.env.get(name);
  return value?.trim() || '';
}
type Service = 'translation' | 'summary' | 'ocr';
const modelVariable: Record<Service, string> = {
  translation: 'TRANSLATION_MODEL',
  summary: 'SUMMARY_MODEL',
  ocr: 'OCR_MODEL',
};
const serviceUnavailable: Record<Service, string> = {
  translation: 'A tradução ainda não foi ativada. Entre em contato com o responsável para concluir a configuração do serviço.',
  summary: 'O serviço de resumo ainda não foi configurado.',
  ocr: 'O reconhecimento de PDFs ainda não foi ativado. Confira a configuração do serviço de OCR no servidor.',
};

export function processingService(service: Service) {
  const prefix = service === 'ocr' ? 'OCR' : 'LANGUAGE';
  const key = env(prefix + '_API_KEY');
  const model = env(modelVariable[service]);
  if (!key || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$/.test(model)) return;
  try {
    const url = new URL(env(prefix + '_API_URL'));
    if (url.protocol === 'https:' && !url.username && !url.password && !url.hash) {
      return { key, model, url: url.href };
    }
  } catch {
    // A missing or invalid endpoint leaves the service unavailable.
  }
}
export function requireProcessingService(service: Service) {
  const settings = processingService(service);
  if (!settings) throw new HttpError(503, serviceUnavailable[service]);
  return settings;
}
export function authorize(req: Request, service: Service = 'translation') {
  if (req.method !== 'POST') throw new HttpError(405, 'Método não permitido.');
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) throw new HttpError(403, 'Origem não permitida.');
  const accessCode = env('APP_ACCESS_CODE');
  if (accessCode && req.headers.get('x-access-code') !== accessCode) throw new HttpError(401, 'O código de acesso está incorreto.');
  requireProcessingService(service);
}
export async function readBounded(req: Request | Response, max: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (Number(req.headers.get('content-length')) > max) throw new HttpError(413, 'O conteúdo excede o limite permitido.');
  const reader = req.body?.getReader();
  if (!reader) throw new HttpError(400, 'Envie o conteúdo da solicitação.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const part = await reader.read();
      signal?.throwIfAborted();
      if (part.done) break;
      length += part.value.length;
      if (length > max) { void reader.cancel().catch(() => {}); throw new HttpError(413, 'O conteúdo excede o limite permitido.'); }
      chunks.push(part.value);
    }
  } finally { signal?.removeEventListener('abort', cancel); reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
export function failure(error: unknown) {
  return json({ error: error instanceof HttpError ? error.message : 'Não foi possível processar a solicitação.',
    ...(error instanceof HttpError && error.providerError ? { providerError: error.providerError } : {}) }, error instanceof HttpError ? error.status : 500);
}
