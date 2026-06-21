import { createServer } from "node:http";
import {
  HttpApiBuilder,
  type HttpRouter,
  type HttpServer,
} from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { Config, Effect, Layer } from "effect";
import { AccountRepo } from "./accounts.js";
import { WalletApi } from "./api.js";
import { BalanceRepo } from "./balance.js";
import { DbLive } from "./db.js";
import { AccountsHandlersLive } from "./handlers.js";
import { LedgerRepo } from "./ledger.js";
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
 * Production launch effect: bind the app to a real Node HTTP server on the
 * configured `PORT` (default 3000) and run it until interrupted.
 */
export const launch = Effect.gen(function* () {
  const port = yield* Config.integer("PORT").pipe(Config.withDefault(3000));
  yield* Layer.launch(
    WalletApiLive.pipe(
      Layer.provide(NodeHttpServer.layer(createServer, { port })),
      Layer.provide(TelemetryLive),
    ),
  );
});
