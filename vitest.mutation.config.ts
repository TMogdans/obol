import { configDefaults, defineConfig } from "vitest/config";

/**
 * Vitest config used exclusively by Stryker (`pnpm run mutation`).
 *
 * Mutation testing targets the PURE projection module
 * (`services/wallet-service/src/balance.ts::projectBalance`). To keep the
 * Stryker run fast and meaningful we run ONLY the pure balance tests — the
 * unit example test and the fast-check property test. The DB/HTTP/integration
 * tests (Testcontainers-bound) are excluded: they need Docker, are slow, and
 * do not exercise the pure projection in isolation, so they would add minutes
 * per mutant for no extra killing power.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/dist-test/**"],
    include: [
      "services/wallet-service/test/balance.test.ts",
      "services/wallet-service/test/balance.property.test.ts",
    ],
  },
});
