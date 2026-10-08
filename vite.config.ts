import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 1000 },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
