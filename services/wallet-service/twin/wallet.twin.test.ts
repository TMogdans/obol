import * as fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WalletSystem } from "./adapter.js";
import { type RealRef, walletCommands } from "./commands.js";
import { WalletModel } from "./model.js";

/**
 * The Greenfield Twin (Phase-1 design; blog part 8).
 *
 * A fast-check *model-based* test that runs the REAL wallet-service (over
 * Testcontainers-Postgres, decision D1) against a trivial in-memory reference
 * model, comparing the boundary outcome AND an independent balance read after
 * EVERY step. It is an INDEPENDENT correctness oracle — derived from domain
 * truths, not from the EARS spec, not from the code — so it catches what the
 * other gates structurally cannot:
 *
 *   - example tests assert hand-picked points; the twin computes the expected
 *     result for thousands of generated sequences and shrinks a failure to its
 *     minimal trigger.
 *   - the mutation gate hardens the *tests of* `projectBalance`; the twin
 *     hardens the *behaviour* of the whole money path. Complementary, not a
 *     duplicate (design §8).
 *
 * Invariants enforced per step (design §3), each tagged with the REQ ids it
 * descends from so the trace gate maps them and a shrunk failure names the
 * broken truth:
 *
 *   I1 balance = Σ signed entries           REQ-TOP-04 / REQ-SPD-05 / REQ-BAL-01
 *   I2 balance never negative               REQ-SPD-02 / REQ-SPD-11
 *   I3 append-only, entry count monotonic   REQ-TOP-05 / REQ-SPD-06
 *   I4 rejected op ⇒ state unchanged        REQ-SPD-02 / REQ-SPD-03 / REQ-TOP-02
 *   I5 accepted op ⇒ ±amount, one entry     REQ-TOP-01 / REQ-SPD-01
 *   I6 open idempotent on key               REQ-ACC-02
 *   I7 account isolation                    REQ-ACC-01 / REQ-ACC-05
 *   I8 status disjointness at the rim       REQ-SPD-08 / REQ-TOP-07 (+ REQ-ACC-04 / REQ-TOP-03 / REQ-SPD-04 / REQ-BAL-02 / REQ-BAL-03)
 */

/** Number of random sequences per gate run; raise via TWIN_RUNS for a deep run. */
const NUM_RUNS = Number(process.env.TWIN_RUNS ?? 100);

const system = new WalletSystem();

beforeAll(async () => {
  await system.setup();
}, 180_000);

afterAll(async () => {
  await system.teardown();
});

describe("wallet twin — money-core model-based oracle (real service + Postgres)", () => {
  it("[REQ-ACC-01][REQ-ACC-02][REQ-ACC-04][REQ-ACC-05][REQ-TOP-01][REQ-TOP-02][REQ-TOP-03][REQ-TOP-04][REQ-TOP-05][REQ-TOP-07][REQ-SPD-01][REQ-SPD-02][REQ-SPD-03][REQ-SPD-04][REQ-SPD-05][REQ-SPD-06][REQ-SPD-08][REQ-SPD-11][REQ-BAL-01][REQ-BAL-02][REQ-BAL-03] the real wallet-service never diverges from the reference model over random money-core sequences (status class + balance compared after every step, incl. after a rejected op)", async () => {
    await fc.assert(
      fc.asyncProperty(walletCommands, async (cmds) => {
        // Each sequence starts from an empty ledger (design §4: reset per run).
        await system.reset();
        const setup = (): { model: WalletModel; real: RealRef } => ({
          model: new WalletModel(),
          real: { system, slots: [], keyToId: new Map() },
        });
        await fc.asyncModelRun(setup, cmds);
      }),
      { numRuns: NUM_RUNS },
    );
  }, 600_000);
});

/**
 * Invariant statements as REQ-tagged properties on the reference model itself
 * (design §9 DoD #3). These are the oracle's own axioms — checking the TWIN is
 * sound (a twin can have its own bug, Phase-0 §4) and documenting each invariant
 * as a first-class, named property. They are pure (no container) and fast.
 */
describe("wallet twin — invariants (model-derived, REQ-tagged)", () => {
  const openOne = (m: WalletModel, key = "k"): string => {
    const o = m.open("owner-a", key);
    if (o.logicalId === undefined) {
      throw new Error("open did not yield a logical id");
    }
    return o.logicalId;
  };

  it("[REQ-TOP-04][REQ-SPD-05][REQ-BAL-01] I1: balance equals the sum of the signed entries", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 1_000 })), (topups) => {
        const m = new WalletModel();
        const id = openOne(m);
        let sum = 0;
        for (const t of topups) {
          m.topup(id, t);
          sum += t;
        }
        expect(m.balanceOf(id)).toEqual({ status: 200, balance: sum });
      }),
    );
  });

  it("[REQ-SPD-02][REQ-SPD-11] I2: a valid topup/spend sequence never drives the balance negative", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.integer({ min: 1, max: 1_000 }).map((a) => ["t", a] as const),
            fc.integer({ min: 1, max: 1_000 }).map((a) => ["s", a] as const),
          ),
        ),
        (ops) => {
          const m = new WalletModel();
          const id = openOne(m);
          for (const [kind, amount] of ops) {
            if (kind === "t") {
              m.topup(id, amount);
            } else {
              m.spend(id, amount); // model rejects an uncovered spend itself
            }
            expect(m.balance(id)).toBeGreaterThanOrEqual(0);
          }
        },
      ),
    );
  });

  it("[REQ-TOP-05][REQ-SPD-06] I3: entry count is monotonic — a rejected op adds none", () => {
    const m = new WalletModel();
    const id = openOne(m);
    expect(m.entryCount(id)).toBe(0);
    expect(m.spend(id, 100).status).toBe(409); // uncovered: rejected
    expect(m.entryCount(id)).toBe(0); // nothing appended
    expect(m.topup(id, 0).status).toBe(400); // invalid: rejected
    expect(m.entryCount(id)).toBe(0);
    expect(m.topup(id, 100).status).toBe(200); // accepted
    expect(m.entryCount(id)).toBe(1);
  });

  it("[REQ-SPD-02][REQ-SPD-03][REQ-TOP-02] I4: a rejected op leaves the balance unchanged", () => {
    const m = new WalletModel();
    const id = openOne(m);
    m.topup(id, 1);
    expect(m.balance(id)).toBe(1);
    expect(m.spend(id, 2).status).toBe(409); // over budget → rejected
    expect(m.balance(id)).toBe(1); // unchanged — the cached-drift trap
    expect(m.spend(id, 0).status).toBe(400); // invalid → rejected
    expect(m.balance(id)).toBe(1);
  });

  it("[REQ-TOP-01][REQ-SPD-01] I5: an accepted op moves the balance by exactly ±amount and appends exactly one entry", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000 }),
        fc.integer({ min: 1, max: 1_000 }),
        (topup, spendRaw) => {
          const m = new WalletModel();
          const id = openOne(m);
          m.topup(id, topup);
          expect(m.balance(id)).toBe(topup);
          expect(m.entryCount(id)).toBe(1);
          const spend =
            (spendRaw % topup) + 1 > topup ? topup : (spendRaw % topup) + 1;
          const before = m.balance(id);
          const res = m.spend(id, spend);
          expect(res.status).toBe(200);
          expect(m.balance(id)).toBe(before - spend);
          expect(m.entryCount(id)).toBe(2);
        },
      ),
    );
  });

  it("[REQ-ACC-02] I6: opening twice with the same key returns the same account, no second one", () => {
    const m = new WalletModel();
    const first = m.open("owner-a", "k0");
    const second = m.open("owner-b", "k0"); // same key, different owner
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.logicalId).toBe(first.logicalId);
    expect(m.accountCount).toBe(1);
  });

  it("[REQ-ACC-01][REQ-ACC-05] I7: an op on one account never changes another's balance", () => {
    const m = new WalletModel();
    const a = openOne(m, "ka");
    const b = openOne(m, "kb");
    m.topup(a, 500);
    m.spend(a, 200);
    expect(m.balance(a)).toBe(300);
    expect(m.balance(b)).toBe(0); // untouched
  });

  it("[REQ-SPD-08][REQ-TOP-07][REQ-ACC-04][REQ-TOP-03][REQ-SPD-04][REQ-BAL-02][REQ-BAL-03] I8: every rim outcome is exactly one disjoint status class", () => {
    const m = new WalletModel();
    const allowed = new Set([200, 201, 400, 404, 409]);
    expect(m.open("", "k").status).toBe(400); // empty owner (REQ-ACC-04)
    expect(m.topup(undefined, 100).status).toBe(404); // missing (REQ-TOP-03)
    expect(m.spend(undefined, 100).status).toBe(404); // missing (REQ-SPD-04)
    expect(m.balanceOf(undefined).status).toBe(404); // missing (REQ-BAL-02)
    const id = openOne(m);
    expect(m.balanceOf(id)).toEqual({ status: 200, balance: 0 }); // empty (REQ-BAL-03)
    // A 400 (invalid amount) precedes a 404 (would-be missing) — decode rim first.
    expect(m.spend(undefined, 0).status).toBe(400);
    expect(allowed.has(m.spend(id, 100).status)).toBe(true);
  });
});
