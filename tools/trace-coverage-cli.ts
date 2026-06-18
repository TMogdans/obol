import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type TraceResult,
  checkTraceability,
  extractSpecIds,
  extractTestRefs,
} from "./trace-coverage.js";

/**
 * CI gate: every EARS criterion in `.specify/specs/**\/spec.md` must be
 * referenced by at least one test, and no test may reference a criterion that
 * does not exist. Exits non-zero on either failure so it can be a required
 * check (the mechanism that makes spec drift loud — see trace-coverage.ts).
 *
 * Scope note: criterion-referencing tests live under services/ and packages/
 * (the product). tools/ is deliberately NOT scanned — its own tests use REQ
 * ids as fixtures and would otherwise register as references.
 */

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(moduleDir, "..");

const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "dist-test",
  ".git",
  "coverage",
  "reports",
]);

function walk(dir: string, matches: (path: string) => boolean): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walk(full, matches));
    } else if (matches(full)) {
      found.push(full);
    }
  }
  return found;
}

function main(): void {
  const specFiles = walk(join(repoRoot, ".specify", "specs"), (p) =>
    p.endsWith("spec.md"),
  );
  const testFiles = [
    ...walk(join(repoRoot, "services"), (p) => p.endsWith(".test.ts")),
    ...walk(join(repoRoot, "packages"), (p) => p.endsWith(".test.ts")),
  ];

  const specOf = new Map<string, string>();
  const specIds: string[] = [];
  for (const file of specFiles) {
    for (const id of extractSpecIds(readFileSync(file, "utf8"))) {
      if (!specOf.has(id)) {
        specOf.set(id, relative(repoRoot, file));
        specIds.push(id);
      }
    }
  }

  const refs = new Set<string>();
  for (const file of testFiles) {
    for (const ref of extractTestRefs(readFileSync(file, "utf8"))) {
      refs.add(ref);
    }
  }

  const result: TraceResult = checkTraceability(specIds, [...refs]);
  const covered = specIds.length - result.untested.length;
  const specCount = specFiles.length;

  process.stdout.write("Spec ↔ test traceability\n");
  process.stdout.write(
    `  criteria declared: ${specIds.length}  (${specCount} spec${specCount === 1 ? "" : "s"})\n`,
  );
  process.stdout.write(
    `  covered: ${covered}   untested: ${result.untested.length}   orphan refs: ${result.orphans.length}\n`,
  );

  if (result.untested.length === 0 && result.orphans.length === 0) {
    process.stdout.write("✓ every criterion is covered by a test\n");
    return;
  }

  if (result.untested.length > 0) {
    process.stdout.write(
      "\n✗ untested criteria (no test references the id):\n",
    );
    for (const id of result.untested) {
      process.stdout.write(`    ${id}   ${specOf.get(id) ?? "?"}\n`);
    }
  }
  if (result.orphans.length > 0) {
    process.stdout.write(
      "\n✗ orphan test references (no criterion declares the id):\n",
    );
    for (const id of result.orphans) {
      process.stdout.write(`    ${id}\n`);
    }
  }
  process.exitCode = 1;
}

main();
