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
        'packages/server/src/settlement.ts',
        'packages/server/src/relay.ts',
        'packages/server/src/store.ts',
        'packages/server/src/presence.ts',
        'packages/server/src/hash.ts',
        'packages/server/src/config.ts',
        'packages/plugin/src/host/grant-relay.ts',
        'packages/plugin/src/host/parse-decision.ts',
        'packages/plugin/src/host/user-message.ts',
        'packages/plugin/src/host/agent-runner.ts',
        'packages/plugin/src/host/compat.ts',
        'packages/plugin/src/host/llm-adapter.ts',
      ],
      exclude: ['**/*.spec.ts', '**/client/**', '**/*.d.ts', '**/types.ts'],
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 90,
        lines: 90,
      },
    },
  },
})
