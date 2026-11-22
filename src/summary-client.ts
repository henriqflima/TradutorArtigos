import { PDFDocument, PDFName, PDFNumber, degrees } from 'pdf-lib';
import { OCR_ENGINE, type OcrResult } from './ocr-contract';
import { pdfSourceOptions } from './pdf-options';
import {
  SUMMARY_VERSION, SUMMARY_MAX_FILE_BYTES, SUMMARY_MAX_PAGES, SUMMARY_SECTIONS, SUMMARY_LABELS,
  parseSummaryExtraction, parseSummarySection, parseSummaryComments, summaryQuality,
  type SummarySource, type SummarySession, type SummaryPage,
} from './summary-contract';

type Options = { code: string; signal: AbortSignal; onProgress: (message: string) => void; onUpdate: (session: SummarySession) => void };
const lastStarts = new Map<string, number>(); // Only this independent summary flow uses these slots.
const bytesToHash = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)), b => b.toString(16).padStart(2,'0')).join('');
const check = (signal: AbortSignal) => signal.throwIfAborted();
async function pause(ms: number, signal: AbortSignal) {
  check(signal);
  await new Promise<void>((resolve,reject) => {
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort',cancel); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort',cancel); resolve(); },Math.max(0,ms));
    signal.addEventListener('abort',cancel,{once:true});
  });
}
async function request(path: string, body: object | Uint8Array, options: Options): Promise<unknown> {
  await pause((lastStarts.get(path) || 0) + 2_100 - Date.now(),options.signal);
  check(options.signal); lastStarts.set(path,Date.now());
  const deadline = AbortSignal.timeout(60_000), signal = AbortSignal.any([options.signal,deadline]);
  let response: Response;
  try {
    response = await fetch(path, { method:'POST',cache:'no-store',signal,
      headers:{'Content-Type':body instanceof Uint8Array ? 'application/pdf' : 'application/json',...(options.code ? {'x-access-code':options.code} : {})},
      body:body instanceof Uint8Array ? new Uint8Array(body).buffer : JSON.stringify(body) });
  } catch {
    check(options.signal);
    throw new Error('Não foi possível confirmar o processamento desta etapa. Os dados concluídos continuam nesta sessão; retome quando desejar reenviar a etapa pendente.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`O servidor retornou uma resposta vazia (HTTP ${response.status}).`);
  const chunks: Uint8Array[] = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort',cancel,{once:true});
  let data: unknown;
  try {
    check(signal);
    while (true) {
      const part = await reader.read(); check(signal); if (part.done) break;
      size += part.value.length;
      if (size > 3_000_000) { void reader.cancel(); throw new Error('A resposta excedeu o tamanho permitido.'); }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset=0;
    for (const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.length; }
    data = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  } catch {
    check(options.signal);
    throw new Error(`Não foi possível validar a resposta desta etapa (HTTP ${response.status}). Retome para tentar novamente apenas o que ficou pendente.`);
  } finally { signal.removeEventListener('abort',cancel); reader.releaseLock(); }
  check(options.signal);
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : `Falha ao processar o resumo (HTTP ${response.status}).`;
    throw new Error(message);
  }
  return data;
}

/** Keep table cells, TeX, exponents, Unicode and decimal separators verbatim. */
export function sourcesFromOcr(result: OcrResult, page: number): SummarySource[] {
  const kinds: Record<string,SummarySource['kind']> = {text:'text',paragraph:'text',title:'heading',heading:'heading',caption:'caption',table:'table',image:'figure',figure:'figure',equation:'equation',reference:'reference',references:'reference'};
  return result.page.blocks.flatMap((block,index) => {
    const sources: SummarySource[] = [];
    for (let start=0,part=0; start < block.content.length || part===0; part++) {
      let end=Math.min(start+18_000,block.content.length);
      if (end < block.content.length && /[\uD800-\uDBFF]/.test(block.content[end-1])) end--;
      const text=block.content.slice(start,end);
      sources.push({id:`p${page}-s${index}-${part}`,page,kind:kinds[block.type] || 'other',text,originalText:text,confidence:block.confidence,
        rect:{x:block.x,y:block.y,width:block.width,height:block.height}});
      start=end; if (start===block.content.length) break;
    }
    return sources;
  });
}
export function batchSummarySources(sources: SummarySource[]): SummarySource[][] {
  const batches: SummarySource[][] = []; let batch:SummarySource[]=[],characters=0;
  for (const source of sources) {
    if (source.text.length > 20_000) throw new Error('Divida o trecho editado em blocos de até 20.000 caracteres.');
    if (batch.length && (characters+source.text.length > 24_000 || batch.length >= 100)) { batches.push(batch); batch=[]; characters=0; }
    batch.push(source); characters+=source.text.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
function parseOcr(value: unknown): OcrResult {
  const r=value as OcrResult;
  if (!r || r.model!==OCR_ENGINE || r.usage?.pages!==1 || !r.page || !Array.isArray(r.page.blocks) || r.page.blocks.length>5_000 ||
      ![r.page.width,r.page.height].every(n=>Number.isFinite(n)&&n>0&&n<=100_000) ||
      !r.page.blocks.every(b=>b && typeof b.type==='string' && typeof b.content==='string' && b.content.length<=250_000 &&
        !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(b.content) &&
        [b.x,b.y,b.width,b.height].every(Number.isFinite) && b.x>=0 && b.y>=0 && b.width>0 && b.height>0 && b.x+b.width<=r.page.width+.1 && b.y+b.height<=r.page.height+.1 &&
        (b.confidence===null || (Number.isFinite(b.confidence)&&b.confidence>=0&&b.confidence<=100)))) throw new Error('O OCR do resumo retornou uma estrutura inválida.');
  return r;
}
function pageWarnings(sources: SummarySource[]) {
  const warnings:string[]=[];
  if (!sources.some(s=>s.text.trim())) warnings.push('OCR sem texto utilizável; a leitura depende da imagem da página. Confira o original.');
  if (sources.some(s=>s.confidence!==null && s.confidence<65)) warnings.push('O OCR indicou baixa confiança em um ou mais trechos. Confira valores e símbolos.');
  return warnings;
}

async function normalizedPage(source: PDFDocument,index: number) {
  const original=source.getPage(index), media=original.getMediaBox(), crop=original.getCropBox();
  if (![media.x,media.y,media.width,media.height,crop.x,crop.y,crop.width,crop.height].every(Number.isFinite)) throw new Error('O PDF possui limites de página inválidos.');
  const left=Math.max(media.x,crop.x),bottom=Math.max(media.y,crop.y),right=Math.min(media.x+media.width,crop.x+crop.width),top=Math.min(media.y+media.height,crop.y+crop.height);
  const rotation=((original.getRotation().angle%360)+360)%360;
  if (![0,180].includes(rotation)) throw new Error('Gire as páginas com rotação de 90°/270° antes de extrair os dados.');
  const unitValue=original.node.lookup(PDFName.of('UserUnit'));
  const unit=unitValue instanceof PDFNumber && Number.isFinite(unitValue.asNumber()) && unitValue.asNumber()>0 ? unitValue.asNumber() : 1;
  const width=(right-left)*unit,height=(top-bottom)*unit;
  if (![width,height].every(n=>Number.isFinite(n)&&n>=100&&n<=3000)) throw new Error('O PDF possui dimensões de página não suportadas.');
  const output=await PDFDocument.create(),page=output.addPage([width,height]);
  if (original.node.Contents()) {
    const embedded=await output.embedPage(original,{left,bottom,right,top});
    page.drawPage(embedded,{x:rotation===180?width:0,y:rotation===180?height:0,xScale:unit,yScale:unit,rotate:degrees(rotation)});
  }
  return output.save({useObjectStreams:true});
}

/** Independent OCR, evidence batches and cache. No translation endpoints or state are used. */
export async function extractSummary(file: File, previous: SummarySession | null, options: Options): Promise<SummarySession> {
  check(options.signal);
  if (!/\.pdf$/i.test(file.name) || !file.size || file.size>SUMMARY_MAX_FILE_BYTES) throw new Error('Escolha um PDF de até 7 MB.');
  const bytes=new Uint8Array(await file.arrayBuffer()); check(options.signal);
  if (new TextDecoder('ascii').decode(bytes.subarray(0,5))!=='%PDF-') throw new Error('O arquivo não é um PDF válido.');
  let source:PDFDocument;
  try { source=await PDFDocument.load(bytes,{updateMetadata:false,throwOnInvalidObject:true}); } catch { throw new Error('O PDF está inválido ou protegido por senha.'); }
  const pageCount=source.getPageCount();
  if (pageCount<1 || pageCount>SUMMARY_MAX_PAGES) throw new Error('Escolha um PDF com até 50 páginas.');
  // Validate all geometry before the first paid request, including later pages.
  for (const page of source.getPages()) {
    const crop=page.getCropBox(),media=page.getMediaBox();
    if (![crop.x,crop.y,crop.width,crop.height,media.x,media.y,media.width,media.height].every(Number.isFinite) || crop.width<=0 || crop.height<=0 || media.width<=0 || media.height<=0 || page.getRotation().angle%180!==0) throw new Error('O PDF tem páginas inválidas ou giradas em 90°/270°. Corrija o documento antes de extrair.');
    const value=page.node.lookup(PDFName.of('UserUnit'));
    const unit=value instanceof PDFNumber && Number.isFinite(value.asNumber()) && value.asNumber()>0?value.asNumber():1;
    const width=(Math.min(media.x+media.width,crop.x+crop.width)-Math.max(media.x,crop.x))*unit;
    const height=(Math.min(media.y+media.height,crop.y+crop.height)-Math.max(media.y,crop.y))*unit;
    if (![width,height].every(n=>Number.isFinite(n)&&n>=100&&n<=3000)) throw new Error('O PDF possui dimensões visíveis de página não suportadas. Corrija antes de extrair.');
  }
  const sourceHash=await bytesToHash(bytes); check(options.signal);
  let session:SummarySession=previous?.sourceHash===sourceHash && previous.version===SUMMARY_VERSION ? {...previous,pages:[...previous.pages],sections:{...previous.sections},comments:[...previous.comments]} :
    {version:SUMMARY_VERSION,sourceHash,fileName:file.name,pageCount,pages:[],sections:{},comments:[]};
  const publish=()=>{ check(options.signal); options.onUpdate(session); };
  const replace=(page:SummaryPage)=>{session={...session,pages:[...session.pages.filter(p=>p.number!==page.number),page].sort((a,b)=>a.number-b.number),sections:{},comments:[],explanationDone:false};publish();};
  publish();
  const [{getDocument,GlobalWorkerOptions},worker]=await Promise.all([import('pdfjs-dist'),import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
  check(options.signal); GlobalWorkerOptions.workerSrc=worker.default;
  const loading=getDocument({data:new Uint8Array(bytes),...pdfSourceOptions()});
  const stopLoading=()=>{void loading.destroy().catch(()=>{});}; options.signal.addEventListener('abort',stopLoading,{once:true});
  try {
    const pdf=await loading.promise;
    for (let number=1;number<=pageCount;number++) {
      check(options.signal);
      let page=session.pages.find(p=>p.number===number);
      if (page?.status==='analyzed') continue;
      if (!page) {
        options.onProgress(`Extraindo a página ${number} de ${pageCount}…`);
        const view=await pdf.getPage(number),natural=view.getViewport({scale:1});
        const viewport=view.getViewport({scale:Math.min(2.5,Math.sqrt(7_000_000/(natural.width*natural.height)))});
        const canvas=document.createElement('canvas'); canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
        const context=canvas.getContext('2d',{alpha:false}); if (!context) throw new Error('Não foi possível preparar a imagem da página.');
        const render=view.render({canvas,canvasContext:context,viewport,background:'rgb(255,255,255)'});
        const cancel=()=>render.cancel(); options.signal.addEventListener('abort',cancel,{once:true});
        try { await render.promise; } finally { options.signal.removeEventListener('abort',cancel); }
        check(options.signal);
        let image=canvas.toDataURL('image/jpeg',.92);
        if (image.length>2_000_000) image=canvas.toDataURL('image/jpeg',.75);
        if (image.length>2_000_000) { const reduced=document.createElement('canvas'); const ratio=Math.sqrt(1_500_000/image.length);reduced.width=Math.floor(canvas.width*ratio);reduced.height=Math.floor(canvas.height*ratio);reduced.getContext('2d')!.drawImage(canvas,0,0,reduced.width,reduced.height);image=reduced.toDataURL('image/jpeg',.8); reduced.width=0;reduced.height=0; }
        if (image.length>2_000_000) throw new Error('A imagem desta página é muito densa para análise. Separe ou simplifique o PDF.');
        canvas.width=0;canvas.height=0;
        let transport=await normalizedPage(source,number-1); check(options.signal);
        if (transport.length>4_000_000) {
          const compact=await PDFDocument.create(),jpg=await compact.embedJpg(image);compact.addPage([natural.width,natural.height]).drawImage(jpg,{x:0,y:0,width:natural.width,height:natural.height});transport=await compact.save();
        }
        const ocr=parseOcr(await request('/api/summary-ocr',transport,options)); check(options.signal);
        const sources=sourcesFromOcr(ocr,number);
        if (!sources.length) sources.push({id:`p${number}-visual`,page:number,kind:'figure',text:'',originalText:'',confidence:null,rect:{x:0,y:0,width:ocr.page.width,height:ocr.page.height}});
        page={number,width:ocr.page.width,height:ocr.page.height,sources,evidence:[],concepts:[],warnings:pageWarnings(sources),status:'extracted',image,completedBatches:{}};
        replace(page);
      }
      const batches=batchSummarySources(page.sources);
      for (let index=0;index<batches.length;index++) {
        check(options.signal);
        const batch=batches[index];
        const key=await bytesToHash(new TextEncoder().encode(JSON.stringify({version:SUMMARY_VERSION,sources:batch})));
        if (page.completedBatches[key]) continue;
        options.onProgress(`Analisando evidências da página ${number} (${index+1}/${batches.length})…`);
        const extracted=parseSummaryExtraction(await request('/api/summary-evidence',{sources:batch,...(page.image?{image:page.image}:{})},options),batch); check(options.signal);
        extracted.evidence=extracted.evidence.map((e,i)=>({...e,id:`p${number}-b${index}-e${i}`}));
        page={...page,completedBatches:{...page.completedBatches,[key]:extracted}};
        replace(page);
      }
      const results=Object.values(page.completedBatches);
      page={...page,status:'analyzed',evidence:results.flatMap(r=>r.evidence),concepts:[...new Set(results.flatMap(r=>r.concepts))],
        warnings:[...new Set([...pageWarnings(page.sources),...results.flatMap(r=>r.warnings),...(results.every(r=>!r.evidence.length)?['Nenhuma evidência foi identificada. Confira se a página contém conteúdo relevante.']:[])])]};
      replace(page);
    }
    options.onProgress('Extração concluída. Confira as evidências antes de gerar o resumo.');
    return session;
  } finally { options.signal.removeEventListener('abort',stopLoading); await loading.destroy().catch(()=>{}); }
}

export function updateSummarySource(session:SummarySession,id:string,text:string):SummarySession {
  if (text.length>20_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new Error('O trecho editado deve ter até 20.000 caracteres e conter somente texto.');
  if (!session.pages.some(p=>p.sources.some(s=>s.id===id))) throw new Error('Trecho não encontrado.');
  return {...session,sections:{},comments:[],explanationDone:false,pages:session.pages.map(p=>p.sources.some(s=>s.id===id)?
    {...p,status:'extracted',evidence:[],concepts:[],completedBatches:{},warnings:pageWarnings(p.sources.map(s=>s.id===id?{...s,text}:s)),sources:p.sources.map(s=>s.id===id?{...s,text}:s)}:p)};
}
export async function composeSummary(input:SummarySession,options:Options & {language:string;web:boolean}):Promise<SummarySession> {
  check(options.signal);
  if (input.pages.length!==input.pageCount || summaryQuality(input).analyzedPages!==input.pageCount || input.pages.some(p=>p.status!=='analyzed')) throw new Error('Conclua a extração de todas as páginas antes de gerar o resumo.');
  let session={...input,sections:input.language===options.language?{...input.sections}:{},comments:input.language===options.language?[...input.comments]:[],explanationDone:input.language===options.language?input.explanationDone:false,language:options.language};
  const evidence=session.pages.flatMap(p=>p.evidence);
  if (!evidence.length) throw new Error('Não há evidências suficientes para gerar o resumo. Confira a extração.');
  for (const key of SUMMARY_SECTIONS) {
    if (session.sections[key]) continue;
    options.onProgress(`Escrevendo ${SUMMARY_LABELS[key].toLowerCase()}…`);
    const section=parseSummarySection(await request('/api/summary-compose',{section:key,evidence,language:options.language},options),key,evidence); check(options.signal);
    session={...session,sections:{...session.sections,[key]:section}}; options.onUpdate(session);
  }
  if (options.web && !session.explanationDone) {
    const concepts=[...new Set(session.pages.flatMap(p=>p.concepts))].slice(0,3);
    if (concepts.length) {
      options.onProgress('Preparando comentários explicativos com fontes…');
      const comments=parseSummaryComments(await request('/api/summary-explain',{concepts,language:options.language},options)); check(options.signal);
      session={...session,comments,explanationDone:true}; options.onUpdate(session);
    } else session={...session,explanationDone:true};
  }
  if (!options.web) session={...session,comments:[],explanationDone:false};
  check(options.signal); options.onUpdate(session); options.onProgress('Resumo gerado. As referências permitem conferir cada explicação no artigo.'); return session;
}
export function formatSummary(session:SummarySession) {
  const evidence=new Map(session.pages.flatMap(p=>p.evidence).map(e=>[e.id,e]));
  const sources=new Map(session.pages.flatMap(p=>p.sources).map(s=>[s.id,s]));
  const quality=summaryQuality(session);
  const lines=[`Resumo de ${session.fileName}`,quality.complete?'Todas as páginas analisadas.':'Resumo com pendências de extração.',...quality.issues,''];
  for (const key of SUMMARY_SECTIONS) {
    lines.push(SUMMARY_LABELS[key]);
    const section=session.sections[key];
    if (!section) { lines.push('Seção ainda não gerada.','');continue; }
    for (const p of section.paragraphs) {
      const pages=[...new Set(p.evidenceIds.flatMap(id=>evidence.get(id)?.sourceIds.map(s=>sources.get(s)?.page).filter((n):n is number=>n!==undefined)||[]))].sort((a,b)=>a-b);
      lines.push(`${p.text} [Páginas do PDF: ${pages.join(', ')}]`,'');
    }
    lines.push(...section.missing.map(m=>`Informação ausente ou incerta: ${m}`),'');
  }
  for (const comment of session.comments) lines.push(`Comentário explicativo — ${comment.concept}`,comment.explanation,...comment.sources.map(s=>`${s.title}: ${s.url}`),'');
  return lines.join('\n');
}
