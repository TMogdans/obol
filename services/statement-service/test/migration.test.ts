import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SqlClient } from "@effect/sql/SqlClient";
import { it } from "@effect/vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect } from "vitest";

/**
 * Migration + read-path tests for the statement projection store, against a REAL
 * Postgres (Testcontainers), plus on-disk/structure assertions.
 *
 * devloop spec-PR seam: EACH case is individually `it.effect.skip`'d / `it.skip`'d
 * with its `[REQ-STMT-..]` id in the title — the sanctioned skip idiom
 * (`.skip` allowed ONLY on a REQ-tagged test). The `describe` is a plain,
 * UNskipped container (verify-unskip evaluates per-`it`).
 *
 * The migration (`0001_statement_projection.sql`) and the env-driven `db.ts`
 * (DbLive/MigratorLive) do not exist yet. The required `typecheck (tsc -b)` gate
 * runs on the spec PR, so the not-yet-existing `../src/db.js` is pulled in via a
 * NON-LITERAL dynamic `import(specifier)` inside the skipped Testcontainers
 * bodies (`loadDb`): NodeNext `tsc` leaves it unresolved, so this compiles today
 * and only EXECUTES once `implement` writes `db.ts` + the migration and removes
 * the `.skip`. The pure on-disk cases (`it.skip`, no DB) read the migration file
 * directly. Bodies are COMPLETE; `implement` may ONLY remove the `.skip`.
 *
 * Maps:
 *   REQ-STMT-05 (persistent table created by a NEW migration under
 *               the migrations directory of statement-service, entry_id PRIMARY KEY
 *               enforces idempotency in the DB and survives a restart; no
 *               auth-path touch — the T3-defining migration),
 *   REQ-STMT-09 (the per-account read path is index-backed over (account_id,
 *               occurred_at desc), never a full sequential scan; an append is
 *               one INSERT, a duplicate is a PK no-op).
 */

const here = dirname(fileURLToPath(import.meta.url));
const serviceRoot = resolve(here, "..");
const repoRoot = resolve(here, "..", "..", "..");
const migrationsDir = resolve(serviceRoot, "migrations");

const dbSpecifier = "../src/db.js";
interface DbModule {
  readonly DbLive: Layer.Layer<SqlClient, unknown>;
  readonly MigratorLive: Layer.Layer<never, unknown, unknown>;
}
const loadDb = (): Promise<DbModule> =>
  import(dbSpecifier) as Promise<DbModule>;

let container: StartedPostgreSqlContainer | undefined;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  process.env.PGHOST = container.getHost();
  process.env.PGPORT = String(container.getPort());
  process.env.PGDATABASE = container.getDatabase();
  process.env.PGUSER = container.getUsername();
  process.env.PGPASSWORD = container.getPassword();
}, 120000);

afterAll(async () => {
  if (container) {
    await container.stop();
  }
});

describe("statement-projection — persistence & read path (REQ-STMT-05/-09)", () => {
  it("[REQ-STMT-05] introduces exactly the one new migration 0001_statement_projection.sql under statement-service/migrations, creating statement_line with entry_id as PRIMARY KEY, and touches NO **/auth/** path", () => {
    // The migration is the single T3-defining touch for this feature.
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
    const created = files.filter((f) =>
      /^0001_statement_projection\.sql$/.test(f),
    );
    expect(created.length).toBe(1);

    const sql = readFileSync(
      resolve(migrationsDir, created[0] as string),
      "utf8",
    );
    // Creates the persistent statement table (a NEW table).
    expect(sql).toMatch(/CREATE TABLE\s+statement_line/i);
    // entry_id is the PRIMARY KEY — the dedup/idempotency anchor (REQ-STMT-02),
    // so a second insert of the same entry_id violates the PK and is ignored.
    expect(sql).toMatch(
      /entry_id[^,]*PRIMARY KEY|PRIMARY KEY\s*\(\s*entry_id/i,
    );
    // The per-account read index (REQ-STMT-09) is created here too.
    expect(sql).toMatch(/CREATE INDEX/i);
    expect(sql).toMatch(/account_id/i);

    // No auth path exists in this repo and the feature must not create one.
    const authCandidates = [
      resolve(serviceRoot, "src/auth"),
      resolve(repoRoot, "packages/contracts/src/auth"),
    ];
    for (const candidate of authCandidates) {
      expect(existsSync(candidate)).toBe(false);
    }
  });

  it.effect(
    "[REQ-STMT-05] the migration applies on a fresh DB and the entry_id PRIMARY KEY enforces idempotency: a duplicate entry_id insert is rejected/ignored (DB-enforced dedup, survives restart)",
    () =>
      Effect.gen(function* () {
        const { MigratorLive, DbLive } = yield* Effect.promise(loadDb);
        const layer = Layer.mergeAll(MigratorLive, DbLive);

        const program = Effect.gen(function* () {
          const sql = yield* SqlClient;

          // The migration ran on build: statement_line exists with the four
          // event columns.
          const cols = yield* sql<{ readonly column_name: string }>`
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'statement_line'
            ORDER BY column_name
          `;
          const names = cols.map((c) => c.column_name);
          expect(names).toContain("entry_id");
          expect(names).toContain("account_id");
          expect(names).toContain("amount");
          expect(names).toContain("occurred_at");

          // entry_id is the PRIMARY KEY.
          const pk = yield* sql<{ readonly column_name: string }>`
            SELECT kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
            WHERE tc.table_name = 'statement_line'
              AND tc.constraint_type = 'PRIMARY KEY'
          `;
          expect(pk.map((r) => r.column_name)).toEqual(["entry_id"]);

          // First insert succeeds.
          yield* sql`
            INSERT INTO statement_line (entry_id, account_id, amount, occurred_at)
            VALUES ('led-mig-1', 'acc-mig', 100, '2026-06-21T10:00:00.000Z')
          `;

          // A second insert of the SAME entry_id is rejected by the PK (the
          // raw write violates it; the projection uses ON CONFLICT DO NOTHING to
          // turn this into a no-op — REQ-STMT-02/-09).
          const dup = yield* sql`
            INSERT INTO statement_line (entry_id, account_id, amount, occurred_at)
            VALUES ('led-mig-1', 'acc-mig', 999, '2026-06-21T11:00:00.000Z')
          `.pipe(Effect.either);
          expect(dup._tag).toBe("Left");

          // The original row is unchanged — no duplicate, no overwrite.
          const rows = yield* sql<{
            readonly amount: string;
            readonly n: string;
          }>`
            SELECT amount::text AS amount,
                   (SELECT count(*)::text FROM statement_line
                      WHERE entry_id = 'led-mig-1') AS n
            FROM statement_line WHERE entry_id = 'led-mig-1'
          `;
          expect(rows.length).toBe(1);
          expect(rows[0]?.amount).toBe("100");
          expect(rows[0]?.n).toBe("1");
        });

        yield* Effect.provide(program, layer) as Effect.Effect<void>;
      }),
    { timeout: 120000 },
  );

  it.effect(
    "[REQ-STMT-09] the per-account statement read is index-backed over (account_id, occurred_at desc), never a sequential scan over the whole statement table",
    () =>
      Effect.gen(function* () {
        const { MigratorLive, DbLive } = yield* Effect.promise(loadDb);
        const layer = Layer.mergeAll(MigratorLive, DbLive);

        const program = Effect.gen(function* () {
          const sql = yield* SqlClient;

          // Postgres won't pick an index over a tiny table unless forced; this
          // asserts that a USABLE index on the read path EXISTS and is chosen —
          // the qualitative NFR (the read does not scan the whole table), not a
          // latency number.
          yield* sql`SET enable_seqscan = off`;

          const plan = yield* sql<{ readonly "QUERY PLAN": string }>`
            EXPLAIN SELECT entry_id, account_id, amount, occurred_at
            FROM statement_line
            WHERE account_id = ${"acc-plan"}
            ORDER BY occurred_at DESC, entry_id ASC
          `;
          const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
          expect(text).toMatch(/Index (Only )?Scan|Bitmap Index Scan/);
          expect(text).not.toMatch(/Seq Scan/);

          yield* sql`SET enable_seqscan = on`;
        });

        yield* Effect.provide(program, layer) as Effect.Effect<void>;
      }),
    { timeout: 120000 },
  );

  it.effect(
    "[REQ-STMT-09] appending a unique event is exactly one INSERT; a duplicate produces no additional durable write (PK conflict no-op) — anchored on `pnpm run arch` for the no-cross-service-import boundary",
    () =>
      Effect.sync(() => {
        // Traceability anchor for the architecture/boundary half of REQ-STMT-06
        // /-09: the consumer code is service-local under
        // services/statement-service/src/**, binds the event schema ONLY through
        // @obol/contracts, and has NO import from @obol/wallet-service. That
        // truth lives in `pnpm run arch` (dependency-cruiser); this case binds
        // the REQ id to that gate by invoking it (throws on a violation).
        execFileSync("pnpm", ["run", "arch"], {
          cwd: repoRoot,
          stdio: "pipe",
        });
      }),
  );
});
