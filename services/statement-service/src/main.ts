import { createServer } from "node:http";
import {
  HttpApiBuilder,
  type HttpRouter,
  type HttpServer,
} from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { Config, Effect, Layer } from "effect";
import { JSONCodec, type NatsConnection, connect } from "nats";
import { StatementApi } from "./api.js";
import { LEDGER_RECORDED_SUBJECT, handleMessage } from "./consumer.js";
import { DbLive, MigratorLive } from "./db.js";
import { StatementRepo } from "./projection.js";

/**
 * Implements the `system` group of {@link StatementApi}: a single static
 * liveness response (the preserved skeleton health endpoint).
 */
const SystemHandlersLive = HttpApiBuilder.group(
  StatementApi,
  "system",
  (handlers) =>
    handlers.handle("health", () => Effect.succeed({ status: "ok" as const })),
);

/**
 * Implements the `statements` group of {@link StatementApi}.
 *
 * `statement` serves `GET /accounts/{id}/statement`: it reads the queried
 * account's projected lines via {@link StatementRepo.statementFor} — this
 * account ONLY, newest-first with a deterministic tie-break (REQ-STMT-03). An
 * account with no consumed events yields an EMPTY array with a 200, never a 404
 * (REQ-STMT-04): the read simply returns no rows, and there is no existence
 * check that could turn "empty" into "not found".
 *
 * `SqlError` from the repo is not a declared client error here: a DB fault is an
 * unexpected defect (→ 500), so it is `orDie`'d, keeping the endpoint's error
 * channel empty.
 */
const StatementsHandlersLive = HttpApiBuilder.group(
  StatementApi,
  "statements",
  (handlers) =>
    Effect.gen(function* () {
      const repo = yield* StatementRepo;
      return handlers.handle("statement", ({ path }) =>
        repo.statementFor(path.id).pipe(Effect.orDie),
      );
    }),
);

/**
 * The fully wired statement HTTP application as a single `Layer`, minus the
 * transport — mirroring `WalletApiLive`:
 *
 *   StatementRepo.Default ← DbLive          (repo over a real PgClient)
 *   Statements/SystemHandlersLive            (endpoint implementations)
 *   HttpApiBuilder.api(StatementApi) ← group (the served HttpApi)
 *   HttpApiBuilder.serve()                   (router → HttpApp, needs HttpServer)
 *
 * It deliberately leaves `HttpServer` unsatisfied so the caller chooses the
 * transport: `NodeHttpServer.layer(createServer, ...)` in production (see
 * {@link launch}) or `NodeHttpServer.layerTest` in the integration test.
 *
 * `DbLive` can fail to build with `ConfigError | SqlError` (missing env / no
 * connection); those are unrecoverable startup defects rather than request
 * errors, so the repo layer is `orDie`'d, leaving the error channel `never`.
 *
 * Importing this module has NO side effects; the server is started only by
 * `src/server.ts`, the dedicated runnable entrypoint.
 */
export const StatementApiLive: Layer.Layer<
  never,
  never,
  HttpServer.HttpServer | HttpRouter.HttpRouter.DefaultServices
> = HttpApiBuilder.serve().pipe(
  Layer.provide(HttpApiBuilder.api(StatementApi)),
  Layer.provide(StatementsHandlersLive),
  Layer.provide(SystemHandlersLive),
  Layer.provide(StatementRepo.Default.pipe(Layer.provide(DbLive), Layer.orDie)),
);

/**
 * Service-local NATS connection, env-configured analogously to the wallet-service
 * producer (NATS_URL, default `nats://localhost:4222`). Opened as a scoped
 * resource so it is drained/closed on release. statement-service was not a NATS
 * client before this feature — this is the new consumer-side transport binding,
 * kept here in the composition root next to the other layer wiring.
 */
const natsConnect = Effect.acquireRelease(
  Effect.gen(function* () {
    const url = yield* Config.string("NATS_URL").pipe(
      Config.withDefault("nats://localhost:4222"),
    );
    return yield* Effect.promise(() => connect({ servers: url }));
  }),
  (conn: NatsConnection) => Effect.promise(() => conn.drain()),
);

const codec = JSONCodec<unknown>();

/**
 * The running subscription loop: subscribe on the stable subject (REQ-STMT-08),
 * decode each message's JSON payload and project it via {@link handleMessage}.
 * Each message is handled independently (REQ-STMT-07: one poison message neither
 * blocks the subscription nor stops later valid messages); an undecodable
 * payload is funnelled through `handleMessage(null)`, hitting the same
 * swallow-and-continue path. Single-instance consume — queue-groups /
 * multi-instance concurrency are out of scope.
 */
const runConsumer = Effect.scoped(
  Effect.gen(function* () {
    const repo = yield* StatementRepo;
    const conn = yield* natsConnect;
    yield* Effect.logInfo(
      `statement-service: subscribing to ledger events on subject "${LEDGER_RECORDED_SUBJECT}"`,
    );
    const subscription = conn.subscribe(LEDGER_RECORDED_SUBJECT);
    yield* Effect.promise(async () => {
      for await (const msg of subscription) {
        let raw: unknown;
        try {
          raw = codec.decode(msg.data);
        } catch {
          raw = null;
        }
        await Effect.runPromise(
          handleMessage(raw).pipe(Effect.provideService(StatementRepo, repo)),
        );
      }
    });
  }),
);

/**
 * Production launch effect: apply the migration (REQ-STMT-05), bind the app to a
 * real Node HTTP server on the configured `PORT` (default 3001, so it does not
 * collide with wallet-service's default 3000), start the background NATS consumer
 * loop that projects ledger events into the statement view (REQ-STMT-01/-08), and
 * run until interrupted.
 *
 * The consumer loop is a SEPARATE concern from the HTTP read path: it subscribes
 * on the stable subject and idempotently appends one line per unique event;
 * `GET /accounts/{id}/statement` reads whatever the projection has persisted.
 */
export const launch = Effect.gen(function* () {
  const port = yield* Config.integer("PORT").pipe(Config.withDefault(3001));

  // Apply pending migrations (0001_statement_projection.sql) before serving so
  // the statement table exists on a fresh DB (REQ-STMT-05). Build-and-release:
  // building MigratorLive runs the migrations; we do not keep the layer alive.
  yield* Effect.scoped(Layer.build(MigratorLive)).pipe(Effect.orDie);

  const consumerLoop = runConsumer.pipe(
    Effect.provide(StatementRepo.Default.pipe(Layer.provide(DbLive))),
    Effect.orDie,
  );

  yield* Layer.launch(
    StatementApiLive.pipe(
      Layer.provide(NodeHttpServer.layer(createServer, { port })),
      Layer.merge(Layer.scopedDiscard(Effect.forkScoped(consumerLoop))),
    ),
  );
});
