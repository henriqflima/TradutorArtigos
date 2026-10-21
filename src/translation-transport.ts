import { abortIfNeeded } from './structured-document';

function fail(message: string): never { throw new Error(message); }

async function pause(ms: number, signal: AbortSignal) {
  abortIfNeeded(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new DOMException('Operação cancelada.', 'AbortError')); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function requestTranslations(body: object, code: string, signal: AbortSignal, path = '/api/translate-text'): Promise<string[]> {
  const requestReference = (response: Response) => {
    const id = response.headers.get('x-nf-request-id')?.trim() || '';
    return /^[A-Za-z0-9._:-]{1,128}$/.test(id) ? ` Referência da solicitação: ${id}.` : '';
  };
  const retryAfter = (response: Response, result: Record<string, unknown> | null) => {
    const value = response.headers.get('retry-after')?.trim();
    let headerDelay: number | undefined;
    if (value) {
      const seconds = Number(value);
      const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : Date.parse(value) - Date.now();
      if (Number.isFinite(delay)) headerDelay = Math.max(0, delay);
    }
    const bodyDelay = typeof result?.retryAfterMs === 'number' && Number.isFinite(result.retryAfterMs) && result.retryAfterMs >= 0
      ? result.retryAfterMs : undefined;
    return headerDelay === undefined ? bodyDelay : Math.max(headerDelay, bodyDelay || 0);
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    abortIfNeeded(signal);
    let response: Response;
    try {
      response = await fetch(path, {
        method: 'POST', cache: 'no-store', signal,
        headers: { 'Content-Type': 'application/json', ...(code ? { 'X-Access-Code': code } : {}) },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      if (signal.aborted) throw new DOMException('Operação cancelada.', 'AbortError');
      throw new Error('Não foi possível confirmar se o serviço de tradução recebeu este lote. Confira a conexão antes de repetir a tradução.');
    }
    const reference = requestReference(response);
    let raw: string;
    try { raw = await response.text(); }
    catch {
      abortIfNeeded(signal);
      throw new Error(`Não foi possível ler a resposta deste lote (HTTP ${response.status}). Não é possível confirmar se o processamento foi concluído.${reference}`);
    }
    abortIfNeeded(signal);
    let result: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) result = parsed as Record<string, unknown>;
    } catch { /* Infrastructure errors can return plain text or HTML. Never display that body. */ }
    if (response.ok) {
      if (!Array.isArray(result?.translations) || !result.translations.every((item: unknown) => typeof item === 'string')) {
        fail(`O servidor devolveu uma resposta de tradução inválida (HTTP ${response.status}).${reference}`);
      }
      return result.translations;
    }
    const rateLimited = response.status === 429 && (result?.retryable === true || !result);
    if (rateLimited && attempt < 2) {
      const backoff = retryAfter(response, result) ?? 1_000 * 2 ** attempt + Math.floor(Math.random() * 300);
      // A larger delay overflows setTimeout; leave such a wait to an explicit resume.
      if (backoff > 2_147_483_647) fail(`O limite de solicitações foi atingido (HTTP 429). Aguarde antes de retomar.${reference}`);
      await pause(backoff, signal);
      continue;
    }
    if (typeof result?.error === 'string' && result.error.trim()) throw new Error(result.error);
    if (response.status === 429) fail(`O limite de solicitações foi atingido (HTTP 429). Aguarde antes de retomar.${reference}`);
    if ([502, 503, 504].includes(response.status)) {
      fail(`O servidor não confirmou a conclusão deste lote (HTTP ${response.status}). Os trechos anteriores continuam nesta sessão. Confira antes de retomar.${reference}`);
    }
    fail(`Não foi possível concluir este lote (HTTP ${response.status}).${reference}`);
  }
  return fail('A tradução deste lote falhou.');
}

