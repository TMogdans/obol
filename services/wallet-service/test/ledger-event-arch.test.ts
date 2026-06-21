import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";

/**
 * Architecture / boundary tests for the ledger-event-publish feature.
 *
 * devloop spec-PR seam: EACH case is individually `it.effect.skip`'d / `it.skip`'d
 * with its `[REQ-EVT-08]` id in the title — the sanctioned skip idiom
 * (`semgrep-escape-hatches.yml`: a `.skip` is allowed ONLY on a REQ-tagged test).
 * The `describe` is a plain, UNskipped container — verify-unskip evaluates
 * per-`it` and ignores containers. The producer code/schema/migration do not
 * exist yet, so these are written COMPLETE (real assertions on the on-disk
 * structure + the authoritative arch gate) but skipped: the trace gate counts the
 * `[REQ-EVT-08]` tag as coverage while vitest does not redden a skipped case, so
 * `main` stays green when the spec PR lands. The later `implement` station may
 * ONLY remove the `.skip` (enforced by verify-unskip); it must not touch a title
 * or an assertion.
 *
 * Maps REQ-EVT-08 (boundary / Tier-justification): the new event schema lives in
 * `packages/contracts/**`, the outbox migration is the single new file under
 * `services/wallet-service/migrations/**`, producer/publisher/NATS code is
 * service-local under `services/wallet-service/src/**`, and there is NO touch of
 * any auth path (the glob services-or-packages/auth).
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

describe("ledger-event-publish — boundaries / Tier (REQ-EVT-08)", () => {
  it.effect.skip(
    "[REQ-EVT-08] respects the dependency boundaries (no cycle/orphan, wallet-service depends on @obol/contracts only via the package, no cross-service import) — anchored on `pnpm run arch`",
    () =>
      Effect.sync(() => {
        // Traceability anchor, NOT a duplicated ArchUnit: the architecture truth
        // lives in `pnpm run arch` (dependency-cruiser). This case binds the REQ
        // id to that gate by invoking it and asserting it passes — so the
        // locality rule (producer/publisher/NATS code local to wallet-service,
        // the shared schema reached only through @obol/contracts, no cross-service
        // import, no cycle/orphan) is proven by the single authoritative gate.
        // Throws (non-zero exit) iff dependency-cruiser reports a violation.
        execFileSync("pnpm", ["run", "arch"], {
          cwd: repoRoot,
          stdio: "pipe",
        });
      }),
  );

  it.skip("[REQ-EVT-08] the LedgerEntryRecorded schema lives in packages/contracts (the T3 contract path), not service-locally in wallet-service", () => {
    // The event schema is defined ONCE in the shared contracts package
    // (REQ-EVT-02) — that is one of the two T3-defining touches. Assert it is
    // declared there and re-exported through the barrel.
    const ledger = readFileSync(
      resolve(repoRoot, "packages/contracts/src/ledger.ts"),
      "utf8",
    );
    expect(ledger).toContain("LedgerEntryRecorded");
    const barrel = readFileSync(
      resolve(repoRoot, "packages/contracts/src/index.ts"),
      "utf8",
    );
    expect(barrel).toContain("./ledger.js");

    // The service must NOT define a local copy of the event schema (no
    // service-local event truth). No wallet-service src file may declare its
    // own `LedgerEntryRecorded` struct.
    const srcDir = resolve(repoRoot, "services/wallet-service/src");
    for (const file of readdirSync(srcDir)) {
      if (!file.endsWith(".ts")) continue;
      const content = readFileSync(resolve(srcDir, file), "utf8");
      // A definition would look like `const LedgerEntryRecorded = Schema.Struct`
      // or `class LedgerEntryRecorded`. Importing the contract is fine.
      expect(content).not.toMatch(
        /(const|class)\s+LedgerEntryRecorded\b\s*[=]/,
      );
    }
  });

  it.skip("[REQ-EVT-08] introduces exactly the one new outbox migration 0003_*.sql under wallet-service/migrations and touches NO **/auth/** path", () => {
    // The outbox migration is the second T3-defining touch — there must be a
    // single new migration whose ordinal is 0003 for the outbox.
    const migrationsDir = resolve(
      repoRoot,
      "services/wallet-service/migrations",
    );
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
    const outbox = files.filter((f) => /^0003_.*\.sql$/.test(f));
    expect(outbox.length).toBe(1);
    // The migration creates the separate outbox table (a NEW table, not an
    // ALTER of ledger_entry — REQ-EVT-06 keeps ledger_entry untouched).
    const sql = readFileSync(
      resolve(migrationsDir, outbox[0] as string),
      "utf8",
    );
    expect(sql).toMatch(/CREATE TABLE\s+ledger_outbox/i);
    // The pending-drain index (REQ-EVT-09) is created in the same migration.
    expect(sql).toMatch(/CREATE INDEX/i);
    // No ALTER/UPDATE/DELETE of ledger_entry sneaks into this migration.
    expect(sql).not.toMatch(/ALTER TABLE\s+ledger_entry/i);

    // No auth path exists in this repo and the feature must not create one:
    // there is NO `**/auth/**` directory under services or packages.
    const authCandidates = [
      resolve(repoRoot, "services/wallet-service/src/auth"),
      resolve(repoRoot, "packages/contracts/src/auth"),
    ];
    for (const candidate of authCandidates) {
      expect(existsSync(candidate)).toBe(false);
    }
  });
});
