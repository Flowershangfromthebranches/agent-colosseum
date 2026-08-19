import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.spec.ts', 'packages/*/tests/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: [
        'packages/protocol/src/**/*.ts',
        'packages/crypto/src/**/*.ts',
        'packages/poker/src/**/*.ts',
        'packages/server/src/**/*.ts',
        'packages/plugin/src/**/*.ts',
      ],
      exclude: [
        '**/*.spec.ts',
        '**/client/**',
        'packages/server/src/main.ts',
      ],
    },
  },
})
