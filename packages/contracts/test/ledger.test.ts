import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { LedgerEntry } from "../src/ledger.js";

it.effect("decodes a valid topup entry", () =>
  Effect.gen(function* () {
    const row = {
      id: "01J",
      accountId: "acc_1",
      amount: 500,
      type: "topup",
      idempotencyKey: "k1",
      createdAt: "2026-06-15T00:00:00Z",
    };
    const decoded = yield* Schema.decodeUnknown(LedgerEntry)(row);
    expect(decoded.amount).toBe(500);
  }),
);

it.effect("rejects an unknown entry type", () =>
  Effect.gen(function* () {
    const bad = {
      id: "x",
      accountId: "a",
      amount: 1,
      type: "wiretransfer",
      idempotencyKey: "k",
      createdAt: "2026-06-15T00:00:00Z",
    };
    const result = yield* Effect.either(Schema.decodeUnknown(LedgerEntry)(bad));
    expect(result._tag).toBe("Left");
  }),
);
