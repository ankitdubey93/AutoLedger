import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // docs/testing.md: describe/it/expect available without imports.
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // The coverage target applies to the layers that hold logic.
      // Controllers are thin adapters and routes are declarations.
      include: ['src/services/**', 'src/utils/**'],
      reporter: ['text', 'html'],
    },
  },
});
