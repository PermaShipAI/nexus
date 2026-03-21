import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['**/*_test.ts', '**/*.test.ts', '**/*.spec.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/**/*_test.ts',
        'src/tests/**',
        'src/db/migrations/**',
      ],
      thresholds: {
        statements: 20,
        branches: 15,
        functions: 20,
        lines: 20,
      },
    },
  },
});
