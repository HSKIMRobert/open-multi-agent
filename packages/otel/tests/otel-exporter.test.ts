import { SpanStatusCode } from '@opentelemetry/api'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { describe, expect, it } from 'vitest'
import type { Tracer } from '@opentelemetry/api'
import type {
  SpanEndRecord,
  SpanEventRecord,
  SpanStartRecord,
  TraceAttributeValue,
  TraceLink,
} from '@open-multi-agent/core'
import {
  createOtelTraceExporter,
  OTelTraceExporter,
  type OTelTracerProvider,
} from '../src/index.js'

const TRACE_ID = 'a'.repeat(32)
const ROOT_SPAN_ID = '1'.repeat(16)

let nextRecord = 0

function start(
  spanId: string,
  name: string,
  kind: SpanStartRecord['kind'],
  options: {
    parentSpanId?: string
    attributes?: Readonly<Record<string, TraceAttributeValue>>
    links?: readonly TraceLink[]
    startUnixMs?: number
  } = {},
): SpanStartRecord {
  const startUnixMs = options.startUnixMs ?? 1_000
  return {
    schemaVersion: 2,
    recordId: `start-${++nextRecord}`,
    sequence: nextRecord,
    timestampUnixMs: startUnixMs,
    runId: 'run-42',
    attempt: 2,
    traceId: TRACE_ID,
    spanId,
    ...(options.parentSpanId ? { parentSpanId: options.parentSpanId } : {}),
    recordType: 'span_start',
    kind,
    name,
    startUnixMs,
    ...(options.links ? { links: options.links } : {}),
    attributes: options.attributes ?? {},
  }
}

function event(
  spanId: string,
  name: SpanEventRecord['name'],
  attributes: Readonly<Record<string, TraceAttributeValue>> = {},
  timestampUnixMs = 1_500,
): SpanEventRecord {
  return {
    schemaVersion: 2,
    recordId: `event-${++nextRecord}`,
    sequence: nextRecord,
    timestampUnixMs,
    runId: 'run-42',
    attempt: 2,
    traceId: TRACE_ID,
    spanId,
    recordType: 'span_event',
    name,
    attributes,
  }
}

function end(
  spanId: string,
  name: string,
  kind: SpanEndRecord['kind'],
  options: {
    parentSpanId?: string
    attributes?: Readonly<Record<string, TraceAttributeValue>>
    links?: readonly TraceLink[]
    status?: SpanEndRecord['status']
    error?: SpanEndRecord['error']
    startUnixMs?: number
    endUnixMs?: number
  } = {},
): SpanEndRecord {
  const startUnixMs = options.startUnixMs ?? 1_000
  const endUnixMs = options.endUnixMs ?? 2_000
  return {
    schemaVersion: 2,
    recordId: `end-${++nextRecord}`,
    sequence: nextRecord,
    timestampUnixMs: endUnixMs,
    runId: 'run-42',
    attempt: 2,
    traceId: TRACE_ID,
    spanId,
    ...(options.parentSpanId ? { parentSpanId: options.parentSpanId } : {}),
    recordType: 'span_end',
    kind,
    name,
    startUnixMs,
    endUnixMs,
    durationMs: endUnixMs - startUnixMs,
    status: options.status ?? { code: 'ok' },
    ...(options.error ? { error: options.error } : {}),
    ...(options.links ? { links: options.links } : {}),
    attributes: options.attributes ?? {},
  }
}

function inMemory() {
  const exporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })
  return { exporter, provider }
}

async function exportRecords(adapter: OTelTraceExporter, records: readonly (SpanStartRecord | SpanEventRecord | SpanEndRecord)[]) {
  const result = await adapter.export(records, new AbortController().signal)
  await adapter.forceFlush(new AbortController().signal)
  return result
}

describe('@open-multi-agent/otel', () => {
  it('requires an explicitly owned tracer or tracerProvider and never falls back to globals', () => {
    expect(() => createOtelTraceExporter({})).toThrow(/exactly one of tracer or tracerProvider/)
    const { provider } = inMemory()
    expect(() => createOtelTraceExporter({ tracer: provider.getTracer('test'), tracerProvider: provider })).toThrow(/exactly one/)
  })

  it('maps the full OMA hierarchy, links, event records, and OMA correlation attributes with the official in-memory exporter', async () => {
    const { exporter, provider } = inMemory()
    const adapter = createOtelTraceExporter({
      tracerProvider: provider,
      metadata: { environment: 'test', release: '2026.07', tenantId: 'tenant-opaque', requestId: 'request-opaque' },
    })
    const agentId = '2'.repeat(16)
    const llmId = '3'.repeat(16)
    const toolId = '4'.repeat(16)
    const taskId = '5'.repeat(16)
    const planId = '6'.repeat(16)
    const consensusId = '7'.repeat(16)
    const checkpointId = '8'.repeat(16)
    const callbackId = '9'.repeat(16)
    const links: readonly TraceLink[] = [
      { traceId: 'b'.repeat(32), spanId: 'b'.repeat(16), relation: 'depends_on' },
      { traceId: 'c'.repeat(32), spanId: 'c'.repeat(16), relation: 'delegated_from' },
      { traceId: 'd'.repeat(32), spanId: 'd'.repeat(16), relation: 'consumed' },
      { traceId: 'e'.repeat(32), spanId: 'e'.repeat(16), relation: 'continued_from' },
    ]

    const result = await exportRecords(adapter, [
      start(ROOT_SPAN_ID, 'oma.run', 'run'),
      start(planId, 'coordinator.decomposition', 'plan', { parentSpanId: ROOT_SPAN_ID }),
      start(taskId, 'oma.task', 'task', { parentSpanId: ROOT_SPAN_ID }),
      event(taskId, 'retry_scheduled', { 'oma.retry.attempt': 2, 'oma.retry.delay_ms': 25 }),
      event(taskId, 'stream_chunk', { 'oma.stream.type': 'text' }, 1_550),
      start(agentId, 'oma.agent', 'agent', { parentSpanId: taskId }),
      start(llmId, 'chat', 'llm', {
        parentSpanId: agentId,
        attributes: {
          'oma.llm.model': 'gpt-test',
          'oma.llm.provider': 'openai',
          'oma.usage.input_tokens': 21,
          'oma.usage.output_tokens': 34,
          'oma.usage.cache_read_input_tokens': 5,
          'oma.usage.cache_creation_input_tokens': 3,
          'oma.usage.reasoning_output_tokens': 8,
          'oma.cost.amount': 0.12,
          'oma.cost.currency': 'USD',
        },
      }),
      event(llmId, 'first_chunk', {}, 1_600),
      start(toolId, 'delegate_to_agent', 'tool', {
        parentSpanId: agentId,
        attributes: { 'oma.tool.name': 'delegate_to_agent', 'oma.tool.is_error': false },
      }),
      start(consensusId, 'consensus.judge', 'consensus', { parentSpanId: ROOT_SPAN_ID }),
      start(checkpointId, 'checkpoint.restore', 'checkpoint', { parentSpanId: ROOT_SPAN_ID }),
      start(callbackId, 'coordinator.synthesis', 'callback', { parentSpanId: ROOT_SPAN_ID }),
      end(toolId, 'delegate_to_agent', 'tool', { parentSpanId: agentId, attributes: { 'oma.tool.name': 'delegate_to_agent' } }),
      end(llmId, 'chat', 'llm', { parentSpanId: agentId, attributes: {
        'oma.llm.model': 'gpt-test',
        'oma.llm.provider': 'openai',
        'oma.usage.input_tokens': 21,
        'oma.usage.output_tokens': 34,
        'oma.usage.cache_read_input_tokens': 5,
        'oma.usage.cache_creation_input_tokens': 3,
        'oma.usage.reasoning_output_tokens': 8,
        'oma.cost.amount': 0.12,
        'oma.cost.currency': 'USD',
      } }),
      end(agentId, 'oma.agent', 'agent', { parentSpanId: taskId }),
      end(taskId, 'oma.task', 'task', { parentSpanId: ROOT_SPAN_ID, links }),
      end(planId, 'coordinator.decomposition', 'plan', { parentSpanId: ROOT_SPAN_ID }),
      end(consensusId, 'consensus.judge', 'consensus', { parentSpanId: ROOT_SPAN_ID }),
      end(checkpointId, 'checkpoint.restore', 'checkpoint', { parentSpanId: ROOT_SPAN_ID }),
      end(callbackId, 'coordinator.synthesis', 'callback', { parentSpanId: ROOT_SPAN_ID }),
      end(ROOT_SPAN_ID, 'oma.run', 'run'),
    ])

    expect(result).toEqual({ status: 'success', exported: 21 })
    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(9)
    const root = spans.find((span) => span.name === 'oma.run')!
    const agent = spans.find((span) => span.name === 'oma.agent')!
    const llm = spans.find((span) => span.name === 'chat')!
    const task = spans.find((span) => span.name === 'oma.task')!
    expect(agent.parentSpanContext?.spanId).toBe(task.spanContext().spanId)
    expect(llm.parentSpanContext?.spanId).toBe(agent.spanContext().spanId)
    expect(root.attributes).toMatchObject({
      'oma.schema.version': 2,
      'oma.run.id': 'run-42',
      'oma.run.attempt': 2,
      'oma.trace.id': TRACE_ID,
      'oma.span.id': ROOT_SPAN_ID,
      'oma.otel.mapping.version': '1.0.0',
      'oma.otel.gen_ai_semconv.version': '1.43.0-development',
      'deployment.environment.name': 'test',
      'service.version': '2026.07',
      'oma.tenant.id': 'tenant-opaque',
      'oma.request.id': 'request-opaque',
    })
    expect(task.links).toHaveLength(4)
    expect(task.links.map((link) => link.attributes['oma.link.relation']))
      .toEqual(['depends_on', 'delegated_from', 'consumed', 'continued_from'])
    expect(task.events.some((item) => item.name === 'oma.retry_scheduled')).toBe(true)
    expect(task.events.some((item) => item.name === 'oma.stream_chunk')).toBe(true)
    expect(llm.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'openai',
      'gen_ai.request.model': 'gpt-test',
      'gen_ai.usage.input_tokens': 21,
      'gen_ai.usage.output_tokens': 34,
      'gen_ai.usage.cache_read.input_tokens': 5,
      'gen_ai.usage.cache_creation.input_tokens': 3,
      'gen_ai.usage.reasoning.output_tokens': 8,
      'oma.cost.amount': 0.12,
      'oma.cost.currency': 'USD',
      'gen_ai.response.time_to_first_chunk': 0.6,
    })
    expect(llm.events.some((item) => item.name === 'oma.first_chunk')).toBe(true)
  })

  it('maps OMA error statuses without leaking error messages and keeps non-errors Unset', async () => {
    const { exporter, provider } = inMemory()
    const adapter = createOtelTraceExporter({ tracerProvider: provider })
    const errorId = 'f'.repeat(16)
    const skippedId = '0'.repeat(15) + '1'
    await exportRecords(adapter, [
      start(errorId, 'chat', 'llm'),
      end(errorId, 'chat', 'llm', {
        status: { code: 'timeout', message: 'provider said: secret prompt text' },
        error: { kind: 'timeout', code: 'LLM_TIMEOUT', message: 'secret prompt text', provider: 'openai' },
      }),
      start(skippedId, 'oma.task', 'task'),
      end(skippedId, 'oma.task', 'task', { status: { code: 'skipped' } }),
    ])
    const timeout = exporter.getFinishedSpans().find((span) => span.name === 'chat')!
    const skipped = exporter.getFinishedSpans().find((span) => span.name === 'oma.task')!
    expect(timeout.status.code).toBe(SpanStatusCode.ERROR)
    expect(timeout.attributes).toMatchObject({
      'oma.status': 'timeout',
      'error.type': 'LLM_TIMEOUT',
      'oma.error.provider': 'openai',
    })
    expect(JSON.stringify({ attributes: timeout.attributes, events: timeout.events })).not.toContain('secret prompt text')
    expect(skipped.status.code).toBe(SpanStatusCode.UNSET)
  })

  it('drops prompt, completion, tool payload, and reasoning content while preserving counted usage', async () => {
    const { exporter, provider } = inMemory()
    const adapter = createOtelTraceExporter({ tracerProvider: provider })
    const id = '2'.repeat(15) + 'a'
    await exportRecords(adapter, [
      start(id, 'chat', 'llm', { attributes: {
        'oma.prompt': 'private prompt',
        'oma.completion': 'private completion',
        'oma.tool.arguments': '{"credential":"do-not-export"}',
        'oma.tool.result': 'private result',
        'oma.reasoning.content': 'chain of thought',
        'oma.request.body': 'raw request body',
        'oma.raw': 'unclassified raw payload',
        'oma.usage.input_tokens': 9,
        'oma.usage.reasoning_output_tokens': 4,
      } }),
      end(id, 'chat', 'llm', { attributes: {
        'oma.prompt': 'private prompt',
        'oma.completion': 'private completion',
        'oma.tool.arguments': '{"credential":"do-not-export"}',
        'oma.tool.result': 'private result',
        'oma.reasoning.content': 'chain of thought',
        'oma.request.body': 'raw request body',
        'oma.raw': 'unclassified raw payload',
        'oma.usage.input_tokens': 9,
        'oma.usage.reasoning_output_tokens': 4,
      } }),
    ])
    const span = exporter.getFinishedSpans()[0]!
    expect(span.attributes).toMatchObject({
      'oma.usage.input_tokens': 9,
      'gen_ai.usage.input_tokens': 9,
      'gen_ai.usage.reasoning.output_tokens': 4,
    })
    expect(JSON.stringify(span.attributes)).not.toMatch(/private|credential|chain of thought|raw request|unclassified/)
  })

  it('reports duplicate, out-of-order, and incomplete records without throwing or exporting content', async () => {
    const { exporter, provider } = inMemory()
    const diagnostics: string[] = []
    const adapter = createOtelTraceExporter({ tracerProvider: provider, onDiagnostic: (item) => diagnostics.push(item.code) })
    const id = '3'.repeat(15) + 'b'
    const orphanId = '4'.repeat(15) + 'c'
    const ended = end(id, 'oma.task', 'task')
    const result = await exportRecords(adapter, [
      event(orphanId, 'stream_chunk', { 'oma.stream.type': 'text', 'oma.completion': 'not exported' }),
      ended,
      start(id, 'oma.task', 'task'),
      start(id, 'oma.task', 'task'),
      ended,
    ])
    expect(result).toEqual({ status: 'success', exported: 5 })
    expect(diagnostics).toEqual(expect.arrayContaining(['orphan_event', 'incomplete_span', 'duplicate_span_start', 'duplicate_span_end']))
    const span = exporter.getFinishedSpans().find((item) => item.name === 'oma.task')!
    expect(span.attributes['oma.record.incomplete']).toBe(true)
    expect(JSON.stringify({ attributes: span.attributes, events: span.events })).not.toContain('not exported')
  })

  it('maps local span rejection and provider flush/shutdown failures to OBS-2 ExportResult without taking provider ownership by default', async () => {
    const { provider } = inMemory()
    const diagnostics: string[] = []
    const throwingTracer = {
      ...provider.getTracer('test'),
      startSpan: () => { throw new Error('local OTel failure') },
    } as unknown as Tracer
    const rejected = createOtelTraceExporter({ tracer: throwingTracer })
    await expect(rejected.export([start('5'.repeat(16), 'oma.run', 'run')], new AbortController().signal))
      .resolves.toEqual({ status: 'failure', exported: 0, code: 'OTEL_RECORD_REJECTED' })

    let starts = 0
    const partiallyRejectingTracer = {
      ...provider.getTracer('test'),
      startSpan: (...args: Parameters<Tracer['startSpan']>) => {
        starts++
        if (starts === 2) throw new Error('second record rejected')
        return provider.getTracer('test').startSpan(...args)
      },
    } as unknown as Tracer
    const partial = createOtelTraceExporter({ tracer: partiallyRejectingTracer })
    await expect(partial.export([
      start('6'.repeat(16), 'oma.run', 'run'),
      start('7'.repeat(16), 'oma.task', 'task'),
    ], new AbortController().signal)).resolves.toEqual({
      status: 'failure', exported: 1, code: 'OTEL_RECORD_REJECTED',
    })

    let flushed = 0
    let shutdown = 0
    const lifecycleProvider: OTelTracerProvider = {
      getTracer: provider.getTracer.bind(provider),
      forceFlush: async () => { flushed++ },
      shutdown: async () => { shutdown++ },
    }
    const userOwned = createOtelTraceExporter({ tracerProvider: lifecycleProvider, onDiagnostic: (item) => diagnostics.push(item.code) })
    await expect(userOwned.forceFlush(new AbortController().signal)).resolves.toEqual({ status: 'success', exported: 0 })
    await expect(userOwned.shutdown(new AbortController().signal)).resolves.toEqual({ status: 'success', exported: 0 })
    expect(flushed).toBe(1)
    expect(shutdown).toBe(0)
    expect(diagnostics).toContain('shutdown_skipped')

    const owned = createOtelTraceExporter({ tracerProvider: lifecycleProvider, shutdownOnShutdown: true })
    await owned.shutdown(new AbortController().signal)
    expect(shutdown).toBe(1)

    const rejectingProvider: OTelTracerProvider = {
      getTracer: provider.getTracer.bind(provider),
      forceFlush: async () => { throw new Error('collector unreachable') },
    }
    const rejecting = createOtelTraceExporter({ tracerProvider: rejectingProvider })
    await expect(rejecting.forceFlush(new AbortController().signal)).resolves.toEqual({
      status: 'failure', exported: 0, code: 'OTEL_FORCE_FLUSH_FAILED',
    })

    const hangingProvider: OTelTracerProvider = {
      getTracer: provider.getTracer.bind(provider),
      forceFlush: async () => new Promise<void>(() => {}),
    }
    const hanging = createOtelTraceExporter({ tracerProvider: hangingProvider })
    const controller = new AbortController()
    controller.abort()
    await expect(hanging.forceFlush(controller.signal)).resolves.toEqual({
      status: 'failure', exported: 0, code: 'OTEL_FORCE_FLUSH_TIMEOUT',
    })
  })
})
