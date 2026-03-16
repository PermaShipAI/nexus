import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['**/*_test.ts', '**/*.test.ts', '**/*.spec.ts'],
  },
});
