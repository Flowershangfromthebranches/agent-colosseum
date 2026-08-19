import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.spec.ts', 'packages/*/tests/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: [
        'packages/protocol/src/**/*.ts',
        'packages/crypto/src/**/*.ts',
        'packages/poker/src/**/*.ts',
        'packages/server/src/**/*.ts',
        'packages/plugin/src/**/*.ts',
      ],
      exclude: ['**/*.spec.ts', '**/client/**', 'packages/server/src/main.ts', 'packages/server/src/postgres.ts'],
      thresholds: {
        statements: 70,
        branches: 60,
        functions: 70,
        lines: 70,
      },
    },
  },
})
