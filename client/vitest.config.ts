import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Separate from vite.config.ts so the dev server config and the test config do
 * not have to compromise on each other.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    // jsdom supplies document/window for the component tests. The
    // fetchWithAutoRefresh tests are pure logic and would run without it.
    environment: 'jsdom',
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    css: false,
  },
  define: {
    // The client reads import.meta.env.VITE_API_BASE_URL at module scope, and
    // under test there is no .env loading step. Pinning it keeps the asserted
    // request URLs stable.
    'import.meta.env.VITE_API_BASE_URL': JSON.stringify('http://localhost:5000'),
  },
});
