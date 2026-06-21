import { createServer } from "node:http";
import {
  HttpApiBuilder,
  type HttpRouter,
  type HttpServer,
} from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { Config, Effect, Layer, Schedule } from "effect";
import { JSONCodec, type NatsConnection, connect } from "nats";
import { AccountRepo } from "./accounts.js";
import { WalletApi } from "./api.js";
import { BalanceRepo } from "./balance.js";
import { DbLive } from "./db.js";
import { AccountsHandlersLive } from "./handlers.js";
import { LedgerRepo } from "./ledger.js";
import {
  LEDGER_RECORDED_SUBJECT,
  OutboxRepo,
  type Publisher,
  type RecordedPayload,
  drainOutbox,
} from "./outbox.js";
import { TelemetryLive } from "./telemetry.js";

/**
 * The fully wired wallet HTTP application as a single `Layer`, minus the
 * transport. From the inside out:
 *
 *   AccountRepo/BalanceRepo.Default ← DbLive  (repos over a real PgClient)
 *   AccountsHandlersLive ← Account/BalanceRepo (endpoint implementations)
 *   HttpApiBuilder.api(WalletApi) ← group     (the served HttpApi)
 *   HttpApiBuilder.serve()                    (router → HttpApp, needs HttpServer)
 *
 * It deliberately leaves `HttpServer` unsatisfied so the caller chooses the
 * transport: `NodeHttpServer.layer(createServer, ...)` in production (see
 * {@link launch}) or `NodeHttpServer.layerTest` (ephemeral port + HttpClient)
 * in the integration test. Everything else — db config, repo, handlers — is
 * closed over here.
 *
 * `DbLive` can fail to build with `ConfigError | SqlError` (missing env / no
 * connection); those are unrecoverable startup defects rather than request
 * errors, so the repo layer is `orDie`'d, leaving `WalletApiLive`'s error
 * channel `never`.
 *
 * Importing this module has NO side effects; the server is started only by
 * `src/server.ts`, the dedicated runnable entrypoint.
 */
export const WalletApiLive: Layer.Layer<
  never,
  never,
  HttpServer.HttpServer | HttpRouter.HttpRouter.DefaultServices
> = HttpApiBuilder.serve().pipe(
  Layer.provide(HttpApiBuilder.api(WalletApi)),
  Layer.provide(AccountsHandlersLive),
  Layer.provide(AccountRepo.Default.pipe(Layer.provide(DbLive), Layer.orDie)),
  Layer.provide(BalanceRepo.Default.pipe(Layer.provide(DbLive), Layer.orDie)),
  Layer.provide(LedgerRepo.Default.pipe(Layer.provide(DbLive), Layer.orDie)),
);

/**
 * Service-local NATS connection, env-configured analogously to `DbLive`
 * (NATS_URL, default `nats://localhost:4222`). Opened as a scoped resource so
 * the connection is drained/closed on release. The wallet service was not a
 * NATS client before this feature (REQ-EVT default assumption) — this is the
 * new producer-side transport binding, kept here in the composition root next
 * to the other layer wiring.
 */
const NatsConnLive = Effect.acquireRelease(
  Effect.gen(function* () {
    const url = yield* Config.string("NATS_URL").pipe(
      Config.withDefault("nats://localhost:4222"),
    );
    return yield* Effect.promise(() => connect({ servers: url }));
  }),
  (conn: NatsConnection) => Effect.promise(() => conn.drain()),
);

const codec = JSONCodec<RecordedPayload>();

/**
 * A {@link Publisher} backed by core NATS: publish the JSON-encoded payload on
 * the subject, then `flush()` so the publish is confirmed received by the
 * server before the drain marks the row sent (REQ-EVT-03 at-least-once). A
 * connection/flush failure is a typed `Error` the drain isolates (the row stays
 * unsent for retry — REQ-EVT-05); it never reaches the request path
 * (REQ-EVT-09: no NATS on the request).
 */
const natsPublisher = (conn: NatsConnection): Publisher => ({
  publish: (subject, payload) =>
    Effect.tryPromise({
      try: async () => {
        conn.publish(subject, codec.encode(payload));
        await conn.flush();
      },
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
    }),
});

/**
 * Production launch effect: bind the app to a real Node HTTP server on the
 * configured `PORT` (default 3000), start the background Outbox→NATS drain loop
 * (REQ-EVT-03 at-least-once delivery), and run until interrupted.
 *
 * The drain loop is a SEPARATE concern from the request path: the request only
 * writes the entry + outbox row in one transaction (REQ-EVT-04/-09, no NATS on
 * the request); this loop repeatedly publishes the queued rows out-of-band and
 * retries unsent ones, so a broker outage never affects the HTTP request
 * (REQ-EVT-05). Single-instance, fixed-interval polling — worker topology /
 * multi-instance locking is explicitly out of scope.
 */
export const launch = Effect.gen(function* () {
  const port = yield* Config.integer("PORT").pipe(Config.withDefault(3000));
  // Announce the stable, documented producer subject at startup (REQ-EVT-10):
  // the fixed address the future consumer subscribes to.
  yield* Effect.logInfo(
    `wallet-service: publishing ledger events on subject "${LEDGER_RECORDED_SUBJECT}"`,
  );

  // The background drain: one pass per second over the pending outbox rows.
  const drainLoop = Effect.scoped(
    Effect.gen(function* () {
      const conn = yield* NatsConnLive;
      const publisher = natsPublisher(conn);
      yield* drainOutbox(publisher).pipe(
        Effect.provide(OutboxRepo.Default.pipe(Layer.provide(DbLive))),
        Effect.repeat(Schedule.spaced("1 seconds")),
      );
    }),
  );

  yield* Layer.launch(
    WalletApiLive.pipe(
      Layer.provide(NodeHttpServer.layer(createServer, { port })),
      Layer.provide(TelemetryLive),
      Layer.merge(Layer.scopedDiscard(Effect.forkScoped(drainLoop))),
    ),
  );
});
