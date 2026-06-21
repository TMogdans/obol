import { HttpApiBuilder, HttpServerResponse } from "@effect/platform";
import { Effect } from "effect";
import { AccountRepo } from "./accounts.js";
import {
  AccountCreated,
  AccountExisted,
  AccountNotFound,
  WalletApi,
} from "./api.js";
import { BalanceRepo } from "./balance.js";

/**
 * Implements the `accounts` group of {@link WalletApi}.
 *
 * `createAccount` opens an account idempotently: it hands `ownerId` (already
 * validated non-empty by the payload schema) and the `Idempotency-Key` header to
 * {@link AccountRepo.open}, then maps the outcome to the matching status — a new
 * row to {@link AccountCreated} (201), a replayed one to {@link AccountExisted}
 * (200). Decoding already rejected a missing key / empty owner with a 400, so
 * the handler only sees well-formed input.
 *
 * `balance` is where the 200-vs-404 distinction lives: `BalanceRepo.balanceFor`
 * returns `0` both for an existing empty account and for an unknown one, so the
 * handler first asks `accountExists`. If the account is absent it fails with
 * {@link AccountNotFound} (mapped to HTTP 404 by the api definition); otherwise
 * it returns the projected balance — including a legitimate `0`.
 *
 * `health` is a static, unauthenticated liveness response (touches no state).
 *
 * The layer requires `AccountRepo` + `BalanceRepo` (left open for the
 * composition root to provide over `DbLive`); `SqlError` from a repo is treated
 * as an unexpected defect (not part of the endpoints' declared error channels),
 * which surfaces as a 500 rather than leaking as a typed client error.
 */
export const AccountsHandlersLive = HttpApiBuilder.group(
  WalletApi,
  "accounts",
  (handlers) =>
    Effect.gen(function* () {
      const accounts = yield* AccountRepo;
      const repo = yield* BalanceRepo;

      return handlers
        .handle("createAccount", ({ payload, headers }) =>
          Effect.gen(function* () {
            // SqlError is not a declared client error here: a DB fault is a
            // defect (→ 500), so orDie it. Validation (missing key / empty
            // owner) was already handled as a 400 at decode time.
            const result = yield* accounts
              .open(payload.ownerId, headers["idempotency-key"])
              .pipe(Effect.orDie);
            return result.created
              ? new AccountCreated(result.account)
              : new AccountExisted(result.account);
          }),
        )
        .handle("balance", ({ path }) =>
          Effect.gen(function* () {
            // `SqlError` is not part of this endpoint's declared error channel:
            // a DB fault is an unexpected defect (→ 500), not a typed client
            // error, so `orDie` it. The only typed failure is AccountNotFound.
            const exists = yield* repo
              .accountExists(path.id)
              .pipe(Effect.orDie);
            if (!exists) {
              return yield* new AccountNotFound({ accountId: path.id });
            }
            const balance = yield* repo.balanceFor(path.id).pipe(Effect.orDie);
            return { accountId: path.id, balance };
          }),
        )
        .handle("getAccount", ({ path }) =>
          Effect.gen(function* () {
            // PK lookup via `findById` (WHERE id = …). `SqlError` is NOT a
            // declared client error on this endpoint: a DB fault is an
            // unexpected defect (→ 500), never a typed client error. We send it
            // to the defect channel via `Effect.die`, carrying a 500
            // `HttpServerResponse` so the body is a structured JSON the
            // framework renders verbatim (its `_tag` is deliberately NOT
            // `AccountNotFound` — a DB fault must not masquerade as a missing
            // account). The only typed failure stays `AccountNotFound` (→ 404).
            const account = yield* accounts
              .findById(path.id)
              .pipe(
                Effect.catchAll(() =>
                  Effect.die(
                    HttpServerResponse.unsafeJson(
                      { _tag: "InternalServerError" },
                      { status: 500 },
                    ),
                  ),
                ),
              );
            if (account === undefined) {
              return yield* new AccountNotFound({ accountId: path.id });
            }
            return account;
          }),
        )
        .handle("health", () => Effect.succeed({ status: "ok" as const }));
    }),
);
