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
      exclude: ['**/*.spec.ts', '**/*.d.ts', '**/types.ts'],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
        'packages/protocol/src/frames.ts': { branches: 100 },
        'packages/protocol/src/poker-action.ts': { branches: 100 },
        'packages/poker/src/engine.ts': { branches: 100 },
        'packages/server/src/settlement.ts': { branches: 100 },
        'packages/server/src/relay.ts': { branches: 100 },
        'packages/server/src/auth.ts': { branches: 100 },
      },
    },
  },
})
