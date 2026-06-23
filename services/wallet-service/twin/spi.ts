/**
 * Twin SPI — the clean seam (Phase-1 design §7a).
 *
 * v1 is built CONCRETELY for the Obol wallet, but along a deliberate seam so the
 * later extraction into a generic `@devloop/twin` harness is mechanical, not a
 * rewrite. The split the design mandates:
 *
 *   GENERIC (→ future @devloop/twin)      PROJECT-LOCAL (stays in the repo)
 *   ────────────────────────────────      ───────────────────────────────────
 *   Runner (fc.commands + asyncModelRun)  the reference Model (what "correct" is)
 *   Testcontainers orchestration          the Operations / generators
 *   default Oracle matcher + normaliser   the Invariants (domain truths)
 *   gate wiring (job, null-divergence)    the System adapter (HTTP routes, reset)
 *
 * This module holds ONLY the interface-shaped types that both halves agree on.
 * `Model`, `System`, `Oracle` are the three nameable roles; the Runner is the
 * fast-check wiring in `wallet.twin.test.ts`. Nothing here is wallet-specific
 * beyond the `Command` shape — and that is the project-local operation set, kept
 * as a plain data union so the adapter never imports fast-check.
 *
 * Rule of Three (design §7a): we do NOT abstract over domains yet. These types
 * are the SEAM, not the framework. The framework is extracted from the 2nd–3rd
 * real user, not predicted from Obol alone.
 */

/**
 * A boundary observation: the HTTP status class the system answered, plus the
 * balance it returned when the operation surfaces one. These are the ONLY things
 * the oracle compares — boundary observables, never internal calls (design §4).
 *
 * `status` carries the literal HTTP status the design enumerates: 201 (created),
 * 200 (ok / idempotent replay), 400 (bad request), 404 (missing), 409
 * (insufficient funds), 500 (defect). `balance` is present only on a 2xx that
 * carries one (topup / spend success, balance query). `accountId` is the
 * server-generated id echoed by an account-open — the harness needs it to map a
 * logical slot onto the real account.
 */
export interface Outcome {
  readonly status: number;
  readonly balance?: number;
  readonly accountId?: string;
}

/**
 * A requested operation as plain data. The fast-check command classes translate
 * themselves into one of these before handing it to the {@link System} adapter,
 * so the adapter (and a future generic runner) never depends on fast-check.
 */
export type Command =
  | { readonly kind: "open"; readonly ownerId: string; readonly key: string }
  | {
      readonly kind: "topup";
      readonly accountId: string;
      readonly amount: number;
    }
  | {
      readonly kind: "spend";
      readonly accountId: string;
      readonly amount: number;
    }
  | { readonly kind: "query"; readonly accountId: string };

/**
 * The System-under-test adapter (project-local). Wraps the REAL wallet-service
 * behind a stable, async boundary so the runner stays domain-agnostic:
 *
 *   setup()              once — start the container, migrate, build the runtime
 *   reset()              once PER SEQUENCE — truncate so each fast-check run
 *                        starts from an empty ledger (design §4: state reset)
 *   execute(cmd)         apply one command, return the boundary outcome
 *   observeBalance(id)   an INDEPENDENT balance read (the "compare after every
 *                        step" cross-validation, design §4c)
 *   observeEntryCount(id)the append-only structural probe (invariant I3)
 *   teardown()           once — dispose the runtime, stop the container
 */
export interface System {
  setup(): Promise<void>;
  reset(): Promise<void>;
  execute(cmd: Command): Promise<Outcome>;
  observeBalance(accountId: string): Promise<Outcome>;
  observeEntryCount(accountId: string): Promise<number>;
  teardown(): Promise<void>;
}

/**
 * The oracle: compares the model's EXPECTED outcome against the system's ACTUAL
 * one and throws a rich, shrink-readable error on any divergence. The default
 * matcher lives in `oracle.ts`; the normalisation hook is where a project's
 * equivalence relation (design §5, the Brownfield matcher's home) would attach.
 */
export interface Oracle {
  compare(expected: Outcome, actual: Outcome, context: string): void;
}
