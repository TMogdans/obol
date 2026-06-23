import * as fc from "fast-check";
import { assertInvariants } from "./invariants.js";
import type { WalletModel } from "./model.js";
import { defaultOracle } from "./oracle.js";
import type { System } from "./spi.js";

/**
 * The fast-check commands (Phase-1 design §5). Each command translates itself
 * into a plain {@link System} call, applies the SAME step to the reference
 * model, asks the {@link defaultOracle} whether the two agree, and then runs the
 * per-step invariant cross-check ({@link assertInvariants}). The commands never
 * read production internals — only the boundary outcomes.
 *
 * Generators deliberately span the WHOLE input space, valid AND invalid:
 *   - owners include empty / whitespace → 400 parity (REQ-ACC-04)
 *   - amounts include 0, negative, and a non-integer → 400 parity
 *     (REQ-TOP-02 / REQ-SPD-03)
 *   - account selectors range PAST the opened set → 404 parity
 *     (REQ-TOP-03 / REQ-SPD-04 / REQ-BAL-02)
 *   - idempotency keys are drawn from a small set → replays actually happen, so
 *     I6 (same key → same account) is exercised (REQ-ACC-02)
 *
 * The strength over a hand-written test: the expected outcome is COMPUTED by the
 * model, not written by hand, so an unforeseen interleaving still has a correct
 * oracle.
 */

/** The mutable real-side reference threaded through a sequence. */
export interface RealRef {
  readonly system: System;
  /** real server-generated account id per creation-order slot (aligned to model.order). */
  readonly slots: string[];
  /** idempotency key → first real account id, to verify replays (I6). */
  readonly keyToId: Map<string, string>;
}

/**
 * Resolve a generated selector to a (logical, real) account pair. A selector
 * past the opened set resolves to a synthetic id the server cannot hold, so the
 * step exercises the 404 path; the model sees `undefined` and predicts 404 too.
 */
function resolve(
  model: WalletModel,
  real: RealRef,
  sel: number,
): { readonly logicalId: string | undefined; readonly realId: string } {
  if (sel < model.accountCount) {
    const logicalId = model.order[sel];
    const realId = real.slots[sel];
    if (logicalId !== undefined && realId !== undefined) {
      return { logicalId, realId };
    }
  }
  return { logicalId: undefined, realId: `acc_missing_${sel}` };
}

class OpenCommand implements fc.AsyncCommand<WalletModel, RealRef> {
  constructor(
    private readonly ownerId: string,
    private readonly key: string,
  ) {}

  check(): boolean {
    return true;
  }

  async run(model: WalletModel, real: RealRef): Promise<void> {
    const expected = model.open(this.ownerId, this.key);
    const actual = await real.system.execute({
      kind: "open",
      ownerId: this.ownerId,
      key: this.key,
    });
    defaultOracle.compare(expected, actual, this.toString());

    if (expected.status === 201 && actual.accountId !== undefined) {
      // New account: align the real id to the slot the model just created.
      real.slots.push(actual.accountId);
      real.keyToId.set(this.key, actual.accountId);
    } else if (expected.status === 200) {
      // I6: an idempotent replay must return the SAME real account as the first
      // open under this key — never a second account.
      const firstId = real.keyToId.get(this.key);
      if (actual.accountId !== firstId) {
        throw new Error(
          `[REQ-ACC-02] I6 divergence: key ${this.key} replayed to ` +
            `${actual.accountId}, expected the original ${firstId}`,
        );
      }
    }

    if (expected.logicalId !== undefined) {
      const idx = model.order.indexOf(expected.logicalId);
      const realId = real.slots[idx];
      if (realId !== undefined) {
        await assertInvariants(real.system, model, expected.logicalId, realId);
      }
    }
  }

  toString(): string {
    return `open(owner=${JSON.stringify(this.ownerId)}, key=${this.key})`;
  }
}

class TopUpCommand implements fc.AsyncCommand<WalletModel, RealRef> {
  constructor(
    private readonly sel: number,
    private readonly amount: number,
  ) {}

  check(): boolean {
    return true;
  }

  async run(model: WalletModel, real: RealRef): Promise<void> {
    const { logicalId, realId } = resolve(model, real, this.sel);
    const expected = model.topup(logicalId, this.amount);
    const actual = await real.system.execute({
      kind: "topup",
      accountId: realId,
      amount: this.amount,
    });
    defaultOracle.compare(expected, actual, this.toString());
    if (logicalId !== undefined) {
      await assertInvariants(real.system, model, logicalId, realId);
    }
  }

  toString(): string {
    return `topup(acc#${this.sel}, amount=${this.amount})`;
  }
}

class SpendCommand implements fc.AsyncCommand<WalletModel, RealRef> {
  constructor(
    private readonly sel: number,
    /**
     * A fixed amount, or `"all"` — spend EXACTLY the current balance. The
     * `"all"` mode is resolved at run time from the model's balance so the
     * sequence deterministically hits the `amount == balance` equality boundary
     * (REQ-SPD-02: equality is allowed, result 0). Random amounts hit that
     * measure-zero boundary essentially never — exactly the gap a `<`-instead-of
     * `-<=` guard hides behind, so the generator MUST aim at it on purpose.
     */
    private readonly amount: number | "all",
  ) {}

  check(): boolean {
    return true;
  }

  async run(model: WalletModel, real: RealRef): Promise<void> {
    const { logicalId, realId } = resolve(model, real, this.sel);
    const amount =
      this.amount === "all"
        ? logicalId !== undefined
          ? model.balance(logicalId)
          : 0
        : this.amount;
    const expected = model.spend(logicalId, amount);
    const actual = await real.system.execute({
      kind: "spend",
      accountId: realId,
      amount,
    });
    defaultOracle.compare(expected, actual, this.toString(amount));
    // The post-step check runs even after a REJECTED spend (409) — that is the
    // step no example test asserts, where a cached balance would drift (I4).
    if (logicalId !== undefined) {
      await assertInvariants(real.system, model, logicalId, realId);
    }
  }

  toString(resolved?: number): string {
    const shown =
      this.amount === "all"
        ? `all${resolved !== undefined ? `=${resolved}` : ""}`
        : `${this.amount}`;
    return `spend(acc#${this.sel}, amount=${shown})`;
  }
}

class QueryBalanceCommand implements fc.AsyncCommand<WalletModel, RealRef> {
  constructor(private readonly sel: number) {}

  check(): boolean {
    return true;
  }

  async run(model: WalletModel, real: RealRef): Promise<void> {
    const { logicalId, realId } = resolve(model, real, this.sel);
    const expected = model.balanceOf(logicalId);
    const actual = await real.system.execute({
      kind: "query",
      accountId: realId,
    });
    defaultOracle.compare(expected, actual, this.toString());
    if (logicalId !== undefined) {
      await assertInvariants(real.system, model, logicalId, realId);
    }
  }

  toString(): string {
    return `query(acc#${this.sel})`;
  }
}

/** A valid owner, plus empty/whitespace owners that must 400 (REQ-ACC-04). */
const ownerArb = fc.oneof(
  { arbitrary: fc.constantFrom("owner-a", "owner-b", "owner-c"), weight: 6 },
  { arbitrary: fc.constantFrom("", " "), weight: 1 },
);

/** A small key set so idempotent replays actually collide (REQ-ACC-02 / I6). */
const keyArb = fc.constantFrom("k0", "k1", "k2", "k3");

/**
 * A positive integer amount (the valid case, weighted high), plus the three
 * invalid classes that must 400: zero, negative, non-integer
 * (REQ-TOP-02 / REQ-SPD-03). Bounded so long sequences stay exact in `number`.
 */
const amountArb = fc.oneof(
  { arbitrary: fc.integer({ min: 1, max: 1_000_000 }), weight: 6 },
  { arbitrary: fc.constant(0), weight: 1 },
  { arbitrary: fc.integer({ min: -1_000_000, max: -1 }), weight: 1 },
  { arbitrary: fc.constant(1.5), weight: 1 },
);

/**
 * Spend amount: the same numeric classes as a topup, PLUS `"all"` (spend the
 * full balance). `"all"` is what reliably probes the `amount == balance`
 * equality boundary (REQ-SPD-02) that random amounts never hit — the boundary a
 * `<`-instead-of-`<=` guard hides behind.
 */
const spendAmountArb = fc.oneof(
  { arbitrary: amountArb, weight: 6 },
  { arbitrary: fc.constant("all" as const), weight: 3 },
);

/**
 * Account selector: 0..4 over a pool of at most 4 opened accounts, so a selector
 * past the opened set lands on the 404 path (REQ-TOP-03 / REQ-SPD-04 / REQ-BAL-02)
 * while smaller ones exercise multiple coexisting accounts (isolation, I7).
 */
const selArb = fc.integer({ min: 0, max: 4 });

/** The command arbitrary for `fc.asyncModelRun` — the four money-core operations. */
export const walletCommands = fc.commands([
  fc.tuple(ownerArb, keyArb).map(([o, k]) => new OpenCommand(o, k)),
  fc.tuple(selArb, amountArb).map(([s, a]) => new TopUpCommand(s, a)),
  fc.tuple(selArb, spendAmountArb).map(([s, a]) => new SpendCommand(s, a)),
  selArb.map((s) => new QueryBalanceCommand(s)),
]);
