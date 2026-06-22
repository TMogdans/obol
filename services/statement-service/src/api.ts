import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";

/**
 * Health/liveness response. A trivial `{ status: "ok" }` so a probe can assert
 * both the 200 and a stable body shape. Mirrors wallet-service's `Health` so
 * the two services expose a consistent liveness contract.
 */
const Health = Schema.Struct({
  status: Schema.Literal("ok"),
});

/**
 * A single statement line in the `GET /accounts/{id}/statement` response: the
 * four `LedgerEntryRecorded` event fields verbatim (REQ-STMT-01/-03). `amount`
 * is the SIGNED minor-unit value exactly as projected (never reinterpreted),
 * `occurredAt` the ISO-8601 string. Defined LOCALLY here — the response type is
 * service-local and never leaks into `packages/contracts` (REQ-STMT-06).
 */
const StatementLine = Schema.Struct({
  entryId: Schema.String,
  accountId: Schema.String,
  amount: Schema.Int,
  occurredAt: Schema.String,
});

/**
 * The whole statement for an account: an array of lines, newest-first
 * (REQ-STMT-03). An account with no consumed events yields an EMPTY array with a
 * 200 — never a 404 (REQ-STMT-04).
 */
const Statement = Schema.Array(StatementLine);

/** Path parameter of `GET /accounts/:id/statement` — `id` is the `accountId`. */
const AccountIdPath = Schema.Struct({
  id: Schema.String,
});

/**
 * The statement HTTP API surface.
 *
 * - `statements` group: `GET /accounts/:id/statement` returns this account's
 *   projected statement lines, newest-first (REQ-STMT-03); an unknown/empty
 *   account is a successful empty list, not a 404 (REQ-STMT-04).
 * - `system` group: the existing health endpoint is preserved (skeleton).
 *
 * statement-service projects account statements from ledger events consumed off
 * NATS (the consumer/projection path). Note there are NO imports from
 * `@obol/wallet-service`: the services are isolated and communicate only via
 * `@obol/contracts` + events, never direct imports (REQ-STMT-06).
 */
export class StatementApi extends HttpApi.make("statement")
  .add(
    HttpApiGroup.make("statements").add(
      HttpApiEndpoint.get("statement", "/accounts/:id/statement")
        .setPath(AccountIdPath)
        .addSuccess(Statement),
    ),
  )
  .add(
    HttpApiGroup.make("system").add(
      HttpApiEndpoint.get("health", "/health").addSuccess(Health),
    ),
  ) {}
