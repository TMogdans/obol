import type { Oracle, Outcome } from "./spi.js";

/**
 * The default oracle (Phase-1 design §4). Compares two boundary observations:
 *   (a) the status class the system answered vs. the one the model expected,
 *   (b) the returned balance, when the operation surfaces one.
 *
 * Any divergence throws a rich, shrink-readable error: fast-check prints the
 * message on the MINIMAL failing sequence, so the message must name what
 * diverged in plain numbers — that report IS the bug ticket.
 *
 * `normalise` is the seam for a project's equivalence relation (design §5: the
 * Brownfield matcher's home — which fields must match exactly, which may vary).
 * For the wallet money-core the relation is strict, with one deliberate
 * coarsening: ANY 5xx collapses to 500, because the design treats a DB-fault as
 * a single "defect" class (I8) rather than distinguishing 500 from 503 etc.
 */
const normalise = (o: Outcome): Outcome =>
  o.status >= 500 ? { ...o, status: 500 } : o;

/**
 * Compare the balance only when BOTH sides claim to carry one. A status mismatch
 * is reported first (it is the more fundamental divergence); balance is checked
 * only once the status classes agree and at least one side is a balance-bearing
 * success.
 */
export const defaultOracle: Oracle = {
  compare(expectedRaw: Outcome, actualRaw: Outcome, context: string): void {
    const expected = normalise(expectedRaw);
    const actual = normalise(actualRaw);

    if (expected.status !== actual.status) {
      throw new Error(
        `${context}: status divergence — model expected ${expected.status}, system returned ${actual.status}${
          actual.balance !== undefined
            ? ` (system balance=${actual.balance})`
            : ""
        }`,
      );
    }

    // Status classes agree. If the model expects a balance, the system must
    // return the SAME one — a divergence here is the heart of the money-core
    // oracle (a returned figure that drifted from the projected truth).
    if (expected.balance !== undefined) {
      if (actual.balance === undefined) {
        throw new Error(
          `${context}: balance divergence — model expected balance ` +
            `${expected.balance}, system returned none`,
        );
      }
      if (expected.balance !== actual.balance) {
        throw new Error(
          `${context}: balance divergence — model expected ${expected.balance}, ` +
            `system returned ${actual.balance}`,
        );
      }
    }
  },
};
