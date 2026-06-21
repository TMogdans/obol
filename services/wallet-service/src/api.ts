import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";

/**
 * Success body for the balance query: the account's id echoed back plus its
 * current balance (the signed sum of its ledger entries).
 */
const Balance = Schema.Struct({
  accountId: Schema.String,
  balance: Schema.Number,
});

/**
 * The account fields returned by `POST /accounts`. `currency` is part of the
 * stored account state (server-set to "EUR" for now) and echoed back so the
 * caller sees the full record it just created.
 */
const AccountFields = {
  id: Schema.String,
  ownerId: Schema.String,
  currency: Schema.String,
  createdAt: Schema.String,
};

/**
 * The two success outcomes of `POST /accounts`, kept as DISTINCT tagged types
 * so the same account body can map to two different HTTP statuses:
 *   - {@link AccountCreated} → 201, a new account was inserted (REQ-ACC-01)
 *   - {@link AccountExisted} → 200, the `Idempotency-Key` replayed an existing
 *     account, nothing was inserted (REQ-ACC-02)
 *
 * A plain `Account` struct returned twice would be ambiguous at encode time —
 * Effect could not tell which status to attach. The `_tag` discriminator makes
 * the choice deterministic, and doubles as a self-describing signal to the
 * caller ("created" vs "already existed").
 */
export class AccountCreated extends Schema.TaggedClass<AccountCreated>()(
  "AccountCreated",
  AccountFields,
) {}

export class AccountExisted extends Schema.TaggedClass<AccountExisted>()(
  "AccountExisted",
  AccountFields,
) {}

/**
 * Success body for `GET /accounts/:id` (account detail). Exactly the stored
 * account fields `{ id, ownerId, currency, createdAt }` — no embedded balance
 * (that is the separate `balance-query` surface). Defined LOCALLY here in
 * wallet-service (REQ-ACCD-07): the response type never leaves the service into
 * `packages/contracts`, so the change stays Tier T2.
 */
const AccountDetail = Schema.Struct(AccountFields);

/**
 * Request body for `POST /accounts`. `ownerId` must be a non-empty (trimmed)
 * string; an empty/whitespace value fails decoding and the framework returns a
 * structured 400 before the handler runs (REQ-ACC-04). `currency` is NOT part
 * of the request — it is server-set, see {@link AccountFields}.
 */
const CreateAccountPayload = Schema.Struct({
  ownerId: Schema.NonEmptyTrimmedString,
});

/**
 * Request body for `POST /accounts/:id/credit` (top-up). The surface is ONLY
 * `{ amount }` — `type` is NOT part of the request, it is server-set to
 * `'topup'` (REQ-TOP-06), analogous to the server-set `currency` on
 * {@link CreateAccountPayload}. A client that smuggles a `type` key sees it
 * dropped at decode time (Effect `Schema.Struct` discards excess properties),
 * never reaching the stored row.
 *
 * `amount` must be a POSITIVE INTEGER. `Schema.Int.pipe(Schema.positive())`
 * rejects `0`, negatives, and non-integers (e.g. `1.5`) at the decode rim, so
 * the framework returns a structured 400 BEFORE the handler runs and no
 * `ledger_entry` is ever written (REQ-TOP-02) — the same decode-rim guard the
 * non-empty `ownerId` uses on account creation (REQ-ACC-04).
 */
const CreditPayload = Schema.Struct({
  amount: Schema.Int.pipe(Schema.positive()),
});

/**
 * Required request headers for `POST /accounts`. The `Idempotency-Key` carries
 * the idempotency token (header names are normalised to lowercase by the
 * framework). A missing key fails header decoding → structured 400 (REQ-ACC-03).
 */
const CreateAccountHeaders = Schema.Struct({
  "idempotency-key": Schema.NonEmptyTrimmedString,
});

/**
 * Path parameters for the `/accounts/:id` family (`:id/balance` and the bare
 * `:id` detail read). The `id` segment is decoded into this struct and handed to
 * the handler as `path.id`. It is a plain `Schema.String` — `id` is an opaque
 * token, not format-checked (REQ-ACCD-08), so any punctuated value reaches the
 * handler and resolves to the domain 404 rather than a decode-time 400.
 */
const AccountIdPath = Schema.Struct({
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
const Health = Schema.Struct({
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
      HttpApiEndpoint.post("createAccount", "/accounts")
        .setPayload(CreateAccountPayload)
        .setHeaders(CreateAccountHeaders)
        .addSuccess(AccountCreated, { status: 201 })
        .addSuccess(AccountExisted, { status: 200 }),
    )
    .add(
      HttpApiEndpoint.get("balance", "/accounts/:id/balance")
        .setPath(AccountIdPath)
        .addSuccess(Balance)
        .addError(AccountNotFound, { status: 404 }),
    )
    .add(
      HttpApiEndpoint.get("getAccount", "/accounts/:id")
        .setPath(AccountIdPath)
        .addSuccess(AccountDetail)
        .addError(AccountNotFound, { status: 404 }),
    )
    .add(
      HttpApiEndpoint.post("credit", "/accounts/:id/credit")
        .setPath(AccountIdPath)
        .setPayload(CreditPayload)
        .addSuccess(Balance)
        .addError(AccountNotFound, { status: 404 }),
    )
    .add(HttpApiEndpoint.get("health", "/health").addSuccess(Health)),
) {}
