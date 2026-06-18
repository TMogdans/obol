/**
 * Spec ↔ test traceability (Säule 3, on the spec level).
 *
 * The EARS criteria in a `spec.md` are the intent; the tests are what proves
 * the code still matches that intent. This module answers one question:
 * *does every criterion have at least one test that references it?* — the
 * mechanism that makes spec drift LOUD (a criterion the code outgrows leaves a
 * referencing test red) instead of silent.
 *
 * Criteria carry an id of the form `REQ-<CONTEXT>-<nr>` (e.g. `REQ-BAL-01`),
 * tagged in the spec and echoed in the test description. This is pure string
 * logic; the file walking / reporting lives in `trace-coverage-cli.ts`.
 */

/** Matches a criterion id like `REQ-BAL-01` / `REQ-SPEND-12`. */
const REQ_ID = /REQ-[A-Z]+-\d+/g;

/** All distinct REQ ids in `text`, in first-seen order. */
function uniqueIds(text: string): string[] {
  return [...new Set(text.match(REQ_ID) ?? [])];
}

/** Criterion ids declared in a spec markdown. */
export function extractSpecIds(markdown: string): string[] {
  return uniqueIds(markdown);
}

/** Criterion ids referenced from test source (typically in `it(...)` names). */
export function extractTestRefs(source: string): string[] {
  return uniqueIds(source);
}

export interface TraceResult {
  /** Criteria that no test references — the drift gap. */
  readonly untested: ReadonlyArray<string>;
  /** Test references to ids that no spec declares — typo or deleted criterion. */
  readonly orphans: ReadonlyArray<string>;
}

/**
 * Compare declared criteria against test references. Clean iff every criterion
 * is referenced AND no reference is dangling. One test may cover many criteria.
 */
export function checkTraceability(
  specIds: ReadonlyArray<string>,
  testRefs: ReadonlyArray<string>,
): TraceResult {
  const referenced = new Set(testRefs);
  const declared = new Set(specIds);
  return {
    untested: specIds.filter((id) => !referenced.has(id)),
    orphans: testRefs.filter((id) => !declared.has(id)),
  };
}
