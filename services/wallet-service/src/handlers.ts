import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { AccountNotFound, WalletApi } from "./api.js";
import { BalanceRepo } from "./balance.js";

/**
 * Implements the `accounts` group of {@link WalletApi}.
 *
 * `balance` is where the 200-vs-404 distinction lives: `BalanceRepo.balanceFor`
 * returns `0` both for an existing empty account and for an unknown one, so the
 * handler first asks `accountExists`. If the account is absent it fails with
 * {@link AccountNotFound} (mapped to HTTP 404 by the api definition); otherwise
 * it returns the projected balance — including a legitimate `0`.
 *
 * `health` is a static liveness response.
 *
 * The layer requires `BalanceRepo` (left open for the composition root to
 * provide, e.g. `BalanceRepo.Default` over `DbLive`); `SqlError` from the repo
 * is treated as an unexpected defect (it is not part of the endpoint's declared
 * error channel), which surfaces as a 500 rather than leaking as a typed client
 * error.
 */
export const AccountsHandlersLive = HttpApiBuilder.group(
  WalletApi,
  "accounts",
  (handlers) =>
    Effect.gen(function* () {
      const repo = yield* BalanceRepo;

      return handlers
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
        .handle("health", () => Effect.succeed({ status: "ok" as const }));
    }),
);
