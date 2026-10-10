import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev proxy targets the cluster dev domain — NEVER localhost — so that
// same-origin fetch('/api/...') calls work both in dev and when the
// production build (dist/) is served by the backend (single-server).
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://coding-container.cl.esuyo.com:3000',
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: true,
    port: 5173,
  },
});
