import { context, trace } from '@opentelemetry/api'
import type {
  Attributes,
  Span,
  Tracer,
  TracerProvider,
} from '@opentelemetry/api'
import {
  BatchingTraceSink,
  type BatchingTraceSinkOptions,
  type ExportResult,
  type SpanEndRecord,
  type SpanEventRecord,
  type SpanStartRecord,
  type TraceLink,
  type TraceExporter,
  type TraceRecord,
  type TraceSink,
} from '@open-multi-agent/core'
import {
  baseAttributes,
  mapLink,
  mapOmaAttributes,
  mapSpanKind,
  mapStatus,
  spanAttributes,
} from './mapping.js'

export type OTelDiagnosticCode =
  | 'span_start_failed'
  | 'duplicate_span_start'
  | 'orphan_event'
  | 'duplicate_span_end'
  | 'incomplete_span'
  | 'span_end_failed'
  | 'force_flush_failed'
  | 'force_flush_timeout'
  | 'shutdown_skipped'
  | 'shutdown_failed'
  | 'shutdown_timeout'

export interface OTelDiagnostic {
  readonly code: OTelDiagnosticCode
  readonly message: string
}

export interface OTelTracerProvider extends TracerProvider {
  forceFlush?(): Promise<void>
  shutdown?(): Promise<void>
}

export interface OTelTraceExporterOptions {
  /** Use an application-owned tracer directly. It is never globally registered or shut down. */
  readonly tracer?: Tracer
  /**
   * Use an application-owned provider to create the adapter tracer. Its
   * forceFlush is delegated when available; shutdown remains opt-in.
   */
  readonly tracerProvider?: OTelTracerProvider
  readonly instrumentationName?: string
  readonly instrumentationVersion?: string
  /** Optional low-sensitivity metadata, added only when callers provide it. */
  readonly metadata?: OTelMetadata
  /**
   * Reserved for a separately reviewed future capture policy. This release only
   * accepts the disabled value and never exports content-bearing fields.
   */
  readonly contentCapture?: OTelContentCaptureExtension
  /** Opt in to calling shutdown on the supplied provider. Defaults to false. */
  readonly shutdownOnShutdown?: boolean
  /** Receives payload-free adapter diagnostics. */
  readonly onDiagnostic?: (diagnostic: OTelDiagnostic) => void
}

export interface OTelMetadata {
  readonly environment?: string
  readonly release?: string
  readonly tenantId?: string
  readonly requestId?: string
}

export interface OTelContentCaptureExtension {
  readonly mode?: 'disabled'
}

export interface OTelTraceSinkOptions extends OTelTraceExporterOptions {
  readonly batching?: BatchingTraceSinkOptions
}

interface SpanEntry {
  readonly span: Span
  readonly startUnixMs: number
  readonly linkKeys: Set<string>
  ended: boolean
}

function spanKey(traceId: string, spanId: string): string {
  return `${traceId}/${spanId}`
}

function linkKey(link: TraceLink): string {
  return `${link.traceId}/${link.spanId}/${link.relation}`
}

function lifecycleResult(status: 'success' | 'failure', code?: string): ExportResult {
  return { status, exported: 0, ...(code ? { code } : {}) }
}

/**
 * Adapts OMA TraceRecord v2 to an application-owned OpenTelemetry tracer.
 * It deliberately does not configure or replace OpenTelemetry's global provider.
 */
export class OTelTraceExporter implements TraceExporter {
  private readonly tracer: Tracer
  private readonly provider?: OTelTracerProvider
  private readonly spans = new Map<string, SpanEntry>()
  private readonly shutdownOnShutdown: boolean
  private readonly metadata: Attributes

  constructor(private readonly options: OTelTraceExporterOptions) {
    if ((options.tracer === undefined) === (options.tracerProvider === undefined)) {
      throw new TypeError('Provide exactly one of tracer or tracerProvider; global OpenTelemetry state is never used.')
    }
    if (options.contentCapture?.mode !== undefined && options.contentCapture.mode !== 'disabled') {
      throw new TypeError('Content capture is not implemented by @open-multi-agent/otel.')
    }
    this.provider = options.tracerProvider
    this.tracer = options.tracer ?? options.tracerProvider!.getTracer(
      options.instrumentationName ?? '@open-multi-agent/otel',
      options.instrumentationVersion ?? '1.10.0',
    )
    this.shutdownOnShutdown = options.shutdownOnShutdown ?? false
    this.metadata = {
      ...(options.metadata?.environment ? {
        'oma.environment': options.metadata.environment,
        'deployment.environment.name': options.metadata.environment,
      } : {}),
      ...(options.metadata?.release ? {
        'oma.release': options.metadata.release,
        'service.version': options.metadata.release,
      } : {}),
      ...(options.metadata?.tenantId ? { 'oma.tenant.id': options.metadata.tenantId } : {}),
      ...(options.metadata?.requestId ? { 'oma.request.id': options.metadata.requestId } : {}),
    }
  }

  export(records: readonly TraceRecord[], _signal: AbortSignal): Promise<ExportResult> {
    let exported = 0
    for (const record of records) {
      try {
        this.accept(record)
        exported++
      } catch {
        this.diagnostic('span_start_failed', 'The OpenTelemetry tracer rejected an OMA trace record.')
        return Promise.resolve({ status: 'failure', exported, code: 'OTEL_RECORD_REJECTED' })
      }
    }
    return Promise.resolve({ status: 'success', exported })
  }

  async forceFlush(signal: AbortSignal): Promise<ExportResult> {
    if (!this.provider?.forceFlush) return lifecycleResult('success')
    return this.delegateLifecycle(this.provider.forceFlush.bind(this.provider), signal, 'force_flush')
  }

  async shutdown(signal: AbortSignal): Promise<ExportResult> {
    if (!this.shutdownOnShutdown || !this.provider?.shutdown) {
      this.diagnostic('shutdown_skipped', 'Provider shutdown was skipped because the adapter does not own the provider.')
      return lifecycleResult('success')
    }
    return this.delegateLifecycle(this.provider.shutdown.bind(this.provider), signal, 'shutdown')
  }

  private accept(record: TraceRecord): void {
    if (record.recordType === 'span_start') {
      this.start(record)
      return
    }
    if (record.recordType === 'span_event') {
      this.event(record)
      return
    }
    this.end(record)
  }

  private start(record: SpanStartRecord): void {
    const key = spanKey(record.traceId, record.spanId)
    if (this.spans.has(key)) {
      this.diagnostic('duplicate_span_start', 'Duplicate OMA span_start record ignored.')
      return
    }
    this.spans.set(key, {
      span: this.createSpan(record),
      startUnixMs: record.startUnixMs,
      linkKeys: new Set(record.links?.map(linkKey)),
      ended: false,
    })
  }

  private event(record: SpanEventRecord): void {
    const entry = this.spans.get(spanKey(record.traceId, record.spanId))
    if (!entry || entry.ended) {
      this.diagnostic('orphan_event', 'OMA span_event arrived without an open OTel span and was ignored.')
      return
    }
    const attributes: Attributes = {
      ...baseAttributes(record),
      ...this.metadata,
      ...this.safeEventAttributes(record),
      'oma.event.name': record.name,
    }
    entry.span.addEvent(`oma.${record.name}`, attributes, record.timestampUnixMs)
    if (record.name === 'first_chunk') {
      const ttftSeconds = Math.max(0, record.timestampUnixMs - entry.startUnixMs) / 1_000
      entry.span.setAttribute('gen_ai.response.time_to_first_chunk', ttftSeconds)
      entry.span.setAttribute('oma.ttft.ms', ttftSeconds * 1_000)
    }
  }

  private end(record: SpanEndRecord): void {
    const key = spanKey(record.traceId, record.spanId)
    let entry = this.spans.get(key)
    if (entry?.ended) {
      this.diagnostic('duplicate_span_end', 'Duplicate OMA span_end record ignored.')
      return
    }
    if (!entry) {
      this.diagnostic('incomplete_span', 'OMA span_end arrived without span_start; a synthetic OTel span was created.')
      const span = this.createSpan(record, true)
      entry = {
        span,
        startUnixMs: record.startUnixMs,
        linkKeys: new Set(record.links?.map(linkKey)),
        ended: false,
      }
      this.spans.set(key, entry)
    }
    try {
      entry.span.setAttributes({
        ...spanAttributes(record),
        ...this.metadata,
        'oma.status': record.status.code,
      })
      this.addEndLinks(entry, record.links)
      entry.span.setStatus(mapStatus(record.status))
      if (record.error) {
        const errorAttributes: Attributes = {
          'error.type': record.error.code ?? record.error.kind,
          'oma.error.kind': record.error.kind,
          ...(record.error.code ? { 'oma.error.code': record.error.code } : {}),
          ...(record.error.name ? { 'oma.error.name': record.error.name } : {}),
          ...(record.error.retryable !== undefined ? { 'oma.error.retryable': record.error.retryable } : {}),
          ...(record.error.httpStatus !== undefined ? { 'oma.error.http_status': record.error.httpStatus } : {}),
          ...(record.error.provider ? { 'oma.error.provider': record.error.provider } : {}),
          ...(record.error.attempt !== undefined ? { 'oma.error.attempt': record.error.attempt } : {}),
        }
        entry.span.setAttributes(errorAttributes)
        entry.span.addEvent('exception', errorAttributes, record.endUnixMs)
      }
      entry.span.end(record.endUnixMs)
      entry.ended = true
    } catch {
      this.diagnostic('span_end_failed', 'The OpenTelemetry tracer rejected an OMA span_end record.')
      throw new Error('OTEL_SPAN_END_FAILED')
    }
  }

  private createSpan(record: SpanStartRecord | SpanEndRecord, incomplete = false): Span {
    const parent = record.parentSpanId
      ? this.spans.get(spanKey(record.traceId, record.parentSpanId))
      : undefined
    const parentContext = parent ? trace.setSpan(context.active(), parent.span) : undefined
    const attributes: Attributes = {
      ...spanAttributes(record),
      ...this.metadata,
      ...(incomplete ? { 'oma.record.incomplete': true } : {}),
    }
    const span = this.tracer.startSpan(record.name, {
      kind: mapSpanKind(record.kind),
      attributes,
      links: record.links?.map(mapLink),
      startTime: record.startUnixMs,
    }, parentContext)
    return span
  }

  private safeEventAttributes(record: SpanEventRecord): Attributes {
    return mapOmaAttributes(record.attributes)
  }

  private addEndLinks(entry: SpanEntry, links: readonly TraceLink[] | undefined): void {
    for (const link of links ?? []) {
      const key = linkKey(link)
      if (entry.linkKeys.has(key)) continue
      entry.span.addLink(mapLink(link))
      entry.linkKeys.add(key)
    }
  }

  private async delegateLifecycle(
    action: () => Promise<void>,
    signal: AbortSignal,
    operation: 'force_flush' | 'shutdown',
  ): Promise<ExportResult> {
    if (signal.aborted) {
      this.diagnostic(`${operation}_timeout` as OTelDiagnosticCode, `OpenTelemetry ${operation} timed out.`)
      return lifecycleResult('failure', `OTEL_${operation.toUpperCase()}_TIMEOUT`)
    }
    const actionResult = Promise.resolve().then(action).then(
      () => ({ kind: 'success' as const }),
      () => ({ kind: 'failure' as const }),
    )
    let removeAbortListener: (() => void) | undefined
    const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
      const onAbort = () => resolve({ kind: 'timeout' })
      signal.addEventListener('abort', onAbort, { once: true })
      removeAbortListener = () => signal.removeEventListener('abort', onAbort)
    })
    const outcome = await Promise.race([actionResult, timeout])
    removeAbortListener?.()
    if (outcome.kind === 'success') return lifecycleResult('success')
    if (outcome.kind === 'timeout') {
      this.diagnostic(`${operation}_timeout` as OTelDiagnosticCode, `OpenTelemetry ${operation} timed out.`)
      return lifecycleResult('failure', `OTEL_${operation.toUpperCase()}_TIMEOUT`)
    }
    this.diagnostic(`${operation}_failed` as OTelDiagnosticCode, `OpenTelemetry ${operation} failed.`)
    return lifecycleResult('failure', `OTEL_${operation.toUpperCase()}_FAILED`)
  }

  private diagnostic(code: OTelDiagnosticCode, message: string): void {
    try {
      this.options.onDiagnostic?.({ code, message })
    } catch {
      // Diagnostics are best effort and must never alter OMA execution.
    }
  }
}

/** Build an OBS-2 TraceSink around the OTel adapter without adding OTel to core. */
export function createOtelTraceSink(options: OTelTraceSinkOptions): TraceSink {
  const { batching, ...exporterOptions } = options
  return new BatchingTraceSink(new OTelTraceExporter(exporterOptions), batching)
}

/** Convenience factory for callers that want to provide the adapter to their own BatchingTraceSink. */
export function createOtelTraceExporter(options: OTelTraceExporterOptions): OTelTraceExporter {
  return new OTelTraceExporter(options)
}
