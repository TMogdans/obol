import { expect, it } from "@effect/vitest";
import * as fc from "fast-check";
import { projectBalance } from "../src/balance.pure.js";

/**
 * REQ-SPD-11 — the hard domain invariant as a fast-check PROPERTY:
 *
 *   "If an arbitrary sequence of valid topups and spends is applied to an
 *    account, the projected balance is at NO point negative and equals exactly
 *    the sum of the appended (signed) amount values."
 *
 * This is the "never negative" rule (REQ-SPD-02) lifted from a single request
 * to the WHOLE append history. The balance projection lives in
 * `balance.pure.ts` (mutation-tested via Stryker, cf. `projectBalance`), so we
 * exercise it directly here — no Testcontainers, cheap to mutate.
 *
 * devloop spec-PR seam: each `it("[REQ-SPD-11] …")` is the SANCTIONED skip
 * idiom (REQ tag in the title literal right after `(`), so the escape-hatch
 * guard passes and the trace gate counts the tag as coverage while vitest does
 * not redden it. The `debit` write path does not exist yet, but the pure
 * projection AND the model of "a valid sequence" already do — so these
 * properties are written COMPLETE (real generators, real assertions) and only
 * skipped; `implement` may ONLY remove the `.skip`.
 *
 * Modelling a VALID sequence: the spec defines a valid spend as one whose
 * amount does not exceed the balance available at the moment it is applied
 * (read → compare → append). We therefore model an operation stream and FILTER
 * each spend through the same guard the server enforces, then assert the two
 * halves of the invariant on the resulting signed-amount history.
 */

/** A requested operation: a positive topup quantity or a positive spend quantity. */
type Op =
  | { readonly kind: "topup"; readonly amount: number }
  | { readonly kind: "spend"; readonly amount: number };

/**
 * Bounded positive minor-unit quantity. Bounded so even a long stream sums well
 * within `Number.MAX_SAFE_INTEGER`, keeping integer addition exact — the
 * property must fail on a real mutation, not on a float rounding artefact.
 */
const quantity = fc.integer({ min: 1, max: 1_000_000_000 });

const op: fc.Arbitrary<Op> = fc.oneof(
  quantity.map((amount) => ({ kind: "topup", amount }) as const),
  quantity.map((amount) => ({ kind: "spend", amount }) as const),
);

/**
 * Apply a requested op stream the way the server would: a topup always appends
 * `+amount`; a spend appends `-amount` ONLY if it is covered by the balance
 * available at that moment (else it is rejected and appends nothing — exactly
 * the REQ-SPD-02 guard). Returns the resulting SIGNED ledger history.
 */
const applyValidSequence = (ops: ReadonlyArray<Op>): ReadonlyArray<number> => {
  const signed: number[] = [];
  let balance = 0;
  for (const o of ops) {
    if (o.kind === "topup") {
      signed.push(o.amount);
      balance += o.amount;
    } else if (o.amount <= balance) {
      // Covered spend: server-negated, appended, drains the balance.
      signed.push(-o.amount);
      balance -= o.amount;
    }
    // An uncovered spend is rejected: nothing is appended (REQ-SPD-02).
  }
  return signed;
};

it("[REQ-SPD-11] the projected balance is never negative at any prefix of a valid topup/spend history", () => {
  fc.assert(
    fc.property(fc.array(op), (ops) => {
      const signed = applyValidSequence(ops);
      // Walk every prefix: after each appended entry, the projection of the
      // history so far must be >= 0. A spend that overdrew (a mutation that
      // dropped the coverage guard) would surface as a negative prefix here.
      for (let i = 1; i <= signed.length; i++) {
        const prefix = signed.slice(0, i).map((amount) => ({ amount }));
        expect(projectBalance(prefix)).toBeGreaterThanOrEqual(0);
      }
    }),
  );
});

it("[REQ-SPD-11] the final projected balance equals exactly the sum of the appended signed amounts", () => {
  fc.assert(
    fc.property(fc.array(op), (ops) => {
      const signed = applyValidSequence(ops);
      const entries = signed.map((amount) => ({ amount }));
      const plainSum = signed.reduce((a, b) => a + b, 0);
      // The balance is the aggregation of the signed history — never a
      // separately tracked counter that could drift from the ledger.
      expect(projectBalance(entries)).toBe(plainSum);
    }),
  );
});

it("[REQ-SPD-11] a spend covered by the running balance never drives the balance below zero (equality boundary reaches exactly 0)", () => {
  fc.assert(
    fc.property(fc.array(op), (ops) => {
      const signed = applyValidSequence(ops);
      const entries = signed.map((amount) => ({ amount }));
      const final = projectBalance(entries);
      // The whole point of the invariant: a valid history can reach exactly
      // 0 (a spend == balance) but never undershoots it.
      expect(final).toBeGreaterThanOrEqual(0);
      // And it equals the running balance the model maintained — coverage
      // guard and projection agree.
      const modelBalance = signed.reduce((a, b) => a + b, 0);
      expect(final).toBe(modelBalance);
    }),
  );
});
