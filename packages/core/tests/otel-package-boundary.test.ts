import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('optional OTel package boundary', () => {
  it('keeps the core import and runtime dependency set independent from OpenTelemetry', async () => {
    const packagePath = fileURLToPath(new URL('../package.json', import.meta.url))
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as { dependencies?: Record<string, string> }
    expect(Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith('@opentelemetry/'))).toEqual([])

    const core = await import('../src/index.js')
    expect(core.OpenMultiAgent).toBeTypeOf('function')
    expect(core.BatchingTraceSink).toBeTypeOf('function')
  })
})
