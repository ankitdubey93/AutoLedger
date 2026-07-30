import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Fail instead of silently moving to 5174 — the server's CORS origin is
    // pinned to 5173, so a shifted port breaks requests in a confusing way.
    strictPort: true,
  },
});
