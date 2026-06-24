# Obol

Obol is a reference implementation of a **cage** for agentic software development: a system that lets
autonomous coding agents produce *verifiably* good software. The premise is that quality does not come
from the generator (the model) but from the **system around it** — incorruptible CI gates plus explicit,
machine-checkable intent. An agent inside this cage can write code freely, but it cannot merge anything
that fails a gate, cannot weaken a gate without separate human approval, and cannot choose its own risk
classification. The domain it demonstrates this on is deliberately small and unforgiving: an append-only
**credits wallet / ledger**, where a wrong balance is an obvious, money-shaped bug.

## Stack

- **pnpm** workspace monorepo (`pnpm@11`, Node 22+)
- **TypeScript**, strict, composite project references (`tsc -b`)
- **Effect-TS v3** (`effect@3.x`) — `effect/Schema` for boundary validation ("LLM at the edge,
  deterministic core"), `@effect/platform` for HTTP, `@effect/sql-pg` for Postgres
- **Postgres** for the append-only ledger
- **vitest** + **@vitest/coverage-v8** for tests and coverage
- **Testcontainers** for real-Postgres integration and migration tests (no mocks at the DB boundary)

## Layout

```
.
├── packages/
│   └── contracts/          effect/Schema domain types (Account, LedgerEntry) — the shared contract
├── services/
│   ├── wallet-service/      append-only ledger: schema + migrator, balance projection,
│   │                        HTTP GET /accounts/:id/balance + /health, telemetry
│   └── statement-service/   skeleton (/health); will consume NATS events in a later phase
├── tools/                   deterministic risk-tier derivation + semgrep escape-hatch rules
├── .specify/                SDD artifacts: constitution.md + specs/<feature>/spec.md (EARS)
└── .github/
    ├── workflows/ci.yml     the gate suite (one required job per gate)
    └── CODEOWNERS           the protected verification set
```

## Getting started

**Prerequisites**

- Node **22+** (`.nvmrc` pins the version)
- **pnpm** via Corepack (`corepack enable`)
- **Docker** or **OrbStack** running — the test gate spins up Postgres via Testcontainers

**Install**

```bash
pnpm install
```

**Gates** — every command below is also a required CI job. Run them locally before pushing:

```bash
pnpm run typecheck      # tsc -b across all projects (tests are typechecked too)
pnpm run lint           # biome check
pnpm run knip           # dead code / unused dependencies
pnpm run test           # vitest + coverage; includes Testcontainers integration tests (needs Docker)
pnpm run mutation       # Stryker mutation testing on the pure balance projection
pnpm run twin           # greenfield digital twin: real service vs. reference model (needs Docker)
pnpm run arch           # dependency-cruiser: no cross-service imports, no cycles, no orphans
pnpm run migrations     # squawk: lint SQL migrations for unsafe DDL
pnpm run tier -- <path> # deterministic risk tier of a changeset (prints T1/T2/T3)
```

## The cage

This is the interesting part. The wallet domain is just a vehicle; the point is the verification system
that an agent operates inside. The invariant rules it enforces live in
[`.specify/constitution.md`](.specify/constitution.md) (in German), and every gate exists to make one of
those rules un-bypassable.

**Intent is an artifact, not a prompt.** Feature behavior is written first as an EARS spec
(`.specify/specs/<feature>/spec.md`) — e.g. the balance query's `200`/`404`/empty-ledger rules. The code
is judged against that intent, and the constitution constrains *how* the code may be built (append-only
ledger, idempotent money operations, expand-contract migrations, `effect@3.x` only).

**The gates and why each exists:**

| Gate | Tool | Why it bites |
| --- | --- | --- |
| `typecheck` | `tsc -b` | Strict types across the whole graph. **Test files are typechecked too**, so a test cannot quietly drift from the types it claims to exercise. |
| `lint` | biome | Consistent, mechanical style — removes a whole class of review noise. |
| `knip` | knip | Dead code and unused dependencies are where unverified surface area hides. Kept at zero. |
| `test` + coverage | vitest + Testcontainers | Behavior is verified against the spec on a **real Postgres**, not a mock. Coverage thresholds are **ratchets** (only ever raised). |
| `mutation` | Stryker | The `assert(true)` killer: it mutates the code and checks the tests *fail*. A test suite that passes against broken code is worthless; mutation testing proves the tests actually constrain behavior. |
| `twin` | fast-check + Testcontainers | The independent oracle (Säule 4): the **real** wallet-service is run against a trivial reference model over thousands of generated money-core sequences, comparing status + balance after every step. Derived from domain truths, not the spec or the code — it catches behaviour the spec-derived example tests structurally miss (e.g. the balance *after* a rejected spend). Threshold: **null divergence**. |
| `arch` | dependency-cruiser | No service imports another service's source — cross-service sharing goes through `packages/contracts` only. No cycles, no orphans. |
| `escape-hatches` | semgrep | The guard of the guards. ERRORs on the common ways verification gets silently defeated: `.skip`/`.only`/`.todo`, `@ts-expect-error`/`@ts-ignore`, `biome-ignore`, and `--no-verify`. The project `.semgrepignore` keeps **test files in scope** (semgrep would otherwise skip `*.test.ts`), so you can't hide an escape hatch in a test. |
| `migrations` | squawk | SQL migrations are linted for unsafe/destructive DDL before they can land. |
| `tier` | `tools/derive-tier.ts` | Derives the change's **risk tier** deterministically from the touched paths. |

**Deterministic risk tiers.** The tier of a change is computed from the paths it touches
([`tools/tier-map.json`](tools/tier-map.json)), never self-declared by the agent. The highest matching
tier wins ("upgrade-wins"): touching `services/*/migrations/**`, auth code, `packages/contracts/**`, or
`tools/**` forces **T3**, and no lower-tier match can pull it back down. T3 changes require a CODEOWNER
review; the agent cannot lower its own risk classification.

**CODEOWNERS guards the verification set.** Every file that defines *how* the repo is verified — the CI
workflow, each gate's config, the constitution, the tier map, and CODEOWNERS itself — is owned by the
repo owner ([`.github/CODEOWNERS`](.github/CODEOWNERS)). Paired with branch protection's "Require review
from Code Owners", lowering a threshold or disabling a check needs *separate, human* approval. The agent
commits via branch + PR, never merges, and gates run server-side so `--no-verify` is inert.

**Honest scope.** Mutation testing currently validates the *technique* on the pure balance projection
(`projectBalance`), not the whole repo — `break` is set to 100% there so any surviving mutant fails CI.
It is a proof that the dial is wired up and biting, with the mutated surface to be widened as the domain
grows.

## Status

- **Phase 0 — done.** The cage and a walking skeleton: monorepo + strict TS + Effect, the
  `packages/contracts` domain types, the append-only ledger schema + migrator + balance projection, the
  `GET /accounts/:id/balance` and `/health` endpoints, telemetry wiring, the SDD artifacts, the full
  (verified, biting) gate suite, and deterministic tier derivation.
- **Phase 1 — next.** Top-up (T2) emitting a NATS event consumed by `statement-service`; spend (T3) with
  auth and an expand-contract migration.

## Verified baseline

The full gate suite is green. Latest local run:

- coverage — statements **96.59%**, branches **90.9%**, functions **100%**, lines **96.59%** (26 tests, 9 files)
- mutation — **100.00%** mutation score on the balance projection (3/3 mutants killed; break threshold 100 met)
