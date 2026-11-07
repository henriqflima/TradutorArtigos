import config from '../netlify/functions/config.js';
import ocr from '../netlify/functions/ocr.js';
import summaryCompose from '../netlify/functions/summary-compose.js';
import summaryConfig from '../netlify/functions/summary-config.js';
import summaryEvidence from '../netlify/functions/summary-evidence.js';
import summaryExplain from '../netlify/functions/summary-explain.js';
import summaryOcr from '../netlify/functions/summary-ocr.js';
import translatePlainText from '../netlify/functions/translate-plain-text.js';
import translateText from '../netlify/functions/translate-text.js';
import { json } from '../netlify/functions/_shared/http.js';

type Route = {
  method: 'GET' | 'POST';
  handle: (request: Request) => Promise<Response>;
};

const routes = new Map<string, Route>([
  ['/api/config', { method: 'GET', handle: config }],
  ['/api/ocr', { method: 'POST', handle: ocr }],
  ['/api/summary-compose', { method: 'POST', handle: summaryCompose }],
  ['/api/summary-config', { method: 'GET', handle: summaryConfig }],
  ['/api/summary-evidence', { method: 'POST', handle: summaryEvidence }],
  ['/api/summary-explain', { method: 'POST', handle: summaryExplain }],
  ['/api/summary-ocr', { method: 'POST', handle: summaryOcr }],
  ['/api/translate-plain-text', { method: 'POST', handle: translatePlainText }],
  ['/api/translate-text', { method: 'POST', handle: translateText }],
]);

export default {
  fetch(request: Request) {
    const url = new URL(request.url);
    const route = routes.get(url.pathname);
    if (!route) return json({ error: 'Rota não encontrada.' }, 404);
    if (request.method !== route.method) {
      const response = json({ error: 'Método não permitido.' }, 405);
      response.headers.set('Allow', route.method);
      return response;
    }

    // The Vercel proxy can pass an HTTP URL for a public HTTPS request.
    // Keep the public host and preserve the stream and cancellation signal.
    if (url.protocol === 'http:' && request.headers.get('x-forwarded-proto') === 'https') {
      url.protocol = 'https:';
      request = new Request(url, request);
    }
    return route.handle(request);
  },
};
