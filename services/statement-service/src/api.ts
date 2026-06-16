import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";

/**
 * Health/liveness response. A trivial `{ status: "ok" }` so a probe can assert
 * both the 200 and a stable body shape. Mirrors wallet-service's `Health` so
 * the two services expose a consistent liveness contract.
 */
export const Health = Schema.Struct({
  status: Schema.Literal("ok"),
});

/**
 * The statement HTTP API surface for this phase: a single `system` group with
 * only a health endpoint.
 *
 * statement-service is deliberately a SKELETON. Its real job — projecting
 * account statements from ledger events consumed off NATS — belongs to a later
 * phase. It exists now so the architecture gate (dependency-cruiser, Task 9)
 * has two services to enforce boundaries between, and so the monorepo's
 * service-to-service rules can be proven rather than asserted. Note there are
 * NO imports from `@obol/wallet-service` here: the services are isolated and
 * would communicate via `@obol/contracts` + events, never direct imports.
 */
export class StatementApi extends HttpApi.make("statement").add(
  HttpApiGroup.make("system").add(
    HttpApiEndpoint.get("health", "/health").addSuccess(Health),
  ),
) {}
