import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Risk tier of a change. The map only defines T1-T3; T0 exists in the union as
 * the framework's "no-op / trivial" floor but is never *derived* from paths —
 * any touched path matches at least the T1 catch-all (`**`).
 */
export type Tier = "T0" | "T1" | "T2" | "T3";

/**
 * The protected rule set: tier -> glob patterns. This is DATA, owned by
 * @tmogdans via CODEOWNERS (`/tools/`). The derivation logic below is separate
 * from it, so the rules can be audited and changed only with human sign-off,
 * while the algorithm stays put.
 */
type TierMap = Readonly<Record<string, ReadonlyArray<string>>>;

/**
 * Ordered high -> low. The HIGHEST matching tier wins ("upgrade-wins"): a single
 * migration / auth / contracts path anywhere in the changeset forces T3, and no
 * lower-tier match can pull it back down. This is the load-bearing §9 rule — the
 * tier is derived from paths, never chosen by the agent, so the agent cannot
 * lower its own risk classification.
 */
const TIER_PRIORITY: ReadonlyArray<Tier> = ["T3", "T2", "T1"];

const TIER_RANK: Readonly<Record<Tier, number>> = {
  T0: 0,
  T1: 1,
  T2: 2,
  T3: 3,
};

const moduleDir = dirname(fileURLToPath(import.meta.url));

function loadTierMap(): TierMap {
  const raw = readFileSync(join(moduleDir, "tier-map.json"), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("tier-map.json must be a JSON object");
  }
  const result: Record<string, ReadonlyArray<string>> = {};
  for (const [tier, patterns] of Object.entries(parsed)) {
    if (
      !Array.isArray(patterns) ||
      !patterns.every((p): p is string => typeof p === "string")
    ) {
      throw new Error(`tier-map.json: "${tier}" must be an array of strings`);
    }
    result[tier] = patterns;
  }
  return result;
}

/**
 * Segment-aware glob match. Supports:
 *   - `*`  matches any run of characters WITHIN a single path segment (no `/`)
 *   - `**` matches across path segments (zero or more), including none
 * Anchored at both ends (the whole path must match). Matching segment-by-segment
 * is what prevents `**\/auth\/**` from matching `.../authoring.ts` — `auth` is a
 * full segment, not a substring.
 */
function matchGlob(pattern: string, path: string): boolean {
  const patternParts = pattern.split("/");
  const pathParts = path.split("/");
  return matchSegments(patternParts, 0, pathParts, 0);
}

function matchSegments(
  pat: ReadonlyArray<string>,
  pi: number,
  path: ReadonlyArray<string>,
  si: number,
): boolean {
  if (pi === pat.length) {
    return si === path.length;
  }

  const seg = pat[pi];

  if (seg === "**") {
    // `**` consumes zero or more whole segments. Try every split point.
    for (let next = si; next <= path.length; next++) {
      if (matchSegments(pat, pi + 1, path, next)) {
        return true;
      }
    }
    return false;
  }

  if (si === path.length) {
    return false;
  }

  const current = path[si];
  if (current === undefined || seg === undefined) {
    return false;
  }
  if (!matchSingleSegment(seg, current)) {
    return false;
  }
  return matchSegments(pat, pi + 1, path, si + 1);
}

/** Match one pattern segment against one path segment; `*` = any chars, no `/`. */
function matchSingleSegment(seg: string, value: string): boolean {
  // Build an anchored regex from the segment, treating `*` as `[^/]*` and
  // escaping every other regex-special character.
  let re = "^";
  for (const ch of seg) {
    re += ch === "*" ? "[^/]*" : ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  re += "$";
  return new RegExp(re).test(value);
}

function isTier(value: string): value is Tier {
  return value === "T0" || value === "T1" || value === "T2" || value === "T3";
}

/**
 * Derive the risk tier from the set of touched paths.
 *
 * Returns the HIGHEST tier whose patterns match any changed path. An empty
 * changeset is T1 (the catch-all floor — nothing to escalate, but never below
 * the baseline review tier).
 */
export function deriveTier(changedPaths: ReadonlyArray<string>): Tier {
  const tierMap = loadTierMap();

  let best: Tier = "T1";

  for (const tier of TIER_PRIORITY) {
    const patterns = tierMap[tier];
    if (patterns === undefined || !isTier(tier)) {
      continue;
    }
    const matches = changedPaths.some((path) =>
      patterns.some((pattern) => matchGlob(pattern, path)),
    );
    if (matches && TIER_RANK[tier] > TIER_RANK[best]) {
      best = tier;
    }
  }

  return best;
}
