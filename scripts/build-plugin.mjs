import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '../packages/plugin')
const outdir = join(root, 'lib')
mkdirSync(outdir, { recursive: true })

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
  banner: { js: '// agent-colosseum host bundle' },
})

await build({
  absWorkingDir: root,
  entryPoints: [join(root, 'src/client/index.ts')],
  outfile: join(outdir, 'client.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/*'],
})

writeFileSync(join(outdir, 'index.d.ts'), 'export const name: string\nexport const inject: string[]\nexport function apply(ctx: unknown, config: unknown): void\n')
writeFileSync(join(outdir, 'client.d.ts'), 'export const name: string\nexport const inject: string[]\nexport function apply(ctx: unknown): void\n')
console.log('built agent-colosseum host + client')
