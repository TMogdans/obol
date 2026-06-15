import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // dist-test/ holds throwaway JS emitted by each package's
    // tsconfig.test.json (composite projects must emit). Those files are a
    // typecheck artifact only — never run them as tests. We run the .ts
    // sources directly. Keep vitest's defaults and add dist-test on top.
    exclude: [...configDefaults.exclude, "**/dist-test/**"],
  },
});
