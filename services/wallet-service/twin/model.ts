import type { Outcome } from "./spi.js";

/**
 * The reference model — the Twin (Phase-1 design §2). Deliberately DUMB:
 * trustworthy *because* it is trivial to read, not because it was verified.
 * It is the stateful shell around the one domain truth that the whole money-core
 * rests on — "a balance is the sum of the signed ledger entries" — implemented
 * here as a plain `reduce` so the model stays fully self-contained (it imports
 * NO production code: independence is the point, design Phase-0 §2).
 *
 * Each operation returns the EXPECTED {@link Outcome} (status class + balance)
 * computed from first principles, in the SAME precedence the spec mandates:
 *
 *   amount validity (400) → account existence (404) → coverage (409) → success
 *
 * That precedence mirrors the real handler's decode-rim-first ordering, so the
 * model predicts e.g. "invalid amount on a missing account" as a 400 (the decode
 * rim runs before the existence check), not a 404.
 *
 * Accounts are keyed by a LOGICAL id the model assigns in creation order; the
 * harness maps each logical slot onto the real server-generated id. Idempotency
 * is modelled exactly for account-open (same key → same account, no second row —
 * REQ-ACC-02) and deliberately NOT for topup/spend (no replay contract in v1 —
 * Specs OoS, design I6).
 */

/** A spend/topup amount is valid iff it is a positive integer (REQ-TOP-02 / REQ-SPD-03). */
const isValidAmount = (amount: number): boolean =>
  Number.isInteger(amount) && amount > 0;

/** An owner id is valid iff it is a non-empty, non-whitespace string (REQ-ACC-04). */
const isValidOwner = (ownerId: string): boolean => ownerId.trim().length > 0;

export class WalletModel {
  /** logical account id → its append-only signed entries. */
  private readonly accounts = new Map<string, number[]>();
  /** idempotency key → logical account id (account-open only — REQ-ACC-02). */
  private readonly byKey = new Map<string, string>();
  /** logical ids in creation order; the harness aligns real ids to these slots. */
  readonly order: string[] = [];
  private counter = 0;

  /** How many accounts exist — the harness uses this to resolve a slot index. */
  get accountCount(): number {
    return this.order.length;
  }

  /** The balance of a logical account: the sum of its signed entries (I1). */
  balance(logicalId: string): number {
    return (this.accounts.get(logicalId) ?? []).reduce((sum, a) => sum + a, 0);
  }

  /** The append-only entry count of a logical account (I3 structural probe). */
  entryCount(logicalId: string): number {
    return (this.accounts.get(logicalId) ?? []).length;
  }

  /**
   * Open an account idempotently on `key`. Empty owner → 400 (no account). A key
   * already seen → the existing account, 200, no second row (REQ-ACC-02). Else a
   * new account, 201 (REQ-ACC-01/05). Returns the outcome plus the logical id of
   * the affected account (so the harness can align the slot).
   */
  open(
    ownerId: string,
    key: string,
  ): Outcome & { readonly logicalId?: string; readonly created: boolean } {
    if (!isValidOwner(ownerId)) {
      return { status: 400, created: false };
    }
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      return { status: 200, logicalId: existing, created: false };
    }
    const id = `a${this.counter++}`;
    this.accounts.set(id, []);
    this.byKey.set(key, id);
    this.order.push(id);
    return { status: 201, logicalId: id, created: true };
  }

  /**
   * Top up a logical account. `logicalId === undefined` models a missing
   * account. Precedence: invalid amount → 400 (REQ-TOP-02); missing → 404
   * (REQ-TOP-03); else append `+amount`, return the new balance (REQ-TOP-01/04).
   */
  topup(logicalId: string | undefined, amount: number): Outcome {
    if (!isValidAmount(amount)) {
      return { status: 400 };
    }
    const entries =
      logicalId === undefined ? undefined : this.accounts.get(logicalId);
    if (entries === undefined) {
      return { status: 404 };
    }
    entries.push(amount);
    return { status: 200, balance: entries.reduce((sum, a) => sum + a, 0) };
  }

  /**
   * Spend from a logical account. Precedence: invalid amount → 400
   * (REQ-SPD-03); missing → 404 (REQ-SPD-04); amount > balance → 409, NO entry
   * (REQ-SPD-02); else append `-amount` (equality reaches exactly 0, allowed),
   * return the new balance (REQ-SPD-01/05).
   */
  spend(logicalId: string | undefined, amount: number): Outcome {
    if (!isValidAmount(amount)) {
      return { status: 400 };
    }
    const entries =
      logicalId === undefined ? undefined : this.accounts.get(logicalId);
    if (entries === undefined) {
      return { status: 404 };
    }
    if (amount > entries.reduce((sum, a) => sum + a, 0)) {
      return { status: 409 };
    }
    entries.push(-amount);
    return { status: 200, balance: entries.reduce((sum, a) => sum + a, 0) };
  }

  /**
   * Query a logical account's balance. Missing → 404 (REQ-BAL-02); else the sum,
   * an empty ledger projecting to 0 (REQ-BAL-01/03).
   */
  balanceOf(logicalId: string | undefined): Outcome {
    if (logicalId === undefined || !this.accounts.has(logicalId)) {
      return { status: 404 };
    }
    return { status: 200, balance: this.balance(logicalId) };
  }
}
