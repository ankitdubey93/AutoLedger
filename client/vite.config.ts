import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Tailwind v4 is a Vite plugin, not a PostCSS step. There is no
  // tailwind.config.js — v4 is configured from CSS (`@theme` in index.css).
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Fail instead of silently moving to 5174 — the server's CORS origin is
    // pinned to 5173, so a shifted port breaks requests in a confusing way.
    strictPort: true,
  },
});
