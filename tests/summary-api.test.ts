import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import configHandler from '../netlify/functions/summary-config';
import ocrHandler from '../netlify/functions/summary-ocr';
import evidenceHandler from '../netlify/functions/summary-evidence';
import composeHandler from '../netlify/functions/summary-compose';
import explainHandler from '../netlify/functions/summary-explain';
import type { SummaryEvidence, SummarySource } from '../src/summary-contract';

let settings: Record<string, string>;
const provider = vi.fn();
const source: SummarySource = { id: 'p1-b1', page: 1, kind: 'text',
  text: 'The sample contained 25 mg at 20 °C.', originalText: 'The sample contained 25 mg at 20 °C.', confidence: 99,
  rect: { x: 10, y: 10, width: 300, height: 40 } };
const evidence: SummaryEvidence = { id: 'e1', section: 'results', statement: 'A amostra continha 25 mg a 20 °C.',
  sourceIds: [source.id], quotes: ['25 mg at 20 °C'], values: ['25 mg', '20 °C'], caveats: [], origin: 'study', certainty: 'reported' };
const request = (path: string, body: unknown, headers: Record<string, string> = {}) => new Request(`https://lume.test/api/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://lume.test', ...headers }, body: JSON.stringify(body),
});
function output(data: unknown, annotations: unknown[] = []) {
  return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [
    { type: 'output_text', text: JSON.stringify(data), annotations },
  ] }] });
}
const extraction = () => ({ evidence: [evidence], concepts: ['Calor específico'], warnings: [] });
beforeEach(() => {
  settings = { LANGUAGE_API_KEY: 'test-language-key', LANGUAGE_API_URL: 'https://processing.test/v1/responses', SUMMARY_MODEL: 'summary-model-internal',
    OCR_API_KEY: 'test-ocr-key', OCR_API_URL: 'https://processing.test/v1/ocr', OCR_MODEL: 'ocr-model-internal' };
  vi.stubGlobal('Netlify', { env: { get: (name: string) => settings[name] } });
  vi.stubGlobal('fetch', provider);
  provider.mockReset(); provider.mockResolvedValue(output(extraction()));
});
afterEach(() => vi.unstubAllGlobals());

describe('independent summary APIs', () => {
  it('reports dedicated summary configuration without revealing server settings', async () => {
    settings.SUMMARY_MODEL = 'summary-model'; settings.APP_ACCESS_CODE = 'private';
    const response = await configHandler();
    const config = await response.json();
    expect(config).toMatchObject({ configured: true, ocrConfigured: true, accessRequired: true, model: 'summary-v1', ocrModel: 'ocr-v1' });
    expect(JSON.stringify(config)).not.toMatch(/summary-model|test-language-key|test-ocr-key|processing\.test/);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(provider).not.toHaveBeenCalled();
  });
  it('extracts numeric evidence through its own prompt and checks source references', async () => {
    const response = await evidenceHandler(request('summary-evidence', { sources: [source] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(extraction());
    const [url, init] = provider.mock.calls[0];
    expect(url).toBe('https://processing.test/v1/responses');
    expect(init.redirect).toBe('error');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ store: false, model: 'summary-model-internal', text: { format: { type: 'json_schema', strict: true } } });
    expect(body.instructions).toContain('NOT a translation');
    expect(body.instructions).toContain('prior-work');
    expect(body.tools).toBeUndefined();
    expect(JSON.parse(body.input[0].content[0].text).sources).toEqual([source]);
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it('accepts the original image for visual evidence and does not claim a text quotation', async () => {
    const visual = { ...source, kind: 'table', text: '' };
    provider.mockResolvedValueOnce(output({ evidence: [{ ...evidence, quotes: ['25 mg in the table'] }], concepts: [], warnings: [] }));
    const image = 'data:image/jpeg;base64,/9j/2Q==';
    const response = await evidenceHandler(request('summary-evidence', { sources: [visual], image }));
    expect(response.status).toBe(200);
    expect(JSON.parse(provider.mock.calls[0][1].body).input[0].content[1]).toEqual({ type: 'input_image', image_url: image, detail: 'high' });
  });
  it.each([
    { sources: [] }, { sources: [{ ...source, page: 51 }] }, { sources: [source, source] },
    { sources: [source, { ...source, id: 'p2-b1', page: 2 }] },
    { sources: [source], image: 'https://arbitrary.test/private.png' },
    { sources: [source], image: 'data:image/jpeg;base64,AAAA' }, { sources: [source], translate: true },
  ])('rejects invalid extraction input before provider access: %j', async input => {
    expect((await evidenceHandler(request('summary-evidence', input))).status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });
  it('rejects invented source IDs and nonverbatim text quotations', async () => {
    provider.mockResolvedValueOnce(output({ ...extraction(), evidence: [{ ...evidence, sourceIds: ['missing'] }] }));
    expect((await evidenceHandler(request('summary-evidence', { sources: [source] }))).status).toBe(502);
    provider.mockResolvedValueOnce(output({ ...extraction(), evidence: [{ ...evidence, quotes: [] }] }));
    expect((await evidenceHandler(request('summary-evidence', { sources: [source] }))).status).toBe(502);
    provider.mockResolvedValueOnce(output({ ...extraction(), evidence: [{ ...evidence, quotes: ['42 kg'] }] }));
    expect((await evidenceHandler(request('summary-evidence', { sources: [source] }))).status).toBe(502);
  });
  it('does not accept duplicated evidence identification', async () => {
    provider.mockResolvedValueOnce(output({ ...extraction(), evidence: [evidence, evidence] }));
    expect((await evidenceHandler(request('summary-evidence', { sources: [source] }))).status).toBe(502);
  });
  it('restores exact source quotations when OCR layout changes only their whitespace', async () => {
    const text = 'The sample contained 25\nmg at 20\u00a0°C.';
    const current = { ...source, text, originalText: text };
    provider.mockResolvedValueOnce(output({ ...extraction(), evidence: [{ ...evidence, quotes: ['25 mg at 20 °C'] }] }));
    const response = await evidenceHandler(request('summary-evidence', { sources: [current] }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].quotes).toEqual(['25\nmg at 20\u00a0°C']);
    expect(result.warnings).toEqual([]);
  });
  it('continues to reject contradictory quotations even when their whitespace is normalized', async () => {
    const text = 'The sample contained 25\nmg at 20\u00a0°C.';
    const current = { ...source, text, originalText: text };
    provider.mockResolvedValueOnce(output({ ...extraction(), evidence: [{ ...evidence, quotes: ['42 mg at 20 °C'] }] }));
    const response = await evidenceHandler(request('summary-evidence', { sources: [current] }));
    expect(response.status).toBe(502);
  });
  it('checks original numeric values and marks unclear evidence for review', async () => {
    provider.mockResolvedValueOnce(output({ ...extraction(), evidence: [{ ...evidence, values: ['42 kg'] }] }));
    const unsupported = await evidenceHandler(request('summary-evidence', { sources: [source] }));
    expect(unsupported.status).toBe(200);
    const excluded = await unsupported.json();
    expect(excluded.evidence).toEqual([]);
    expect(excluded.warnings.join(' ')).toContain(source.id);
    provider.mockResolvedValueOnce(output({ ...extraction(), evidence: [{ ...evidence, certainty: 'unclear' }] }));
    const response = await evidenceHandler(request('summary-evidence', { sources: [source] }));
    expect(response.status).toBe(200); expect((await response.json()).warnings).toHaveLength(1);
  });
  it.each([
    ['The sample contained 25 mg.', '25mg'],
    ['The sample was kept at 20 °C.', '20°C'],
    ['The measured value was 1.5 mg.', '1,5 mg'],
    ['The measured value was 1,5 mg.', '1.5 mg'],
    ['The measured value was 25\u00a0mg.', '25 mg'],
    ['The measured value was 25\u202fmg.', '25 mg'],
    ['The measured value was 25\nmg.', '25 mg'],
    ['The measured value was −25 mg.', '-25 mg'],
  ])('accepts typography-only value differences without changing source text: %s -> %s', async (text, value) => {
    const current = { ...source, text, originalText: text };
    provider.mockResolvedValueOnce(output({ ...extraction(), evidence: [{ ...evidence, statement: text, quotes: [text], values: [value] }] }));
    const response = await evidenceHandler(request('summary-evidence', { sources: [current] }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].sourceIds).toEqual([current.id]);
    expect(result.evidence[0].quotes).toEqual([text]);
    // Either retain the display value or restore the exact source form; no fabricated data is needed.
    expect(result.evidence[0].values).toHaveLength(1);
    expect(JSON.parse(provider.mock.calls[0][1].body).input[0].content[0].text).toContain(text.replace(/\n/g, '\\n'));
  });
  it('checks each numerical value against all cited regions while retaining their individual quotes', async () => {
    const first = { ...source, text: 'The mass was 25 mg.', originalText: 'The mass was 25 mg.' };
    const second = { ...source, id: 'p1-b2', text: 'The temperature was 20 °C.', originalText: 'The temperature was 20 °C.' };
    const combined = { ...evidence, statement: `${first.text} ${second.text}`, sourceIds: [first.id, second.id], quotes: [first.text, second.text], values: ['25mg', '20°C'] };
    provider.mockResolvedValueOnce(output({ ...extraction(), evidence: [combined] }));
    const response = await evidenceHandler(request('summary-evidence', { sources: [first, second] }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].sourceIds).toEqual([first.id, second.id]);
    expect(result.evidence[0].quotes).toEqual([first.text, second.text]);
  });
  it('preserves valid findings and quarantines only the unsupported finding instead of rejecting the page', async () => {
    const unsupported = { ...evidence, id: 'e2', statement: 'A amostra continha 42 kg.', values: ['42 kg'] };
    provider.mockResolvedValueOnce(output({ ...extraction(), evidence: [evidence, unsupported] }));
    const response = await evidenceHandler(request('summary-evidence', { sources: [source] }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.evidence).toEqual([evidence]);
    expect(JSON.stringify(result.evidence)).not.toContain('42 kg');
    expect(result.warnings.join(' ')).toContain(source.id);
    expect(result.warnings.join(' ')).toMatch(/valor|evidência|confirma|confer/i);
  });
  it('keeps quarantine and uncertainty warnings within the old client limit even when provider warnings are full', async () => {
    const warnings = Array.from({ length: 60 }, (_, index) => index === 59 ? 'x'.repeat(19_000) : `Pendência original ${index}.`);
    const unclear = { ...evidence, certainty: 'unclear' };
    const unsupported = { ...evidence, id: 'e2', statement: 'A amostra continha 42 kg.', values: ['42 kg'] };
    provider.mockResolvedValueOnce(output({ ...extraction(), evidence: [unclear, unsupported], warnings }));
    const response = await evidenceHandler(request('summary-evidence', { sources: [source] }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.evidence).toEqual([unclear]);
    expect(result.warnings).toHaveLength(60);
    expect(result.warnings.every((warning: string) => warning.length <= 20_000)).toBe(true);
    expect(result.warnings.some((warning: string) => warning.includes(source.id))).toBe(true);
    expect(result.warnings.some((warning: string) => /incerta/i.test(warning))).toBe(true);
  });
  it.each([
    ['The measured value was -25 mg.', '25 mg'],
    ['The measured value was 25 mg.', '-25 mg'],
    ['The measured value was 25 mg.', '5 mg'],
    ['The measured value was 125 mg.', '25 mg'],
    ['The measured value was 25 mg.', '25 g'],
    ['The measured value was 25 Mg.', '25 mg'],
    ['The measured value was 1.50 mg.', '1.5 mg'],
    ['The measured value was 1.5 mg.', '15 mg'],
  ])('quarantines changed numeric magnitude, sign, precision or units: %s -> %s', async (text, value) => {
    const current = { ...source, text, originalText: text };
    provider.mockResolvedValueOnce(output({ ...extraction(), evidence: [{ ...evidence, statement: text, quotes: [text], values: [value] }] }));
    const response = await evidenceHandler(request('summary-evidence', { sources: [current] }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.evidence).toEqual([]);
    expect(result.warnings.join(' ')).toContain(current.id);
  });
  it('does not borrow a value from an unrelated uncited group', async () => {
    const first = { ...source, text: 'Group A contained 25 mg.', originalText: 'Group A contained 25 mg.' };
    const second = { ...source, id: 'p1-b2', text: 'Group B contained 42 mg.', originalText: 'Group B contained 42 mg.' };
    provider.mockResolvedValueOnce(output({ ...extraction(), evidence: [{ ...evidence, statement: first.text, quotes: [first.text], values: ['42 mg'] }] }));
    const response = await evidenceHandler(request('summary-evidence', { sources: [first, second] }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.evidence).toEqual([]);
    expect(result.warnings.join(' ')).toContain(first.id);
  });
  it('composes results with existing evidence citations in the same language as the source', async () => {
    const section = { key: 'results', paragraphs: [{ text: 'A amostra continha 25 mg a 20 °C.', evidenceIds: ['e1'] }], missing: [] };
    provider.mockResolvedValueOnce(output(section));
    const response = await composeHandler(request('summary-compose', { section: 'results', language: 'Português (Brasil)', evidence: [evidence] }));
    expect(response.status).toBe(200); expect(await response.json()).toEqual(section);
    const body = JSON.parse(provider.mock.calls[0][1].body);
    expect(body.instructions).toContain('AUTHORS'); expect(body.instructions).toContain('most detailed');
    expect(body.tools).toBeUndefined();
  });
  it('rejects invented citations and mismatched sections in the final text', async () => {
    provider.mockResolvedValueOnce(output({ key: 'results', paragraphs: [{ text: 'Texto', evidenceIds: ['invented'] }], missing: [] }));
    expect((await composeHandler(request('summary-compose', { section: 'results', language: 'PT-BR', evidence: [evidence] }))).status).toBe(502);
    provider.mockResolvedValueOnce(output({ key: 'technical', paragraphs: [], missing: ['Não informado'] }));
    expect((await composeHandler(request('summary-compose', { section: 'results', language: 'PT-BR', evidence: [evidence] }))).status).toBe(502);
  });
  it('represents missing methodology without manufacturing equipment', async () => {
    const section = { key: 'methodology', paragraphs: [], missing: ['Equipamentos não informados nas evidências disponíveis.'] };
    provider.mockResolvedValueOnce(output(section));
    expect(await (await composeHandler(request('summary-compose', { section: 'methodology', language: 'PT-BR', evidence: [] }))).json()).toEqual(section);
  });
  it('rejects a new number even when a paragraph uses an existing evidence ID', async () => {
    provider.mockResolvedValueOnce(output({ key: 'results', paragraphs: [{ text: 'A amostra continha 42 mg.', evidenceIds: ['e1'] }], missing: [] }));
    expect((await composeHandler(request('summary-compose', { section: 'results', language: 'PT-BR', evidence: [evidence] }))).status).toBe(502);
  });
  it('allows decimal-comma localization while preserving the underlying numeric literal', async () => {
    const decimal = { ...evidence, statement: 'Measured 25.5 mg', values: ['25.5 mg'] };
    provider.mockResolvedValueOnce(output({ key: 'results', paragraphs: [{ text: 'Foram medidos 25,5 mg.', evidenceIds: ['e1'] }], missing: [] }));
    expect((await composeHandler(request('summary-compose', { section: 'results', language: 'PT-BR', evidence: [decimal] }))).status).toBe(200);
  });
  it('accepts only actual web annotation URLs for explanatory sources', async () => {
    const comments = [{ concept: 'Calor específico', explanation: 'Energia necessária para elevar a temperatura de uma unidade de massa.',
      sources: [{ title: 'Fonte acadêmica', url: 'https://university.test/heat' }] }];
    provider.mockResolvedValueOnce(output({ comments }, [{ type: 'url_citation', title: 'Fonte acadêmica', url: 'https://university.test/heat' }]));
    const response = await explainHandler(request('summary-explain', { concepts: ['Calor específico'], language: 'PT-BR' }));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ comments });
    const body = JSON.parse(provider.mock.calls[0][1].body);
    expect(body).toMatchObject({ tools: [{ type: 'web_search' }], max_tool_calls: 3, store: false });
    expect(JSON.parse(body.input[0].content[0].text)).toEqual({ concepts: ['Calor específico'], language: 'PT-BR' });
    provider.mockResolvedValueOnce(output({ comments }));
    expect((await explainHandler(request('summary-explain', { concepts: ['Calor específico'], language: 'PT-BR' }))).status).toBe(502);
  });
  it('rejects unrequested concepts or article text in explanatory requests', async () => {
    expect((await explainHandler(request('summary-explain', { concepts: ['a', 'b', 'c', 'd'], language: 'PT-BR' }))).status).toBe(400);
    expect((await explainHandler(request('summary-explain', { concepts: ['a'], language: 'PT-BR', article: 'private' }))).status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });
  it('verifies sources from web tool results when structured JSON has no inline annotations', async () => {
    const comments = [{ concept: 'Calor específico', explanation: 'Uma definição didática.', sources: [{ title: 'Fonte', url: 'https://university.test/heat' }] }];
    provider.mockResolvedValueOnce(Response.json({ status: 'completed', output: [
      { type: 'web_search_call', action: { type: 'search', sources: [{ type: 'url', url: 'https://university.test/heat' }] } },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ comments }) }] },
    ] }));
    expect((await explainHandler(request('summary-explain', { concepts: ['Calor específico'], language: 'PT-BR' }))).status).toBe(200);
    provider.mockResolvedValueOnce(Response.json({ status: 'completed', output: [
      { type: 'web_search_call', action: { type: 'search', sources: [] } },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ comments: [{ ...comments[0], sources: [] }] }) }] },
    ] }));
    expect((await explainHandler(request('summary-explain', { concepts: ['Calor específico'], language: 'PT-BR' }))).status).toBe(502);
  });
  it('keeps access/origin checks and independent missing-key errors', async () => {
    expect((await evidenceHandler(new Request('https://lume.test/api/summary-evidence'))).status).toBe(405);
    expect((await evidenceHandler(request('summary-evidence', { sources: [source] }, { Origin: 'https://other.test' }))).status).toBe(403);
    settings.APP_ACCESS_CODE = 'private';
    expect((await evidenceHandler(request('summary-evidence', { sources: [source] }))).status).toBe(401);
    expect((await evidenceHandler(request('summary-evidence', { sources: [source] }, { 'X-Access-Code': 'private' }))).status).toBe(200);
    settings = {};
    const response = await evidenceHandler(request('summary-evidence', { sources: [source] }));
    expect(response.status).toBe(503); expect(await response.text()).toContain('resumo');
  });
  it('handles incomplete output and refusal without accepting partial data', async () => {
    provider.mockResolvedValueOnce(Response.json({ status: 'incomplete', output: [] }));
    expect((await evidenceHandler(request('summary-evidence', { sources: [source] }))).status).toBe(502);
    provider.mockResolvedValueOnce(Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No' }] }] }));
    expect((await evidenceHandler(request('summary-evidence', { sources: [source] }))).status).toBe(422);
  });
  it('does not expose upstream messages or key material on provider failure', async () => {
    provider.mockResolvedValueOnce(Response.json({ error: { message: 'private text test-language-key' } }, { status: 400 }));
    const response = await evidenceHandler(request('summary-evidence', { sources: [source] }));
    expect(response.status).toBe(502); expect(await response.text()).not.toMatch(/private text|test-language-key/);
  });
  it('rejects unsupported content and oversized requests before contacting a provider', async () => {
    expect((await evidenceHandler(request('summary-evidence', { sources: [source] }, { 'Content-Type': 'application/json-other' }))).status).toBe(415);
    expect((await composeHandler(request('summary-compose', {}, { 'Content-Length': '2000001' }))).status).toBe(413);
    expect(provider).not.toHaveBeenCalled();
  });
  it('validates the independent OCR page endpoint before contacting the OCR service', async () => {
    const pdf = await PDFDocument.create(); pdf.addPage([600, 800]); pdf.addPage([600, 800]);
    const bytes = await pdf.save();
    const response = await ocrHandler(new Request('https://lume.test/api/summary-ocr', { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: new Uint8Array(bytes).buffer }));
    expect(response.status).toBe(400); expect(provider).not.toHaveBeenCalled();
  });
});
