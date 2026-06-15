import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Account } from "../src/account.js";

it.effect("decodes a valid account", () =>
  Effect.gen(function* () {
    const row = {
      id: "acc_1",
      ownerId: "user_1",
      currency: "EUR",
      createdAt: "2026-06-15T00:00:00Z",
    };
    const decoded = yield* Schema.decodeUnknown(Account)(row);
    expect(decoded.id).toBe("acc_1");
    expect(decoded.currency).toBe("EUR");
  }),
);
