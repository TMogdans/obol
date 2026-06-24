import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // dist-test/ holds throwaway JS emitted by each package's
    // tsconfig.test.json (composite projects must emit). Those files are a
    // typecheck artifact only — never run them as tests. We run the .ts
    // sources directly. Keep vitest's defaults and add dist-test on top.
    //
    // twin/ holds the Greenfield Twin (model-based oracle over the real service
    // + Testcontainers). It is its OWN required job (vitest.twin.config.ts, CI
    // job "twin") with a null-divergence threshold, so it is excluded here to
    // avoid double-running the slow property suite in the example test job.
    exclude: [...configDefaults.exclude, "**/dist-test/**", "**/twin/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // Only measure real TypeScript sources. The compiled dist/ and dist-test/
      // JS are build artifacts and must never count toward coverage.
      include: ["services/*/src/**/*.ts", "packages/*/src/**/*.ts"],
      exclude: [
        "**/dist/**",
        "**/dist-test/**",
        // Composition-root / runtime bootstrap. These wire layers together and
        // call runMain; they are exercised end-to-end at deploy time, not in
        // unit tests, and contain no branching logic worth a coverage target.
        "**/src/index.ts",
        "**/src/server.ts",
        "**/src/main.ts",
        "**/src/telemetry.ts",
        "**/.stryker-tmp/**",
      ],
      // Ratchet thresholds, set just below the achieved baseline (measured with
      // the Testcontainers integration tests running):
      //   stmts 96.59 | branch 90.9 | funcs 100 | lines 96.59
      // They may only ever be raised. A drop below these floors fails CI.
      thresholds: {
        statements: 95,
        branches: 88,
        functions: 100,
        lines: 95,
      },
    },
  },
});
