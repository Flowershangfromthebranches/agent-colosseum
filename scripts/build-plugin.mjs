import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '../packages/plugin')
const outdir = join(root, 'lib')
mkdirSync(outdir, { recursive: true })

const PLATFORM = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-runtime',
])

await build({
  absWorkingDir: root,
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(outdir, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  packages: 'bundle',
  external: ['@deepseek-ai/*'],
})

await build({
  absWorkingDir: root,
  entryPoints: [join(root, 'src/client/index.ts')],
  outfile: join(outdir, 'client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  jsx: 'automatic',
  external: [...PLATFORM],
  banner: { js: 'window.__ModuleLoader__.load({ id: "agent-colosseum", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: 'return module.exports; } });' },
  plugins: [{
    name: 'purity',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^@deepseek-ai\// }, (args) => {
        if (PLATFORM.has(args.path) || args.path.startsWith('@deepseek-ai/dsh-llm') || args.path.startsWith('@deepseek-ai/dsh-session')) {
          return { path: args.path, external: true }
        }
        return { path: args.path, external: false }
      })
    },
  }],
})

const client = readFileSync(join(outdir, 'client.js'), 'utf8')
if (!client.includes('window.__ModuleLoader__.load')) {
  throw new Error('client bundle missing lazy-CJS ModuleLoader handoff')
}
if (client.includes('@agent-colosseum/')) {
  throw new Error('client bundle must inline workspace packages')
}

writeFileSync(join(outdir, 'index.d.ts'), 'export const name: string\nexport const inject: string[]\nexport function apply(ctx: unknown, config: unknown): void\n')
writeFileSync(join(outdir, 'client.d.ts'), 'export const name: string\nexport const inject: string[]\nexport function apply(ctx: unknown): void\n')
console.log('built agent-colosseum host + lazy-CJS client')
