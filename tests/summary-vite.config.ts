import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// A bundled, provider-free UI fixture also works without Vite's dependency optimizer.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'tmp/summary-ui', rolldownOptions: { input: 'tests/summary-browser.html' } },
  preview: { host: '127.0.0.1', port: 5174, strictPort: true },
});
