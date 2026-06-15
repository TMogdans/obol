import { expect, it } from "@effect/vitest";
import { projectBalance } from "../src/balance.js";

it("sums entries to a balance", () => {
  expect(
    projectBalance([{ amount: 500 }, { amount: -200 }, { amount: 50 }]),
  ).toBe(350);
});

it("empty ledger is zero", () => {
  expect(projectBalance([])).toBe(0);
});
