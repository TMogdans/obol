import { describe, expect, it } from "@effect/vitest";
import { Effect, type Schema as SchemaNs } from "effect";
import { Schema } from "effect";

/**
 * Contract tests for the `LedgerEntryRecorded` event schema introduced by
 * `.specify/specs/ledger-event-publish/spec.md`.
 *
 * devloop spec-PR seam: EACH case is individually `it.effect.skip`'d / `it.skip`'d
 * with its `[REQ-EVT-..]` id in the title — the sanctioned skip idiom
 * (`semgrep-escape-hatches.yml`: a `.skip` is allowed ONLY on a REQ-tagged test;
 * the title literal follows `(` and carries the tag, so the escape-hatch guard
 * passes). The `describe` is a plain, UNskipped container — verify-unskip
 * evaluates per-`it` and ignores containers.
 *
 * `LedgerEntryRecorded` does not exist yet. The required `typecheck (tsc -b)`
 * gate also runs on the spec PR, so a STATIC `import { LedgerEntryRecorded }`
 * from a symbol that is not yet exported would redden the spec PR (TS2305). The
 * schema is therefore pulled in via a NON-LITERAL dynamic `import(specifier)`
 * inside each skipped body: NodeNext `tsc` does not module-resolve a non-literal
 * dynamic import, so this compiles today, and the `import()` only EXECUTES once
 * `implement` removes the `.skip` (by then the symbol exists). The bodies are
 * COMPLETE (real decode/encode, real assertions) — the trace gate counts the
 * `[REQ-EVT-..]` tags as coverage while vitest does not redden a skipped case, so
 * `main` stays green when the spec PR lands. `implement` may ONLY remove the
 * `.skip` (enforced by verify-unskip); it must not touch a title or an assertion.
 *
 * Maps the contract criteria REQ-EVT-02 (schema lives here, encode/validate
 * before publish) and REQ-EVT-07 (exact field types) one-to-one.
 */

/** The expected runtime type of the new schema (a Struct over the four fields). */
type RecordedSchema = SchemaNs.Schema<{
  readonly entryId: string;
  readonly accountId: string;
  readonly amount: number;
  readonly occurredAt: string;
}>;

/**
 * Load the new schema from the (still-to-be-written) module via a non-literal
 * specifier so `tsc` leaves it unresolved. After `implement` adds the export and
 * un-skips, this resolves the REAL `LedgerEntryRecorded` and the assertions below
 * exercise it for real. The barrel path is used so this ALSO proves the
 * re-export wiring (REQ-EVT-02: one shared source via packages/contracts/index).
 */
const barrelSpecifier = "../src/index.js";
const ledgerSpecifier = "../src/ledger.js";

const loadFromBarrel = async (): Promise<RecordedSchema> => {
  const mod = (await import(barrelSpecifier)) as {
    LedgerEntryRecorded: RecordedSchema;
  };
  return mod.LedgerEntryRecorded;
};

describe("ledger-event-publish — LedgerEntryRecorded contract", () => {
  // A canonical, valid event payload built from the four spec-fixed fields.
  // `amount` is the stored, signed minor-unit amount; `occurredAt` is the
  // ISO-8601 string form of `ledger_entry.created_at`.
  const validEvent = {
    entryId: "led_1f3c2b6a-9d44-4e0a-8c21-2b9a0f5e7d31",
    accountId: "acc-evt-1",
    amount: 700,
    occurredAt: "2026-06-21T12:00:00.000Z",
  } as const;

  it.effect.skip(
    "[REQ-EVT-07] is a Schema.Struct with exactly entryId/accountId/amount/occurredAt and decodes a valid event to those values",
    () =>
      Effect.gen(function* () {
        const LedgerEntryRecorded = yield* Effect.promise(loadFromBarrel);
        const decoded =
          yield* Schema.decodeUnknown(LedgerEntryRecorded)(validEvent);
        expect(decoded.entryId).toBe(validEvent.entryId);
        expect(decoded.accountId).toBe(validEvent.accountId);
        expect(decoded.amount).toBe(700);
        expect(decoded.occurredAt).toBe(validEvent.occurredAt);
        // Exactly the four spec-mandated fields — no extra required field crept
        // into the minimal four-field contract (no `type`/`eventId`/`currency`).
        expect(Object.keys(decoded).sort()).toEqual([
          "accountId",
          "amount",
          "entryId",
          "occurredAt",
        ]);
      }),
  );

  it.effect.skip(
    "[REQ-EVT-07] carries a negative signed amount unchanged for a spend event",
    () =>
      Effect.gen(function* () {
        const LedgerEntryRecorded = yield* Effect.promise(loadFromBarrel);
        // A spend stores a negative amount; the event mirrors the stored signed
        // value so a consumer can sum events into the same balance projectBalance
        // produces. The schema must accept negative integers.
        const spendEvent = { ...validEvent, amount: -300 };
        const decoded =
          yield* Schema.decodeUnknown(LedgerEntryRecorded)(spendEvent);
        expect(decoded.amount).toBe(-300);
      }),
  );

  it.effect.skip(
    "[REQ-EVT-07] rejects a non-integer amount (amount is Schema.Int, not Schema.Number)",
    () =>
      Effect.gen(function* () {
        const LedgerEntryRecorded = yield* Effect.promise(loadFromBarrel);
        const fractional = { ...validEvent, amount: 1.5 };
        const result = yield* Effect.either(
          Schema.decodeUnknown(LedgerEntryRecorded)(fractional),
        );
        expect(result._tag).toBe("Left");
      }),
  );

  it.effect.skip(
    "[REQ-EVT-07] rejects a payload whose fields have the wrong primitive type (string entryId/accountId/occurredAt, int amount)",
    () =>
      Effect.gen(function* () {
        const LedgerEntryRecorded = yield* Effect.promise(loadFromBarrel);

        // entryId as a number violates Schema.String.
        const badEntryId = { ...validEvent, entryId: 123 } as unknown;
        expect(
          (yield* Effect.either(
            Schema.decodeUnknown(LedgerEntryRecorded)(badEntryId),
          ))._tag,
        ).toBe("Left");

        // accountId as a number violates Schema.String.
        const badAccountId = { ...validEvent, accountId: 1 } as unknown;
        expect(
          (yield* Effect.either(
            Schema.decodeUnknown(LedgerEntryRecorded)(badAccountId),
          ))._tag,
        ).toBe("Left");

        // amount as a string violates Schema.Int.
        const badAmount = { ...validEvent, amount: "700" } as unknown;
        expect(
          (yield* Effect.either(
            Schema.decodeUnknown(LedgerEntryRecorded)(badAmount),
          ))._tag,
        ).toBe("Left");

        // occurredAt as a number violates Schema.String.
        const badOccurredAt = { ...validEvent, occurredAt: 0 } as unknown;
        expect(
          (yield* Effect.either(
            Schema.decodeUnknown(LedgerEntryRecorded)(badOccurredAt),
          ))._tag,
        ).toBe("Left");
      }),
  );

  it.effect.skip(
    "[REQ-EVT-07] rejects a payload missing any of the four required fields",
    () =>
      Effect.gen(function* () {
        const LedgerEntryRecorded = yield* Effect.promise(loadFromBarrel);
        for (const omit of [
          "entryId",
          "accountId",
          "amount",
          "occurredAt",
        ] as const) {
          const partial: Record<string, unknown> = { ...validEvent };
          delete partial[omit];
          const result = yield* Effect.either(
            Schema.decodeUnknown(LedgerEntryRecorded)(partial),
          );
          expect(result._tag).toBe("Left");
        }
      }),
  );

  it.effect.skip(
    "[REQ-EVT-02] encodes a valid event before publish (Schema.encode round-trips to the wire shape)",
    () =>
      Effect.gen(function* () {
        const LedgerEntryRecorded = yield* Effect.promise(loadFromBarrel);
        // The producer must encode/validate against this schema BEFORE publishing
        // (REQ-EVT-02). encode produces the wire payload; for a struct of plain
        // primitives it round-trips identically and re-decodes to the same value.
        const encoded = yield* Schema.encode(LedgerEntryRecorded)(validEvent);
        expect(encoded).toEqual(validEvent);
        const reDecoded =
          yield* Schema.decodeUnknown(LedgerEntryRecorded)(encoded);
        expect(reDecoded).toEqual(validEvent);
      }),
  );

  it.effect.skip(
    "[REQ-EVT-02] fails encoding a schema-violating event so no invalid event can be published",
    () =>
      Effect.gen(function* () {
        const LedgerEntryRecorded = yield* Effect.promise(loadFromBarrel);
        // A producer that built a malformed event (here a fractional amount) must
        // fail at the encode rim — this is the guard that no event violating the
        // schema is ever put on the wire.
        const invalid = { ...validEvent, amount: 2.5 };
        const result = yield* Effect.either(
          Schema.encode(LedgerEntryRecorded)(invalid),
        );
        expect(result._tag).toBe("Left");
      }),
  );

  it.effect.skip(
    "[REQ-EVT-02] is exported from the package barrel (packages/contracts/src/index.ts) AND the deep module (src/ledger.ts) as the single shared source",
    () =>
      Effect.gen(function* () {
        // Producer and the future consumer share ONE schema source: it must be
        // reachable through the package's public entry point (the barrel) AND be
        // the SAME object the deep module exports — proving the re-export wiring
        // in index.ts re-exports ledger.ts (not a divergent copy).
        const fromBarrel = (yield* Effect.promise(
          () => import(barrelSpecifier),
        )) as { LedgerEntryRecorded: unknown };
        const fromModule = (yield* Effect.promise(
          () => import(ledgerSpecifier),
        )) as { LedgerEntryRecorded: unknown };
        expect(fromBarrel.LedgerEntryRecorded).toBeDefined();
        expect(fromBarrel.LedgerEntryRecorded).toBe(
          fromModule.LedgerEntryRecorded,
        );
      }),
  );

  it.effect.skip(
    "[REQ-EVT-07] is field-compatible with LedgerEntry (entryId↔id, occurredAt↔createdAt, same amount type)",
    () =>
      Effect.gen(function* () {
        const LedgerEntryRecorded = yield* Effect.promise(loadFromBarrel);
        const { LedgerEntry } = (yield* Effect.promise(
          () => import(barrelSpecifier),
        )) as { LedgerEntry: typeof import("../src/ledger.js").LedgerEntry };
        // The event is a typed subset/mirror of the persisted LedgerEntry: an
        // entry's id/accountId/amount/createdAt map onto the event's
        // entryId/accountId/amount/occurredAt. A value derived from a decoded
        // LedgerEntry must decode as a LedgerEntryRecorded unchanged.
        const entry = yield* Schema.decodeUnknown(LedgerEntry)({
          id: "led_1f3c2b6a-9d44-4e0a-8c21-2b9a0f5e7d31",
          accountId: "acc-evt-1",
          amount: 700,
          type: "topup",
          idempotencyKey: "topup_k1",
          createdAt: "2026-06-21T12:00:00.000Z",
        });
        const event = yield* Schema.decodeUnknown(LedgerEntryRecorded)({
          entryId: entry.id,
          accountId: entry.accountId,
          amount: entry.amount,
          occurredAt: entry.createdAt,
        });
        expect(event.entryId).toBe(entry.id);
        expect(event.occurredAt).toBe(entry.createdAt);
        expect(event.amount).toBe(entry.amount);
        expect(event.accountId).toBe(entry.accountId);
      }),
  );
});
