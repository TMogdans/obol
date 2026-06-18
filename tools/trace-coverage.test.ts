import { expect, it } from "@effect/vitest";
import {
  checkTraceability,
  extractSpecIds,
  extractTestRefs,
} from "./trace-coverage.js";

it("extracts REQ ids from spec markdown criteria", () => {
  const md = [
    "## Akzeptanzkriterien (EARS)",
    "- **[REQ-BAL-01]** **When** a GET happens, **shall** return the balance.",
    "- **[REQ-BAL-02]** **If** the account is missing, **shall** return 404.",
  ].join("\n");
  expect(extractSpecIds(md)).toEqual(["REQ-BAL-01", "REQ-BAL-02"]);
});

it("deduplicates repeated ids within a spec", () => {
  const md = "see [REQ-BAL-01] and again [REQ-BAL-01]";
  expect(extractSpecIds(md)).toEqual(["REQ-BAL-01"]);
});

it("returns no ids when the spec has no criteria ids", () => {
  expect(extractSpecIds("plain prose with no tagged criteria")).toEqual([]);
});

it("extracts a REQ id referenced in a test description", () => {
  const src = 'it("[REQ-BAL-01] returns the summed balance", () => {});';
  expect(extractTestRefs(src)).toEqual(["REQ-BAL-01"]);
});

it("extracts multiple ids when one test covers several criteria", () => {
  const src =
    'it.effect("[REQ-BAL-01][REQ-BAL-02] serves balance and 404", ...)';
  expect(extractTestRefs(src)).toEqual(["REQ-BAL-01", "REQ-BAL-02"]);
});

it("reports a criterion with no referencing test as untested", () => {
  const result = checkTraceability(
    ["REQ-BAL-01", "REQ-BAL-02"],
    ["REQ-BAL-01"],
  );
  expect(result.untested).toEqual(["REQ-BAL-02"]);
  expect(result.orphans).toEqual([]);
});

it("reports a test ref with no matching criterion as orphan", () => {
  const result = checkTraceability(
    ["REQ-BAL-01"],
    ["REQ-BAL-01", "REQ-BAL-99"],
  );
  expect(result.orphans).toEqual(["REQ-BAL-99"]);
  expect(result.untested).toEqual([]);
});

it("is clean when every criterion is covered (one test, many criteria)", () => {
  const result = checkTraceability(
    ["REQ-BAL-01", "REQ-BAL-02", "REQ-BAL-03"],
    ["REQ-BAL-01", "REQ-BAL-02", "REQ-BAL-03"],
  );
  expect(result.untested).toEqual([]);
  expect(result.orphans).toEqual([]);
});
