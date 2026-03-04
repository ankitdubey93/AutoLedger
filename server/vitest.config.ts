import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['src/__tests__/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            include: ['src/services/**', 'src/utils/**', 'src/middleware/**'],
            thresholds: {
                lines: 80,
                functions: 80,
            },
        },
    },
});
