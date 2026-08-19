import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

describe('shipped plugin bundles', () => {
  it('host stream is not the RELAY_UNBOUND stub', () => {
    const host = readFileSync(resolve(root, 'lib/index.js'), 'utf8')
    expect(host).not.toMatch('RELAY_UNBOUND')
    expect(host).toMatch('streamGrant')
  })

  it('client is a lazy-CJS ModuleLoader factory', () => {
    const client = readFileSync(resolve(root, 'lib/client.js'), 'utf8')
    expect(client).toMatch('window.__ModuleLoader__.load')
    expect(client).toMatch('sidebar.footer.action')
    expect(client).toMatch('shell.overlay')
    for (const view of ['privacy', 'lobby', 'room', 'table', 'result', 'grants', 'relay']) {
      expect(client).toMatch(view)
    }
  })
})
