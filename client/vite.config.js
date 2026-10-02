import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The SPA talks directly to the deployed `api` edge function (VITE_API_URL),
// so no dev proxy is needed — CORS is open on the function itself.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
  },
});
