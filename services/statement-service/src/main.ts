import { createServer } from "node:http";
import {
  HttpApiBuilder,
  type HttpRouter,
  type HttpServer,
} from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { Config, Effect, Layer } from "effect";
import { StatementApi } from "./api.js";

/**
 * Implements the `system` group of {@link StatementApi}: a single static
 * liveness response. Kept inline (rather than a separate `handlers.ts`) because
 * the skeleton has exactly one trivial handler; wallet-service splits handlers
 * out only because it has real, repo-backed logic.
 */
const SystemHandlersLive = HttpApiBuilder.group(
  StatementApi,
  "system",
  (handlers) =>
    handlers.handle("health", () => Effect.succeed({ status: "ok" as const })),
);

/**
 * The fully wired statement HTTP application as a single `Layer`, minus the
 * transport — mirroring `WalletApiLive`:
 *
 *   SystemHandlersLive                       (endpoint implementations)
 *   HttpApiBuilder.api(StatementApi) ← group (the served HttpApi)
 *   HttpApiBuilder.serve()                   (router → HttpApp, needs HttpServer)
 *
 * It deliberately leaves `HttpServer` unsatisfied so the caller chooses the
 * transport: `NodeHttpServer.layer(createServer, ...)` in production (see
 * {@link launch}) or `NodeHttpServer.layerTest` in the integration test.
 *
 * Unlike wallet-service there is no DB layer — statement-service has no
 * persistence yet — so the error channel is trivially `never`.
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
  Layer.provide(SystemHandlersLive),
);

/**
 * Production launch effect: bind the app to a real Node HTTP server on the
 * configured `PORT` (default 3001, so it does not collide with wallet-service's
 * default 3000) and run it until interrupted.
 */
export const launch = Effect.gen(function* () {
  const port = yield* Config.integer("PORT").pipe(Config.withDefault(3001));
  yield* Layer.launch(
    StatementApiLive.pipe(
      Layer.provide(NodeHttpServer.layer(createServer, { port })),
    ),
  );
});
