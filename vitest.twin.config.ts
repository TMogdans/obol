import { defineConfig } from "vitest/config";

// Vitest config for the Twin gate (pnpm run twin, CI job "twin").
//
// The Greenfield Twin (Phase-1 design; blog part 8) runs the REAL wallet-service
// against a trivial reference model over thousands of generated money-core
// sequences (Testcontainers-Postgres, decision D1). It is its OWN required job,
// separate from the example test suite, because its threshold is categorically
// different: null divergence (any model/system mismatch fails), not a coverage
// percentage. The main vitest config excludes the twin folder so the slow
// property run does not double-execute in the example suite.
//
// No coverage block on purpose: the twin measures behavioural agreement, not
// line coverage. Timeouts are generous: one run drives many real HTTP
// round-trips plus per-step independent reads.
export default defineConfig({
  test: {
    include: ["services/*/twin/**/*.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 180_000,
  },
});
