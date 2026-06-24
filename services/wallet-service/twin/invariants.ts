import type { WalletModel } from "./model.js";
import type { System } from "./spi.js";

/**
 * The per-step invariant cross-check (Phase-1 design §3 + §4). After EVERY
 * command the harness re-reads the affected account through the REAL boundary
 * and asserts it still agrees with the reference model — "compare after every
 * step", the property that catches a divergence sitting at a step no example
 * test ever asserts (e.g. the balance AFTER a rejected spend).
 *
 * Each check carries its REQ ids in the thrown message so the minimal failing
 * sequence fast-check prints names which domain truth broke. The invariants
 * (design §3):
 *
 *   I1  balance = sum of the signed entries                 REQ-TOP-04 / REQ-SPD-05 / REQ-BAL-01
 *   I2  balance never negative over any valid sequence      REQ-SPD-02 / REQ-SPD-11
 *   I3  append-only: entry count monotonic, never mutated    REQ-TOP-05 / REQ-SPD-06
 *   I4  a rejected op leaves balance + entries unchanged     REQ-SPD-02 / REQ-SPD-03 / REQ-TOP-02
 *
 * I4 is not a separate read here: it falls out of running this check after a
 * rejected command — the independent balance must still equal the (unchanged)
 * model balance. That is exactly the cached-balance-drift trap.
 */
export async function assertInvariants(
  system: System,
  model: WalletModel,
  logicalId: string,
  realId: string,
): Promise<void> {
  const modelBalance = model.balance(logicalId);

  // I2 (model side): a balance reached by a valid sequence is never negative.
  if (modelBalance < 0) {
    throw new Error(
      `[REQ-SPD-02][REQ-SPD-11] I2: model balance ${modelBalance} < 0 for ${realId}`,
    );
  }

  // The independent boundary read (design §4c) — NOT the value the last command
  // returned, a fresh GET. This is what makes a stale/cached balance visible.
  const obs = await system.observeBalance(realId);
  if (obs.status !== 200) {
    throw new Error(
      `[REQ-BAL-01] I1: account ${realId} expected to exist (200), got ${obs.status}`,
    );
  }

  // I1 + I4: the independently-read balance equals the projected model balance.
  if (obs.balance !== modelBalance) {
    throw new Error(
      `[REQ-TOP-04][REQ-SPD-05][REQ-BAL-01][REQ-SPD-02] I1/I4 divergence for ${realId}: ` +
        `model balance=${modelBalance}, independent boundary read=${obs.balance}`,
    );
  }

  // I2 (system side): the boundary never serves a negative balance either.
  if (obs.balance < 0) {
    throw new Error(
      `[REQ-SPD-11] I2: boundary served negative balance ${obs.balance} for ${realId}`,
    );
  }

  // I3: append-only — the real ledger row count equals the model entry count
  // (monotonic, never mutated/deleted; a rejected op appends nothing).
  const count = await system.observeEntryCount(realId);
  if (count !== model.entryCount(logicalId)) {
    throw new Error(
      `[REQ-TOP-05][REQ-SPD-06] I3 divergence for ${realId}: ` +
        `real entry count=${count}, model entry count=${model.entryCount(logicalId)}`,
    );
  }
}
