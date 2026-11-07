import { env, HttpError, readBounded } from './http.js';

export const SUMMARY_PROMPT_VERSION = 'scientific-summary-v2';
export function summaryModel() {
  const model = env('SUMMARY_MODEL') || 'gpt-6.1-terra';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,100}$/.test(model)) throw new HttpError(503, 'O modelo de resumo configurado é inválido.');
  return model;
}

/** Summary authorization deliberately has no dependency on translation configuration. */
export function authorizeSummary(req: Request, provider: 'openai' | 'mistral' = 'openai') {
  if (req.method !== 'POST') throw new HttpError(405, 'Método não permitido.');
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) throw new HttpError(403, 'Origem não permitida.');
  const code = env('APP_ACCESS_CODE');
  if (code && req.headers.get('x-access-code') !== code) throw new HttpError(401, 'O código de acesso está incorreto.');
  if (!env(provider === 'mistral' ? 'MISTRAL_API_KEY' : 'OPENAI_API_KEY')) {
    throw new HttpError(503, provider === 'mistral'
      ? 'Configure a chave Mistral para extrair os artigos do resumo.'
      : 'Configure a chave OpenAI para analisar as evidências e gerar resumos.');
  }
}

export async function summaryInput(req: Request, fields: readonly string[], maxBytes: number): Promise<Record<string, unknown>> {
  if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'Envie os dados do resumo em JSON.');
  }
  let data: unknown;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(req, maxBytes, req.signal))); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Os dados do resumo são inválidos.'); }
  if (!isRecord(data) || Object.keys(data).some(key => !fields.includes(key))) throw new HttpError(400, 'Os dados do resumo contêm campos inválidos.');
  return data;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function boundedString(value: unknown, max = 20_000, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0) &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}
export function stringList(value: unknown, count = 100, max = 4_000): value is string[] {
  return Array.isArray(value) && value.length <= count && value.every(item => boundedString(item, max));
}
export function safeWebUrl(value: unknown): value is string {
  if (!boundedString(value, 2_048)) return false;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}

type ResponseOptions = {
  name: string;
  instructions: string;
  input: unknown;
  schema: Record<string, unknown>;
  image?: string;
  search?: boolean;
};

/** The deadline covers both provider headers and body. Provider prose never reaches clients/logs. */
export async function summaryResponse(options: ResponseOptions, signal: AbortSignal): Promise<{ data: unknown; citedUrls: Set<string>; searched: boolean }> {
  const deadline = AbortSignal.timeout(50_000);
  const upstreamSignal = AbortSignal.any([signal, deadline]);
  const transportError = () => new HttpError(signal.aborted ? 499 : deadline.aborted ? 504 : 502,
    signal.aborted ? 'O resumo foi interrompido. Uma chamada já aceita ainda pode gerar cobrança.'
      : 'Não foi possível confirmar a conclusão desta etapa do resumo. As etapas recebidas permanecem na sessão; retome quando desejar.');
  const content: object[] = [{ type: 'input_text', text: JSON.stringify(options.input) }];
  if (options.image) content.push({ type: 'input_image', image_url: options.image, detail: 'high' });
  let response: Response;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', signal: upstreamSignal,
      headers: { Authorization: `Bearer ${env('OPENAI_API_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: summaryModel(), store: false, reasoning: { effort: 'low' }, max_output_tokens: 12_000,
        instructions: options.instructions, input: [{ role: 'user', content }],
        text: { format: { type: 'json_schema', name: options.name, strict: true, schema: options.schema } },
        metadata: { summary_prompt_version: SUMMARY_PROMPT_VERSION },
        ...(options.search ? { tools: [{ type: 'web_search', search_context_size: 'low' }], max_tool_calls: 3,
          include: ['web_search_call.action.sources'] } : {}),
      }),
    });
  } catch { throw transportError(); }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    if (response.status === 429) throw new HttpError(429, 'O serviço de resumo atingiu um limite de uso. Aguarde e confira a quota antes de retomar.');
    if ([401, 403, 404].includes(response.status)) throw new HttpError(503, 'A configuração do modelo de resumo não foi aceita. Confira acesso, modelo e ferramentas disponíveis.');
    throw new HttpError(502, 'O serviço de resumo não confirmou esta etapa. Confira antes de reenviá-la.');
  }
  let result: unknown;
  try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(response, 1_500_000, upstreamSignal))); }
  catch { if (upstreamSignal.aborted) throw transportError(); throw new HttpError(502, 'O serviço de resumo devolveu uma resposta inválida.'); }
  if (!isRecord(result) || result.status !== 'completed' || result.error || !Array.isArray(result.output)) {
    throw new HttpError(502, 'Esta etapa do resumo ficou incompleta. Os resultados anteriores permanecem na sessão.');
  }
  const parts = result.output.filter(isRecord).filter(item => item.type === 'message' && item.role === 'assistant')
    .flatMap(item => Array.isArray(item.content) ? item.content.filter(isRecord) : []);
  if (parts.some(item => item.type === 'refusal')) throw new HttpError(422, 'O serviço recusou esta etapa do resumo. Revise o conteúdo antes de continuar.');
  const texts = parts.filter(item => item.type === 'output_text');
  if (texts.length !== 1 || typeof texts[0].text !== 'string') throw new HttpError(502, 'O serviço não devolveu o resumo no formato esperado.');
  const citedUrls = new Set<string>();
  for (const part of parts) for (const item of Array.isArray(part.annotations) ? part.annotations : []) {
    if (isRecord(item) && item.type === 'url_citation' && safeWebUrl(item.url)) citedUrls.add(item.url);
  }
  // Structured JSON may not receive inline annotations. A returned web-search source list
  // independently establishes that a URL was actually retrieved by the tool.
  for (const item of result.output.filter(isRecord)) {
    if (item.type !== 'web_search_call' || !isRecord(item.action) || !Array.isArray(item.action.sources)) continue;
    for (const source of item.action.sources) if (isRecord(source) && safeWebUrl(source.url)) citedUrls.add(source.url);
  }
  const searched = result.output.some(item => isRecord(item) && item.type === 'web_search_call');
  try { return { data: JSON.parse(texts[0].text), citedUrls, searched }; }
  catch { throw new HttpError(502, 'O serviço devolveu dados de resumo inválidos.'); }
}

export const stringsSchema = { type: 'array', items: { type: 'string' } };
export function objectSchema(properties: Record<string, unknown>) {
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };
}
