/**
 * dependency-cruiser configuration — Säule 2 architecture gate.
 *
 * Enforces the service-boundary invariant of the Obol monorepo:
 *   - A service must never import another service's source directly.
 *     Cross-service code sharing goes through `packages/contracts` only.
 *   - No circular dependencies.
 *   - No orphan modules (dead source files), with documented exceptions for
 *     runtime entrypoints (`server.ts`) that are launched, not imported.
 *
 * Run: `pnpm run arch`  (== depcruise services packages --config ...)
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-cross-service-imports",
      comment:
        "A service must not import another service's source. Share code via packages/contracts only (Säule 2 boundary).",
      severity: "error",
      from: { path: "^services/([^/]+)/" },
      to: {
        path: "^services/([^/]+)/",
        pathNot: ["^services/$1/"],
      },
    },
    {
      name: "no-circular",
      comment:
        "Circular dependencies make the module graph un-reasonable-about.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-orphans",
      comment:
        "Orphan modules are usually dead code. Runtime entrypoints (server.ts) are launched via runMain, not imported, so they are exempt.",
      severity: "error",
      from: {
        orphan: true,
        pathNot: [
          "\\.d\\.ts$",
          "(^|/)tsconfig",
          "(^|/)[^/]+\\.config\\.(js|cjs|mjs|ts)$",
          "(^|/)server\\.ts$",
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(node_modules|dist|dist-test|coverage|test)" },
    tsConfig: { fileName: "tsconfig.base.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".js", ".cjs", ".mjs"],
    },
  },
};
