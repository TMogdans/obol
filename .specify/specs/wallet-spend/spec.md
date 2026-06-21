# Spec: Guthaben abbuchen (wallet-spend)

Tier: T2

## User Story
Als Konto-Inhaber will ich Guthaben abbuchen (Debit), damit mein Saldo sinkt.
Ein Spend ist der spiegelbildliche money-shaped Schreibpfad zum Topup
(`wallet-topup`): er *hängt* genau einen **negativen** `ledger_entry`
(`type = 'spend'`) an (append-only, keine Mutation) und der neue Saldo ergibt
sich — wie überall — aus der Aggregation der Einträge (`projectBalance`). Die
harte Geschäftsinvariante: **der Saldo darf nie negativ werden** — eine Abbuchung
über den verfügbaren Saldo hinaus wird abgelehnt, **bevor** irgendein Eintrag
geschrieben wird.

## Akzeptanzkriterien (EARS)
- **[REQ-SPD-01]** *(When)* **When** ein `POST /accounts/{id}/debit` mit
  `amount > 0` und `amount <= aktuellem Saldo` für ein existierendes Konto
  erfolgt, **shall** das System genau **einen** `ledger_entry` mit
  `account_id = {id}`, `type = 'spend'` und dem **negierten** Betrag
  (`amount_stored = -amount`) anhängen und den **neuen Saldo** zurückgeben. Die
  Request-Oberfläche trägt `amount` als **positive** Minor-Unit-Zahl (Abbuchungs-
  *menge*); das Vorzeichen ist server-gesetztes Domänen-Detail, nicht Teil des
  Vertrags (analog zum server-gesetzten `type = 'topup'` bei REQ-TOP-06).
- **[REQ-SPD-02]** *(If/Then)* **If** `amount > aktuellem Saldo`, **then shall**
  das System `409` mit dem strukturierten Fehler `InsufficientFunds`
  (`_tag = "InsufficientFunds"` + `accountId`) liefern und **keinen**
  `ledger_entry` schreiben. Der verfügbare Saldo wird **vor** dem Append aus der
  Projektion gelesen; der Vergleich ist die Geschäftsinvariante „Saldo nie
  negativ" (Gleichheit `amount == Saldo` ist erlaubt und führt auf Saldo `0`).
- **[REQ-SPD-03]** *(If/Then)* **If** `amount <= 0` (inkl. `0` und negative /
  nicht-ganzzahlige Werte), **then shall** das System `400` liefern und
  **keinen** `ledger_entry` schreiben. Die Prüfung greift am Decode-Rand
  (`Schema.Int.pipe(Schema.positive())`), bevor der Handler läuft — derselbe
  Guard wie `CreditPayload` bei REQ-TOP-02. Der Request beschreibt eine
  **positive** Abbuchungsmenge; das negative Vorzeichen entsteht erst
  server-seitig (REQ-SPD-01).
- **[REQ-SPD-04]** *(If/Then)* **If** das Konto nicht existiert, **then shall**
  das System `404` mit dem strukturierten Fehler `AccountNotFound`
  (`_tag` + `accountId`) liefern und **keinen** Eintrag schreiben — derselbe
  Fehler / dieselbe Reihenfolge (Existenz-Check zuerst) wie REQ-TOP-03 /
  REQ-BAL-02 / REQ-ACCD-03.
- **[REQ-SPD-05]** *(When)* **When** der neue Saldo zurückgegeben wird, **shall**
  er als `{ accountId, balance }` geliefert werden (dieselbe Body-Form wie
  `balance-query` REQ-BAL-01 und `credit` REQ-TOP-04) und genau der Aggregation
  aller `ledger_entry` des Kontos via `projectBalance` entsprechen — der Spend
  berechnet den Saldo **nicht** separat (etwa `alterSaldo - amount`), sondern
  liest ihn **nach** dem Append aus der Projektion.
- **[REQ-SPD-06]** *(While)* **While** der Eintrag angehängt wird, **shall** das
  System die Domain append-only halten: **kein** `UPDATE`/`DELETE` bestehender
  Einträge, ausschließlich `INSERT` in `ledger_entry`. (Die Engine erzwingt dies
  zusätzlich über `ledger_no_update`/`ledger_no_delete`, Migration 0001 —
  bestehend, **nicht** berührt.)
- **[REQ-SPD-07]** *(Contract/Architektur)* **Where** der Request-Body definiert
  wird, **shall** er nur `{ amount }` umfassen; `type` ist **nicht** Teil der
  Request-Oberfläche, sondern server-gesetzt auf `'spend'`, und das negative
  Speicher-Vorzeichen ist ebenfalls server-gesetzt (REQ-SPD-01). `{id}` bleibt
  opaker Pfad-String, kein Format-Check (REQ-ACCD-08).
- **[REQ-SPD-08]** *(If/Then)* **If** beim Existenz-Check, beim Saldo-Lesen oder
  beim Append ein `SqlError` auftritt, **then shall** das System dies als
  500-Defekt behandeln (`Effect.die` mit `{ _tag: "InternalServerError" }`,
  Status 500) und **nicht** als typisierten Client-Fehler ausweisen; die einzigen
  typisierten Fehler bleiben `AccountNotFound` (404) und `InsufficientFunds`
  (409) — ein DB-Fehler darf sich **weder** als fehlendes Konto **noch** als
  Deckungslücke tarnen (wie REQ-TOP-07 / REQ-ACCD-04).
- **[REQ-SPD-09]** *(Architektur)* **Where** Response-Typ (neuer Saldo),
  Request-Typ (`{ amount }`), der `InsufficientFunds`-Fehler und das
  Append-Repository definiert werden, **shall** alles **lokal** in
  `services/wallet-service/src/` liegen — **kein** Touch von
  `packages/contracts`, **kein** neuer Migrations-File (die `ledger_entry`-Tabelle
  trägt `type IN ('topup','spend','adjustment')` und `amount bigint` —
  vorzeichenbehaftet — bereits aus Migration 0001), **kein** `**/auth/**`. Damit
  bleibt das Tier **T2** (nicht T3).
- **[REQ-SPD-10]** *(Performance)* **Where** der verfügbare Saldo gelesen und der
  neue Eintrag geschrieben wird, **shall** der `account_id` über den bestehenden
  Index `idx_ledger_account` (Saldo-Projektion) bedient werden und der
  Existenz-Check über den PK-Lookup `WHERE id = …` (`accountExists`) laufen —
  keine zusätzliche Scan-Last (qualitativ, keine harten NFR-Zahlen).
- **[REQ-SPD-11]** *(If/Then — Domäneninvariante als Property)* **If** eine
  beliebige Folge gültiger Topups und Spends auf ein Konto angewendet wird,
  **then shall** der projizierte Saldo zu **keinem** Zeitpunkt negativ sein und
  exakt der Summe der angehängten (vorzeichenbehafteten) `amount`-Werte
  entsprechen — die „nie negativ"-Invariante (REQ-SPD-02) gilt nicht nur pro
  Einzel-Request, sondern über die gesamte Append-Historie. Die Saldo-Logik lebt
  in `balance.pure.ts` (mutation-getestet, vgl. `projectBalance`).

## Default-Annahmen (getroffen, nicht blockierend)
- **Fehlerformat `InsufficientFunds`.** Spiegelt `AccountNotFound`: ein
  `Schema.TaggedError` mit `{ accountId }`, serialisiert zu einem JSON-Body mit
  `_tag = "InsufficientFunds"` und `accountId`, gemappt auf HTTP `409` via
  `addError(InsufficientFunds, { status: 409 })`. Bewusst **ohne** Preisgabe von
  Saldo / Defizit im Body (keine Saldo-Leakage über einen unautorisierten
  Schreibversuch); der Status-Code trägt die Semantik. Begründung dokumentiert,
  damit `spec-to-tests` die Body-Form ableiten kann.
- **`amount` ist positive Abbuchungsmenge.** Der Vertrag trägt eine positive
  Zahl (Decode-Rim wie Topup); die Negation auf `-amount` ist server-seitiges
  Speicher-Detail. Damit ist die Request-Oberfläche von Topup und Spend
  symmetrisch (`{ amount }`, positiv), die Endpunkte unterscheiden sich nur in
  Pfad (`/credit` vs. `/debit`), `type` und Vorzeichen.
- **Endpunkt-Name/-Pfad.** `POST /accounts/{id}/debit`, Handler-Operation
  `debit` (analog zu `credit`). Erfolgs-Body wiederverwendeter `Balance`-Typ
  `{ accountId, balance }`.
- **Reihenfolge der Prüfungen.** (1) Decode-Rim `amount > 0` → 400, (2)
  Existenz-Check → 404, (3) Saldo lesen + Deckungsprüfung → 409, (4) Append +
  Saldo zurücklesen. Kein Eintrag bei (1)/(2)/(3).
- **Idempotenz-Key des Spends.** Server-generiert (`spend_<uuid>`), ein Eintrag
  pro erfolgreichem Request — wie beim Topup; befüllt das `NOT NULL UNIQUE`
  `idempotency_key` ohne einen Replay-Vertrag zu erfinden (Out of Scope, s.u.).

## Out of Scope
- **Idempotenz des Spends (Replay-Vertrag).** Wie bei REQ-TOP (Out of Scope dort):
  ein `Idempotency-Key`-Header-Vertrag für `debit` ist eine **eigene** spätere
  Spec. Diese Spec schreibt einen Eintrag pro erfolgreichem Request.
- **Race-/Concurrency-Härtung der Deckungsprüfung.** Diese Spec spezifiziert die
  Invariante auf Request-/Projektions-Ebene (lesen → vergleichen → anhängen).
  Eine transaktionale Serialisierung gegen *gleichzeitige* Spends auf dasselbe
  Konto (z.B. `SELECT … FOR UPDATE` / serializable, um Time-of-check/Time-of-use
  zu schließen) ist hier **nicht** abgenommen — der Referenz-Pilot fährt
  einzelläufig — und bleibt einer Folge-Spec überlassen.
- **`adjustment`-Einträge / freie Vorzeichen.** Nur kontrolliertes Abbuchen
  (`type = 'spend'`, server-negiert). Der `adjustment`-Pfad ist eine eigene Spec.
- **Overflow jenseits `Number.MAX_SAFE_INTEGER`.** Wie REQ-TOP: die
  `bigint`→`number`-Grenze ist dokumentiert (siehe `BalanceRepo`); der Referenz-
  Invariant bleibt „Beträge passen in den safe-integer-Bereich".
- **Authentifizierung / Autorisierung.** Kein Owner-Check, wer abbuchen darf.
- **Multi-Currency / Währungsumrechnung.** `amount` ist Minor-Unit in der
  gespeicherten Konto-Währung; keine Konvertierung.
- **Validierung des `id`-Formats.** Bewusst opaker String (REQ-ACCD-08).
- **Schema-/DB-Änderungen.** Keine neue Migration; `type='spend'`,
  vorzeichenbehaftetes `amount` und die append-only-Rules existieren bereits aus
  Migration 0001.
