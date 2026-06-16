import { expect, it } from "@effect/vitest";
import * as fc from "fast-check";
import { projectBalance } from "../src/balance.js";

/**
 * Bounded integer amount.
 *
 * Amounts are integer minor units (see {@link projectBalance}'s bigint
 * boundary note). We bound the magnitude so that even a large array of
 * amounts sums well within `Number.MAX_SAFE_INTEGER`, keeping integer
 * addition exact — the property must fail on a real mutation, not on a
 * floating-point rounding artefact we deliberately engineered around.
 */
const amount = fc.integer({ min: -1_000_000_000, max: 1_000_000_000 });

it("balance equals the plain sum of amounts", () => {
  fc.assert(
    fc.property(fc.array(amount), (xs) => {
      const entries = xs.map((value) => ({ amount: value }));
      expect(projectBalance(entries)).toBe(xs.reduce((a, b) => a + b, 0));
    }),
  );
});

it("balance is independent of entry order", () => {
  fc.assert(
    fc.property(fc.array(amount), (xs) => {
      const entries = xs.map((value) => ({ amount: value }));
      const reversed = [...entries].reverse();
      expect(projectBalance(reversed)).toBe(projectBalance(entries));
    }),
  );
});

it("balance is invariant under any permutation of entries", () => {
  fc.assert(
    fc.property(
      fc.array(amount).chain((xs) =>
        fc.tuple(
          fc.constant(xs),
          fc.shuffledSubarray(xs, {
            minLength: xs.length,
            maxLength: xs.length,
          }),
        ),
      ),
      ([xs, permuted]) => {
        const entries = xs.map((value) => ({ amount: value }));
        const shuffled = permuted.map((value) => ({ amount: value }));
        expect(projectBalance(shuffled)).toBe(projectBalance(entries));
      },
    ),
  );
});

it("empty ledger projects to zero", () => {
  expect(projectBalance([])).toBe(0);
});

it("appending a zero-amount entry leaves the balance unchanged", () => {
  fc.assert(
    fc.property(fc.array(amount), (xs) => {
      const entries = xs.map((value) => ({ amount: value }));
      const withZero = [...entries, { amount: 0 }];
      expect(projectBalance(withZero)).toBe(projectBalance(entries));
    }),
  );
});
