import { type Tier, deriveTier } from "./derive-tier.js";

/**
 * CLI for the deterministic tier derivation. Reads changed paths from argv, or
 * from stdin if no args are given. Typical CI usage:
 *
 *   git diff --name-only origin/main...HEAD | node tools/derive-tier-cli.js
 *
 * Prints exactly the tier (T1/T2/T3) on stdout so it can be captured into a CI
 * variable. The T3 -> human-gate enforcement lives in branch protection
 * (Task 11), not here: this binary only *computes* the tier.
 */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function toPaths(text: string): ReadonlyArray<string> {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const paths = argv.length > 0 ? argv : toPaths(await readStdin());
  const tier: Tier = deriveTier(paths);
  process.stdout.write(`${tier}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
