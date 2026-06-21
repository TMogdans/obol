# Spec: Guthaben aufladen (wallet-topup)

Tier: T2

## User Story
Als Konto-Inhaber will ich Guthaben aufladen, damit mein Saldo steigt. Ein Topup
ist der erste money-shaped Schreibpfad: er *hängt* genau einen positiven
`ledger_entry` an (append-only, keine Mutation) und der neue Saldo ergibt sich —
wie überall — aus der Aggregation der Einträge.

## Akzeptanzkriterien (EARS)
- **[REQ-TOP-01]** *(When)* **When** ein `POST /accounts/{id}/credit` mit
  `amount > 0` für ein existierendes Konto erfolgt, **shall** das System genau
  **einen** `ledger_entry` mit `account_id = {id}`, diesem `amount` und
  `type = 'topup'` anhängen und den **neuen Saldo** zurückgeben.
- **[REQ-TOP-02]** *(If/Then)* **If** `amount <= 0` (inkl. `0`), **then shall**
  das System `400` liefern und **keinen** `ledger_entry` schreiben. Die Prüfung
  greift am Decode-Rand (`Schema.Int` + positiv), bevor der Handler läuft — wie
  die `ownerId`-Nichtleere bei REQ-ACC-04.
- **[REQ-TOP-03]** *(If/Then)* **If** das Konto nicht existiert, **then shall**
  das System `404` mit dem strukturierten Fehler `AccountNotFound`
  (`_tag` + `accountId`) liefern und **keinen** Eintrag schreiben — derselbe
  Fehler wie REQ-BAL-02 / REQ-ACCD-03.
- **[REQ-TOP-04]** *(When)* **When** der neue Saldo zurückgegeben wird, **shall**
  er als `{ accountId, balance }` geliefert werden (dieselbe Body-Form wie die
  `balance-query`, REQ-BAL-01) und genau der Aggregation aller `ledger_entry` des
  Kontos via `projectBalance` entsprechen — der Topup berechnet den Saldo
  **nicht** separat, sondern liest ihn nach dem Append aus der Projektion.
- **[REQ-TOP-05]** *(While)* **While** der Eintrag angehängt wird, **shall** das
  System die Domain append-only halten: **kein** `UPDATE`/`DELETE` bestehender
  Einträge, ausschließlich `INSERT` in `ledger_entry`. (Die Engine erzwingt dies
  zusätzlich über `ledger_no_update`/`ledger_no_delete`, Migration 0001 —
  bestehend, **nicht** berührt.)
- **[REQ-TOP-06]** *(Contract/Architektur)* **Where** der Request-Body
  definiert wird, **shall** er nur `{ amount }` umfassen; `type` ist **nicht**
  Teil der Request-Oberfläche, sondern server-gesetzt auf `'topup'` (analog zur
  server-gesetzten `currency` bei REQ-ACC). `{id}` bleibt opaker Pfad-String,
  kein Format-Check (REQ-ACCD-08).
- **[REQ-TOP-07]** *(If/Then)* **If** beim Existenz-Check, beim Append oder beim
  Saldo-Lesen ein `SqlError` auftritt, **then shall** das System dies als
  500-Defekt behandeln (`orDie` / `Effect.die`) und **nicht** als typisierten
  Client-Fehler ausweisen; der einzige typisierte Fehler bleibt
  `AccountNotFound` — ein DB-Fehler darf sich **nicht** als fehlendes Konto
  tarnen (wie REQ-ACCD-04).
- **[REQ-TOP-08]** *(Architektur)* **Where** Response-Typ (neuer Saldo),
  Request-Typ (`{ amount }`) und das Append-Repository definiert werden,
  **shall** alles **lokal** in `services/wallet-service/src/` liegen — kein Touch
  von `packages/contracts`, kein neuer Migrations-File (die `ledger_entry`-Tabelle
  inkl. `type='topup'` und `uq_ledger_idempotency` existiert bereits aus
  Migration 0001), kein `**/auth/**`. Damit bleibt das Tier **T2** (nicht T3).
- **[REQ-TOP-09]** *(Performance)* **Where** der neue Eintrag geschrieben wird,
  **shall** der `account_id` über den bestehenden Index `idx_ledger_account`
  bedient werden und der Existenz-Check über den PK-Lookup `WHERE id = …`
  (`accountExists`) laufen — keine zusätzliche Scan-Last (qualitativ, keine
  harten NFR-Zahlen).

## Out of Scope
- **Idempotenz des Topups.** Die `ledger_entry`-Tabelle hat zwar
  `uq_ledger_idempotency` und eine `idempotency_key`-Spalte (Migration 0001), aber
  ein `Idempotency-Key`-Header-Vertrag für `credit` (Replay-Semantik wie bei
  `POST /accounts`) ist eine **eigene** spätere Spec. Diese Spec schreibt einen
  Eintrag pro erfolgreichem Request; wie `idempotency_key` befüllt wird, ohne den
  Unique-Constraint zu verletzen, ist Implementierungsdetail, **kein** Replay-
  Vertrag und hier nicht abgenommen.
- **Spend / negative Beträge / `adjustment`.** Nur positives Aufladen
  (`type = 'topup'`). Der Abzugspfad ist eine eigene Spec.
- **Multi-Currency / Währungsumrechnung.** `amount` ist eine Minor-Unit-Zahl in
  der gespeicherten Konto-Währung; keine Konvertierung.
- **Overflow jenseits `Number.MAX_SAFE_INTEGER`.** Die `bigint`→`number`-Grenze
  ist im Repo dokumentiert (siehe `BalanceRepo`); der Referenz-Invariant bleibt
  „Beträge passen in den safe-integer-Bereich“.
- **Authentifizierung / Autorisierung.** Kein Owner-Check, wer aufladen darf.
- **Validierung des `id`-Formats.** Bewusst opaker String (REQ-ACCD-08).
- **Schema-/DB-Änderungen.** Keine neue Migration; die Append-Semantik nutzt das
  bestehende `ledger_entry`-Schema.
