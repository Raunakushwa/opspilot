import { defineConfig } from 'vitest/config';

// Integration tests start real Postgres containers (requires Docker).
export default defineConfig({
  test: {
    include: ['src/**/*.int.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // One container per file; run files serially to keep CI memory predictable.
    fileParallelism: false,
  },
});
