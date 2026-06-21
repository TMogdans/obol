import { NodeContext } from "@effect/platform-node";
import { FileSystem } from "@effect/platform/FileSystem";
import { Path } from "@effect/platform/Path";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgMigrator from "@effect/sql-pg/PgMigrator";
import type { Loader, ResolvedMigration } from "@effect/sql/Migrator";
import { MigrationError } from "@effect/sql/Migrator";
import { SqlClient } from "@effect/sql/SqlClient";
import type { SqlError } from "@effect/sql/SqlError";
import { Config, Effect, Layer, Redacted } from "effect";
import type { ConfigError } from "effect/ConfigError";

/**
 * Absolute path to the directory holding the raw `.sql` migration files.
 * Resolved relative to this compiled module so it works from `dist/`. Mirrors
 * `wallet-service/src/db.ts` (REQ-STMT-05: the persistence layer follows the
 * established migration pattern).
 */
const migrationsDirectory = new URL("../migrations", import.meta.url).pathname;

/**
 * PgClient layer driven entirely by environment configuration:
 *   PGDATABASE / PGHOST / PGPORT / PGUSER / PGPASSWORD
 *
 * `layerConfig` takes a `Config.Config.Wrap<PgClientConfig>`, so each field is
 * itself a `Config`. The password is wrapped in `Config.redacted` to keep it out
 * of logs/traces. No connection is opened at construction time — only when the
 * layer is built and the client is first used (REQ-STMT-05).
 *
 * Each field carries a local-dev `withDefault`, so BUILDING the layer never
 * fails on a missing env var — a connection is attempted only when a query
 * actually runs. This lets the always-on `GET /health` endpoint (which never
 * touches the DB) be served without any PG env present, while a real read/append
 * path still uses the env-provided coordinates (env takes precedence over the
 * default; the Testcontainers integration tests set all five). In production the
 * deployment supplies the env; the defaults are a dev convenience, not a silent
 * connection to a real database (the localhost default simply fails to connect
 * if nothing is listening).
 */
export const DbLive: Layer.Layer<
  PgClient.PgClient | SqlClient,
  ConfigError | SqlError
> = PgClient.layerConfig({
  database: Config.string("PGDATABASE").pipe(Config.withDefault("postgres")),
  host: Config.string("PGHOST").pipe(Config.withDefault("localhost")),
  port: Config.integer("PGPORT").pipe(Config.withDefault(5432)),
  username: Config.string("PGUSER").pipe(Config.withDefault("postgres")),
  password: Config.redacted("PGPASSWORD").pipe(
    Config.withDefault(Redacted.make("postgres")),
  ),
});

/**
 * Custom migration loader for raw `.sql` files.
 *
 * The built-in `Migrator.fromFileSystem` only loads `NNNN_name.(js|ts)` modules
 * that default-export an Effect — it does NOT read `.sql` files. This loader
 * reads every `NNNN_name.sql` file in the migrations directory and, for each,
 * produces a `load` Effect that executes the file's contents via `sql.unsafe`.
 * It is the same loader shape the wallet-service uses; here it runs
 * `0001_statement_projection.sql` (REQ-STMT-05).
 *
 * Requires `FileSystem` and `Path` (from `@effect/platform`) in context;
 * supplied below by baking `NodeContext.layer` into `MigratorLive`.
 */
const sqlFileLoader = (directory: string): Loader<FileSystem | Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;

    const entries = yield* fs
      .readDirectory(directory)
      .pipe(
        Effect.mapError(
          (error) =>
            new MigrationError({ reason: "failed", message: error.message }),
        ),
      );

    const migrations: Array<ResolvedMigration> = [];
    for (const entry of entries) {
      const match = entry.match(/^(\d+)_([^.]+)\.sql$/);
      if (match === null) continue;
      const [, rawId, name] = match;
      if (rawId === undefined || name === undefined) continue;

      const filePath = path.join(directory, entry);

      // A `ResolvedMigration`'s third element is a `load` Effect that must
      // *resolve to* the migration Effect — the Migrator engine runs `load`,
      // then runs the Effect it yields. So `load` reads the file and SUCCEEDS
      // WITH the SQL-executing Effect; it must not run the SQL itself.
      const load = fs.readFileString(filePath).pipe(
        Effect.mapError(
          (error) =>
            new MigrationError({
              reason: "failed",
              message: error.message,
            }),
        ),
        Effect.map((contents) =>
          Effect.flatMap(SqlClient, (sql) => sql.unsafe(contents)),
        ),
      );

      migrations.push([Number(rawId), name, load]);
    }

    return migrations.sort(([a], [b]) => a - b);
  });

/**
 * Migrator layer. Runs all pending raw-SQL migrations on build, so building this
 * layer applies `0001_statement_projection.sql` against a fresh DB (REQ-STMT-05).
 *
 * `provide(DbLive)` satisfies the `SqlClient` requirement; the loader's
 * `FileSystem | Path` (and `PgMigrator`'s `CommandExecutor`) are satisfied here
 * by baking in `NodeContext.layer`. Unlike the wallet-service's `MigratorLive`
 * (which leaves those open for each test to provide), the statement-service
 * tests merge `MigratorLive` directly — `Layer.mergeAll(MigratorLive, DbLive)` —
 * without supplying `NodeContext`, so this layer is self-contained and requires
 * `never`.
 */
export const MigratorLive: Layer.Layer<
  never,
  SqlError | MigrationError | ConfigError
> = PgMigrator.layer({ loader: sqlFileLoader(migrationsDirectory) }).pipe(
  Layer.provide(DbLive),
  Layer.provide(NodeContext.layer),
);
