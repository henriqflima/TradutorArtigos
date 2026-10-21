import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Browser fixtures use no provider calls or Netlify credentials.
export default defineConfig({ plugins: [react()], server: { host: '127.0.0.1', port: 5174 } });
