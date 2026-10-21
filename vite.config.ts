import { defineConfig, type ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import react from '@vitejs/plugin-react';
import netlify from '@netlify/vite-plugin';

const localReactRefreshCsp = {
  name: 'local-react-refresh-csp',
  apply: 'serve' as const,
  configureServer(server: ViteDevServer) {
    // Netlify's emulator also applies production headers. React Refresh uses
    // an inline preamble and a websocket in development only. The deployed
    // CSP remains the strict policy declared in netlify.toml.
    server.middlewares.use((_req: IncomingMessage, res: ServerResponse, next: () => void) => {
      const setHeader = res.setHeader.bind(res);
      res.setHeader = (name: string, value: number | string | readonly string[]) => setHeader(name, name.toLowerCase() === 'content-security-policy' && typeof value === 'string'
        ? value.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace("connect-src 'self'", "connect-src 'self' ws:") : value);
      next();
    });
  },
};

// `middleware` is enabled by default. Keeping it explicit also lets this
// configuration type-check if a transitive @netlify/dev type is not hoisted.
const netlifyOptions = { middleware: true, blobs: { enabled: false }, database: { enabled: false }, edgeFunctions: { enabled: false }, images: { enabled: false } };

export default defineConfig({
  server: { watch: { ignored: ['**/.netlify/**', '**/.pnpm-store/**'] } },
  plugins: [
    localReactRefreshCsp,
    react(),
    netlify(netlifyOptions),
  ],
});
