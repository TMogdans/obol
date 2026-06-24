import { HttpClient, HttpClientRequest } from "@effect/platform";
import { NodeContext, NodeHttpServer } from "@effect/platform-node";
import { SqlClient } from "@effect/sql/SqlClient";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Effect, Layer, ManagedRuntime } from "effect";
import { DbLive, MigratorLive } from "../src/db.js";
import { WalletApiLive } from "../src/main.js";
import type { Command, Outcome, System } from "./spi.js";

/**
 * The wallet System adapter (Phase-1 design §4, decision D1).
 *
 * The Twin runs against the REAL wallet-service over Testcontainers-Postgres —
 * NOT an in-memory fake. The design is explicit about why: the most instructive
 * Obol bugs (the migrator, the append-only DDL — blog part 3) were caught ONLY
 * by the runtime against real Postgres; an in-memory twin would have missed
 * exactly those. Cost is bounded by ONE container for the whole property run,
 * with a TRUNCATE between sequences.
 *
 * Lifecycle: `setup()` starts + migrates the container ONCE and builds a
 * long-lived {@link ManagedRuntime} that holds the ephemeral HTTP test server
 * (an `HttpClient` pointed at it) plus a `SqlClient`. Each fast-check sequence
 * calls `reset()` (truncate) so it starts from an empty ledger. `execute()`
 * drives the REAL HTTP routes; `observeBalance()` is the independent boundary
 * read for the "compare after every step" cross-validation; `observeEntryCount()`
 * is the append-only structural probe (I3). `teardown()` disposes both.
 *
 * Requests use the raw `HttpClient` (string path + JSON body, no typed client)
 * so a non-2xx is an OBSERVATION (`res.status`), never a thrown client error —
 * the same adversarial posture the integration tests take.
 */

/** The served wallet api bound to an ephemeral test port + an HttpClient. */
const ServerLive = WalletApiLive.pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
);

/** Migrator (run on build) + a raw SqlClient for reset / structural probes. */
const SqlLive = Layer.mergeAll(
  MigratorLive.pipe(Layer.provide(NodeContext.layer)),
  DbLive,
);

/** Everything the runtime exposes: HttpClient (server) + SqlClient (db). */
const AppLive = Layer.mergeAll(ServerLive, SqlLive);

type AppRuntime = ManagedRuntime.ManagedRuntime<
  Layer.Layer.Success<typeof AppLive>,
  Layer.Layer.Error<typeof AppLive>
>;

/** Success body shapes the boundary returns; read only on the relevant 2xx. */
interface BalanceBody {
  readonly accountId: string;
  readonly balance: number;
}
interface AccountBody {
  readonly id: string;
}

export class WalletSystem implements System {
  private container: StartedPostgreSqlContainer | undefined;
  private runtime: AppRuntime | undefined;

  /** Guard that the runtime is built before use (avoids a non-null assertion). */
  private get rt(): AppRuntime {
    if (this.runtime === undefined) {
      throw new Error("WalletSystem.setup() was not called");
    }
    return this.runtime;
  }

  async setup(): Promise<void> {
    this.container = await new PostgreSqlContainer(
      "postgres:16-alpine",
    ).start();
    process.env.PGHOST = this.container.getHost();
    process.env.PGPORT = String(this.container.getPort());
    process.env.PGDATABASE = this.container.getDatabase();
    process.env.PGUSER = this.container.getUsername();
    process.env.PGPASSWORD = this.container.getPassword();

    this.runtime = ManagedRuntime.make(AppLive);
    // Force the layer graph to build now (this runs MigratorLive) and prove the
    // connection works, so a setup failure surfaces here, not mid-sequence.
    await this.rt.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`SELECT 1`;
      }),
    );
  }

  /**
   * Truncate all wallet tables so the next sequence starts empty. TRUNCATE is
   * NOT blocked by the append-only `ledger_no_delete` RULE (that intercepts
   * DELETE only), so it is the correct per-sequence reset. CASCADE handles the
   * outbox→entry→account FK chain in one statement.
   */
  async reset(): Promise<void> {
    await this.rt.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`TRUNCATE TABLE ledger_outbox, ledger_entry, account CASCADE`;
      }),
    );
  }

  execute(cmd: Command): Promise<Outcome> {
    return this.rt.runPromise(this.executeEffect(cmd));
  }

  private executeEffect(
    cmd: Command,
  ): Effect.Effect<Outcome, unknown, HttpClient.HttpClient> {
    return Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;

      if (cmd.kind === "open") {
        const res = yield* client.execute(
          HttpClientRequest.post("/accounts").pipe(
            HttpClientRequest.setHeader("idempotency-key", cmd.key),
            HttpClientRequest.bodyUnsafeJson({ ownerId: cmd.ownerId }),
          ),
        );
        if (res.status === 201 || res.status === 200) {
          const body = (yield* res.json) as AccountBody;
          return { status: res.status, accountId: body.id };
        }
        return { status: res.status };
      }

      if (cmd.kind === "topup" || cmd.kind === "spend") {
        const path = cmd.kind === "topup" ? "credit" : "debit";
        const res = yield* client.execute(
          HttpClientRequest.post(`/accounts/${cmd.accountId}/${path}`).pipe(
            HttpClientRequest.bodyUnsafeJson({ amount: cmd.amount }),
          ),
        );
        if (res.status === 200) {
          const body = (yield* res.json) as BalanceBody;
          return { status: 200, balance: body.balance };
        }
        return { status: res.status };
      }

      // query
      const res = yield* client.get(`/accounts/${cmd.accountId}/balance`);
      if (res.status === 200) {
        const body = (yield* res.json) as BalanceBody;
        return { status: 200, balance: body.balance };
      }
      return { status: res.status };
    });
  }

  /** Independent boundary balance read (design §4c): GET /accounts/:id/balance. */
  observeBalance(accountId: string): Promise<Outcome> {
    return this.execute({ kind: "query", accountId });
  }

  /** Append-only structural probe (I3): how many ledger rows the account holds. */
  observeEntryCount(accountId: string): Promise<number> {
    return this.rt.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const rows = yield* sql<{ readonly n: string }>`
          SELECT count(*)::text AS n FROM ledger_entry WHERE account_id = ${accountId}
        `;
        return Number(rows[0]?.n ?? "0");
      }),
    );
  }

  async teardown(): Promise<void> {
    if (this.runtime !== undefined) {
      await this.runtime.dispose();
      this.runtime = undefined;
    }
    if (this.container !== undefined) {
      await this.container.stop();
      this.container = undefined;
    }
  }
}
