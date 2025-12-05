import { rmSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

rmSync('coverage', { recursive: true, force: true });

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['html', 'text', 'lcov'],
      exclude: ['dist', 'node_modules', '**/*.d.ts']
    },
    logHeapUsage: true
  }
});
