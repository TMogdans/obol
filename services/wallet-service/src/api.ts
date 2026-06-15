import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";

/**
 * Success body for the balance query: the account's id echoed back plus its
 * current balance (the signed sum of its ledger entries).
 */
export const Balance = Schema.Struct({
  accountId: Schema.String,
  balance: Schema.Number,
});

/**
 * Path parameters for `/accounts/:id/balance`. The `id` segment is decoded into
 * this struct and handed to the handler as `path.id`.
 */
export const BalancePath = Schema.Struct({
  id: Schema.String,
});

/**
 * Structured error returned when the requested account does not exist. As a
 * `Schema.TaggedError` it serialises to a JSON body carrying `_tag` and
 * `accountId`, and `addError(..., { status: 404 })` maps it to HTTP 404.
 *
 * This is the type that lets the handler distinguish "account exists, balance
 * happens to be 0" (200) from "no such account" (404).
 */
export class AccountNotFound extends Schema.TaggedError<AccountNotFound>()(
  "AccountNotFound",
  { accountId: Schema.String },
) {}

/**
 * Health/liveness response. A trivial `{ status: "ok" }` so a probe can assert
 * both the 200 and a stable body shape.
 */
export const Health = Schema.Struct({
  status: Schema.Literal("ok"),
});

/**
 * The wallet HTTP API surface for this phase: a single `accounts` group with
 * the balance query and a health endpoint. No write endpoints — top-up/spend
 * belong to a later phase.
 */
export class WalletApi extends HttpApi.make("wallet").add(
  HttpApiGroup.make("accounts")
    .add(
      HttpApiEndpoint.get("balance", "/accounts/:id/balance")
        .setPath(BalancePath)
        .addSuccess(Balance)
        .addError(AccountNotFound, { status: 404 }),
    )
    .add(HttpApiEndpoint.get("health", "/health").addSuccess(Health)),
) {}
