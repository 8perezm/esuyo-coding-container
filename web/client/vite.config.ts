import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev proxy targets the local API (same `PORT` as .env, default 3401) so
// same-origin fetch('/api/...') calls work in dev. Override with
// VITE_API_TARGET when the API runs elsewhere.
const apiTarget = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3401';
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 3400,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  preview: {
    host: true,
    port: 3400,
  },
});
