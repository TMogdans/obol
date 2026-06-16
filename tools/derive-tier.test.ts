import { expect, it } from "@effect/vitest";
import { deriveTier } from "./derive-tier.js";

it("migration path forces T3", () => {
  expect(deriveTier(["services/wallet-service/migrations/0002.sql"])).toBe(
    "T3",
  );
});

it("touching contracts forces T3", () => {
  expect(deriveTier(["packages/contracts/src/ledger.ts"])).toBe("T3");
});

it("service code is at least T2", () => {
  expect(deriveTier(["services/wallet-service/src/balance.ts"])).toBe("T2");
});

it("docs/config only is T1", () => {
  expect(deriveTier(["README.md"])).toBe("T1");
});

it("highest tier wins across mixed paths", () => {
  expect(
    deriveTier(["README.md", "services/wallet-service/migrations/0003.sql"]),
  ).toBe("T3");
});

it("empty changeset is T1 (or define a sensible default)", () => {
  expect(deriveTier([])).toBe("T1");
});

// Edge cases — adversarial-proofing the upgrade-wins rule.

it("auth path anywhere in a service forces T3", () => {
  expect(deriveTier(["services/wallet-service/src/auth/token.ts"])).toBe("T3");
});

it("a single path matching multiple tiers gets the highest", () => {
  // matches services/** (T2) AND **/auth/** (T3) -> T3 must win.
  expect(deriveTier(["services/wallet-service/src/auth/middleware.ts"])).toBe(
    "T3",
  );
});

it("does not partial-match a segment (auth must be a path segment)", () => {
  // "author" must NOT trigger the **/auth/** rule; it is plain service code.
  expect(deriveTier(["services/wallet-service/src/authoring.ts"])).toBe("T2");
});

it("a packages path that is not contracts is T1", () => {
  expect(deriveTier(["packages/other/src/util.ts"])).toBe("T1");
});

it("the highest tier across many paths wins regardless of order", () => {
  expect(
    deriveTier([
      "packages/contracts/src/ledger.ts",
      "services/wallet-service/src/balance.ts",
      "README.md",
    ]),
  ).toBe("T3");
});
