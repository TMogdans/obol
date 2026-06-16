import { HttpClient } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import { StatementApiLive } from "../src/main.js";

/**
 * Integration test for the statement-service `/health` endpoint against a REAL
 * HTTP server (`NodeHttpServer.layerTest`, which binds an ephemeral port and
 * exposes an `HttpClient` pointed at it).
 *
 * Mirrors wallet-service's HTTP test, minus the Postgres/Testcontainers wiring:
 * statement-service has no DB yet, so the skeleton needs nothing beyond the
 * server transport. Requests use the raw `HttpClient` (not the typed
 * `HttpApiClient`) so the assertion is on the actual HTTP status + body shape.
 */
it.effect("serves health over HTTP", () =>
  Effect.gen(function* () {
    const program = Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;

      const res = yield* client.get("/health");
      expect(res.status).toBe(200);
      const body = (yield* res.json) as { readonly status?: string };
      expect(body.status).toBe("ok");
    });

    const layer = StatementApiLive.pipe(
      Layer.provideMerge(NodeHttpServer.layerTest),
    );

    yield* Effect.provide(program, layer);
  }),
);
