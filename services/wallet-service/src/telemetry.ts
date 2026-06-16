import { Layer, Logger, Tracer } from "effect";

/**
 * Telemetry as an ARTIFACT.
 *
 * In this framework, observability is "the asynchronous verification that
 * replaces synchronous review": instead of a human reading every line at merge
 * time, the running system continuously emits structured signals (logs, spans,
 * metrics) that let us verify behaviour after the fact, in production, against
 * real traffic. This module is the seam where those signals are produced.
 *
 * Two layers are exported, both COMPOSABLE and SIDE-EFFECT-FREE — importing
 * this module starts nothing and connects to nothing. They are wired into a
 * runnable only at an explicit composition root, never as an import side
 * effect, so tests and `src/main.ts` stay collector-free.
 */

/**
 * Structured (JSON) logging layer.
 *
 * This is the REAL, cheap half of telemetry: Effect's built-in `Logger.json`
 * renders every `Effect.log*` call — together with `Effect.annotateLogs`
 * annotations and `Effect.withLogSpan` timing spans — as a single JSON line.
 * That is exactly the shape a log aggregator (Loki, CloudWatch, etc.) ingests,
 * so structured logs become queryable asynchronous verification with zero
 * extra dependencies (it lives in core `effect`).
 *
 * `Logger.json` REPLACES the default pretty logger rather than adding to it, so
 * provide it once at the composition root.
 */
const LoggerLive: Layer.Layer<never> = Logger.json;

/**
 * A no-op `Tracer` whose spans are inert: `span()` returns a `Tracer.Span` that
 * accepts attributes/events/links and an end time but exports nothing.
 *
 * It is a fully-typed stand-in for a real exporter. Effect's tracing API
 * (`Effect.withSpan`, automatic `@effect/sql` query spans, etc.) records
 * against whatever `Tracer` is in context; this one satisfies that contract
 * so traced code runs identically in dev and test without a collector.
 */
const noopTracer: Tracer.Tracer = Tracer.make({
  span: (name, parent, context, links, startTime, kind) => {
    const span: Tracer.Span = {
      _tag: "Span",
      spanId: "00000000-0000-0000-0000-000000000000",
      traceId: "00000000000000000000000000000000",
      name,
      sampled: false,
      parent,
      context,
      links,
      kind,
      status: { _tag: "Started", startTime },
      attributes: new Map<string, unknown>(),
      attribute: () => {},
      event: () => {},
      addLinks: () => {},
      end: () => {},
    };
    return span;
  },
  context: (f) => f(),
});

/**
 * OpenTelemetry tracing layer — a DOCUMENTED TYPED STUB.
 *
 * It sets a no-op `Tracer` as the current tracer (`Layer.setTracer`). This is
 * deliberately an artifact, not a live exporter: there is NO collector, NO
 * network egress, and NO `@effect/opentelemetry` dependency. We chose the
 * lighter option on purpose — pulling in `@effect/opentelemetry` plus the
 * `@opentelemetry/sdk-trace-*` packages would add several dependencies that no
 * code path actually exercises yet, which the repo's `knip`/dependency gate
 * (Task 9) would (correctly) flag as unused.
 *
 * What this stub buys us today: traced code (`Effect.withSpan`, `@effect/sql`'s
 * automatic query spans) is type-correct and runnable everywhere, and the
 * single wiring point for real tracing is named and documented. Promoting it
 * to live OTLP export later is a one-layer swap:
 *
 *   1. add `@effect/opentelemetry` + an OTLP span exporter,
 *   2. replace `Layer.setTracer(noopTracer)` with
 *      `NodeSdk.layer(() => ({ resource: ..., spanProcessor: ... }))`.
 *
 * Nothing else in the service changes — that is the value of treating
 * telemetry as a swappable layer rather than ambient global state.
 */
const TracingLive: Layer.Layer<never> = Layer.setTracer(noopTracer);

/**
 * The full telemetry stack: structured logs + the (stubbed) tracing layer,
 * merged into one provideable `Layer`. Provide this at a runnable's
 * composition root to make every log line JSON and every span tracer-backed.
 * It requires nothing (`RIn = never`) and is safe to import anywhere.
 */
export const TelemetryLive: Layer.Layer<never> = Layer.mergeAll(
  LoggerLive,
  TracingLive,
);
