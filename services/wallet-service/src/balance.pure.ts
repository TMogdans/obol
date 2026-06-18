/**
 * A single ledger amount, the only field balance projection cares about.
 *
 * `amount` is a JS `number`. See the bigint boundary note on `BalanceRepo`: the
 * database column is `bigint`, but the projection deliberately works on `number`
 * because minor-unit credit amounts in this reference repo comfortably fit
 * inside `Number.MAX_SAFE_INTEGER`. The string→number coercion happens once, at
 * the SQL read boundary in the repo, so this pure function never sees a bigint
 * or a string.
 */
export interface BalanceEntry {
  readonly amount: number;
}

/**
 * Pure balance projection: fold a list of ledger amounts into a single balance.
 *
 * Deliberately total and side-effect-free — an empty ledger projects to `0`,
 * and signed amounts (negative `spend`, positive `topup`) simply sum. This is
 * the heart of the credit ledger and is tested in isolation, no database
 * required.
 *
 * This module is `*.pure.ts` by convention: pure, side-effect-free domain logic
 * that the Stryker mutation gate mutates IN FULL (see `stryker.config.json`).
 * Risk logic belongs here — out of the I/O-bound shell — so it can be
 * mutation-tested cheaply, without spinning up Testcontainers per mutant.
 */
export const projectBalance = (entries: ReadonlyArray<BalanceEntry>): number =>
  entries.reduce((sum, entry) => sum + entry.amount, 0);
