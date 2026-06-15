import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { FileSystem } from "@effect/platform/FileSystem";
import { Path } from "@effect/platform/Path";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgMigrator from "@effect/sql-pg/PgMigrator";
import type { Loader, ResolvedMigration } from "@effect/sql/Migrator";
import { MigrationError } from "@effect/sql/Migrator";
import { SqlClient } from "@effect/sql/SqlClient";
import type { SqlError } from "@effect/sql/SqlError";
import { Config, Effect, Layer } from "effect";
import type { ConfigError } from "effect/ConfigError";

/**
 * Absolute path to the directory holding the raw `.sql` migration files.
 * Resolved relative to this compiled module so it works from `dist/`.
 */
const migrationsDirectory = new URL("../migrations", import.meta.url).pathname;

/**
 * PgClient layer driven entirely by environment configuration:
 *   PGDATABASE / PGHOST / PGPORT / PGUSER / PGPASSWORD
 *
 * `layerConfig` takes a `Config.Config.Wrap<PgClientConfig>`, so each field is
 * itself a `Config`. The password is wrapped in `Config.redacted` to keep it out
 * of logs/traces. No connection is opened at construction time — only when the
 * layer is built and the client is first used.
 */
export const DbLive: Layer.Layer<
  PgClient.PgClient | SqlClient,
  ConfigError | SqlError
> = PgClient.layerConfig({
  database: Config.string("PGDATABASE"),
  host: Config.string("PGHOST"),
  port: Config.integer("PGPORT"),
  username: Config.string("PGUSER"),
  password: Config.redacted("PGPASSWORD"),
});

/**
 * Custom migration loader for raw `.sql` files.
 *
 * The built-in `Migrator.fromFileSystem` only loads `NNNN_name.(js|ts)` modules
 * that default-export an Effect — it does NOT read `.sql` files. This loader
 * reads every `NNNN_name.sql` file in the migrations directory and, for each,
 * produces a `load` Effect that executes the file's contents via `sql.unsafe`.
 *
 * Requires `FileSystem` and `Path` (from `@effect/platform`) in context; the
 * runtime that builds `MigratorLive` must provide those (e.g. `NodeContext.layer`
 * from `@effect/platform-node`). This is the responsibility of Task 4.
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
      const load = Effect.flatMap(
        fs.readFileString(filePath).pipe(
          Effect.mapError(
            (error) =>
              new MigrationError({
                reason: "failed",
                message: error.message,
              }),
          ),
        ),
        (contents) => Effect.flatMap(SqlClient, (sql) => sql.unsafe(contents)),
      );

      migrations.push([Number(rawId), name, load]);
    }

    return migrations.sort(([a], [b]) => a - b);
  });

/**
 * Migrator layer. Runs all pending raw-SQL migrations on build. Depends on the
 * `SqlClient` (provided by `DbLive`) plus `FileSystem | Path` from the loader.
 *
 * `provide(DbLive)` satisfies the `SqlClient` requirement here; the remaining
 * `FileSystem | Path | CommandExecutor` requirements are left open for the
 * caller to provide. `NodeContext.layer` from `@effect/platform-node` supplies
 * all three — that wiring belongs to Task 4.
 */
export const MigratorLive: Layer.Layer<
  never,
  SqlError | MigrationError | ConfigError,
  FileSystem | Path | CommandExecutor
> = PgMigrator.layer({ loader: sqlFileLoader(migrationsDirectory) }).pipe(
  Layer.provide(DbLive),
);
