# Obol Constitution

> Invariante Regeln. Änderungen nur via CODEOWNERS-Approval (Säule 2).

## Daten
- Das Ledger (`ledger_entry`) ist **append-only**: niemals `UPDATE`/`DELETE`. Korrekturen
  ausschließlich als neue `adjustment`-Einträge.
- Jede Geld-Operation ist **idempotent** über `idempotency_key` (unique constraint erzwungen).
- Migrationen sind Expand-Contract; destruktive DDL nie in einem Schritt.

## Verifikation
- Tests/CI-Config/Thresholds/diese Datei sind geschützt (CODEOWNERS + separates Approval).
- Coverage- und Mutation-Score sind **Ratchets** (nur steigend).
- Jedes EARS-Akzeptanzkriterium trägt eine ID der Form `REQ-<CONTEXT>-<nr>` (z.B. `REQ-BAL-01`) und
  **muss von mindestens einem Test referenziert werden** (ID im Test-Namen). Das `trace`-Gate erzwingt
  beide Richtungen: kein ungetestetes Kriterium, keine verwaiste Test-Referenz auf ein nicht
  existierendes Kriterium. So wird Spec-Drift **laut** statt still — ein Kriterium, dem der Code
  davonläuft, hinterlässt einen roten Test, statt unbemerkt zu veralten.
- Der Agent committet via Branch+PR, **mergt nicht** und umgeht keine Gates (`--no-verify` wirkungslos,
  Gates laufen server-seitig).

## Risiko-Tier
- Das Tier wird **deterministisch aus den berührten Pfaden** abgeleitet (siehe `tools/tier-map.json`),
  nie vom Agenten gewählt. Berührung von `services/*/migrations/**`, Auth-Code oder `packages/contracts/**`
  ⇒ automatisch **T3**.

## Tech-Constraints
- **Effect-TS Zielversion: `effect@3.x`** (exakte Version aus `pnpm-lock.yaml`). Keine v4-APIs.
- Boundary-Validierung mit `effect/Schema` („LLM at the edge, deterministic core").
- Feature-Verhalten gehört in `spec.md` (EARS), nicht in den Code; Flag-Mechanik (Unleash + Ramp +
  Auto-Rollback) gehört in diese Constitution; **Flags werden nach Rollout abgebaut**.

## Sicherheit
- Der Agent hält **keine echten Secrets** und **keine Prod-DDL-Credentials**. Prod-Apply läuft über
  einen getrennten, bewachten Prozess.
- Der Agent ist kein Sonderfall: gleiches RBAC/Audit wie ein (potenziell kompromittierter) User.
