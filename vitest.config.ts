import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/shared/**/*.test.ts', 'src/server/**/*.test.ts', 'src/web/app/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
  },
});
