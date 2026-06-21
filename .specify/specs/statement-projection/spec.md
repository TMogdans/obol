# Spec: Statement-Projektion (statement-projection)

Tier: T3

> Tier deterministisch abgeleitet (devloop `derive-tier` über `tools/tier-map.json`), nicht
> selbst gewählt. Beleg (`node /Users/tmogdans/Code/devloop/dist/cli/derive-tier.js`):
>
> ```
> touched = [
>   "services/statement-service/migrations/0001_statement_projection.sql",
>   "services/statement-service/src/db.ts",
>   "services/statement-service/src/projection.ts",
>   "services/statement-service/src/consumer.ts",
>   "services/statement-service/src/nats.ts",
>   "services/statement-service/src/api.ts",
>   "services/statement-service/src/server.ts",
>   "services/statement-service/src/main.ts",
>   "services/statement-service/package.json"
> ]
> → {"tier":"T3","tierMapPath":"tools/tier-map.json"}
> ```
>
> **T3 ist autoritativ, weil dieses Feature eine neue Migration unter
> `services/statement-service/migrations/**` braucht** (Glob `services/*/migrations/**` ⇒ T3 in
> `tools/tier-map.json`). Die Migration ist **nicht vermeidbar**: REQ-STMT-01/03 fordern, dass
> Statement-Zeilen *angehängt* und später *zurückgegeben* werden (sie müssen einen Neustart
> überleben), REQ-STMT-02 fordert Idempotenz gegen NATS-at-least-once-Redelivery anhand der
> `entryId` (eine **persistente** „gesehen"-Menge — ein In-Memory-Dedup verliert seinen Zustand
> beim Neustart und wendet redelivered Events erneut an, das wäre ein Korrektheits-Bug, keine
> Optimierung), und REQ-STMT-04 definiert den **Anfangszustand** dieses dauerhaften Speichers.
> Der Beleg zeigt: **ohne** den Migrationspfad (nur `services/statement-service/src/**`) ergäbe
> `derive-tier` **T2** — genau die Mensch-Erwartung. Da Persistenz aber zwingend ist, ist der
> tatsächlich berührte Pfadsatz T3.
>
> **`packages/contracts/**` wird NICHT berührt** (anders als bei `ledger-event-publish`): der
> Consumer bindet an das **bereits auf main existierende** `LedgerEntryRecorded`-Schema in
> `packages/contracts/src/ledger.ts` und definiert **keine** service-lokale Event-Kopie (eine
> Wahrheit — REQ-STMT-06). Kein `**/auth/**`-Touch. Es bleibt bei **einem** T3-Pfad (die
> Migration); ohne ihn wäre es T2.
>
> Das hier deklarierte Tier ist vorläufig/advisorisch; **autoritativ** wird es server-seitig aus
> dem tatsächlichen CI-Diff berechnet (§9/§10, derselbe `derive-tier`). Es lässt sich also nicht
> herunterspielen.
>
> **Tier-Drift zur Mensch-Erwartung (T2):** ja, bewusst benannt. Der Mensch erwartete T2 („Neue
> Service-Oberfläche + eventual consistency → T2"). Die korrekte deterministische Ableitung ist
> **T3** (Mensch-Gate), weil die geforderte Persistenz eine Migration verlangt — analog zur Drift
> bei `ledger-event-publish` (erwartete T2, war T3). Die Service-Oberfläche selbst ist T2; die
> *Migration* hebt das Feature auf T3.

## User Story
Als Konto-Inhaber will ich meine Transaktionshistorie sehen, ohne dass der `statement-service`
die Schreib-Datenbank des `wallet-service` direkt liest — die Sicht wird **aus dem
Ledger-Event-Stream** projiziert.

Heute ist der `statement-service` ein reines **Skelett**: `services/statement-service/src/{api,
main,server}.ts` exponieren nur `GET /health` (Effect-TS, `@effect/platform` `HttpApi`). Es gibt
**keine Persistenz, keine DB, keinen NATS-Client**; die `package.json` hat nur `@effect/platform`
+ `effect`. Es existieren **keine** Imports aus `@obol/wallet-service` (Services sind isoliert).

Der **Producer existiert bereits auf main** (Feature `ledger-event-publish`): der `wallet-service`
publiziert nach erfolgreicher Persistenz **genau ein** `LedgerEntryRecorded`-Event
**at-least-once** (Outbox) auf das stabile NATS-Subject **`ledger.entry.recorded`**. Das
zugehörige Schema lebt in `packages/contracts/src/ledger.ts` (`LedgerEntryRecorded =
Schema.Struct({ entryId, accountId, amount: Schema.Int /* signiert */, occurredAt /* ISO-8601 */
})`).

Dieses Feature fügt den **Consumer-/Projektions-Pfad** hinzu: der `statement-service` abonniert
das Subject, baut aus den Events eine **persistente** Statement-Sicht pro Konto auf
(idempotent gegen at-least-once-Redelivery) und gibt sie über `GET /accounts/{id}/statement`
zurück. Die Producer-Seite ist **nicht** Teil dieser Spec (sie ist abgenommen).

## Akzeptanzkriterien (EARS)

- **[REQ-STMT-01]** *(When)* **When** ein `LedgerEntryRecorded`-Event vom Subject
  `ledger.entry.recorded` konsumiert wird, **shall** das System **genau eine** Statement-Zeile für
  das Konto (`accountId` des Events) an die persistente Statement-Sicht **anhängen**. Die Zeile
  übernimmt die vier Eventfelder unverändert: `entryId` (Identität der Zeile), `accountId`,
  `amount` (der **vorzeichenbehaftete** Betrag — positiv bei topup, negativ bei spend, exakt wie
  vom Producer geliefert; **keine** Neuinterpretation des Vorzeichens) und `occurredAt`
  (ISO-8601). Ein erstmalig gesehenes Event führt zu **genau einer** neuen Zeile (kein Verlust,
  keine Duplikat-Zeile). Append-only: bestehende Statement-Zeilen werden dabei **nicht** mutiert.

- **[REQ-STMT-02]** *(If/Then — Idempotenz, Property-Test-Stoff)* **If** ein Event mit einer
  bereits gesehenen `entryId` konsumiert wird (NATS garantiert nur **at-least-once**, also sind
  Redeliveries/Duplikate regulär zu erwarten), **then shall** das System es **ignorieren**: es
  entsteht **keine** zweite Statement-Zeile und der projizierte Zustand des Kontos bleibt
  **unverändert**. Konsequenz, testbar als Property: das **n-malige** Konsumieren desselben
  Events (für beliebiges n ≥ 1) führt zu **demselben** Statement wie das **einmalige**
  Konsumieren (Idempotenz/Konvergenz). Reihenfolge der Duplikate gegenüber anderen Events ändert
  das Endergebnis der Zeilenmenge pro Konto nicht (die Menge der Zeilen ist durch die Menge der
  eindeutigen `entryId` bestimmt). Der Dedup-Schlüssel ist die `entryId`; die Eindeutigkeit wird
  **persistent** durchgesetzt (überlebt einen Prozess-Neustart — REQ-STMT-05), nicht nur im
  Arbeitsspeicher.

- **[REQ-STMT-03]** *(When)* **When** ein `GET /accounts/{id}/statement` für ein Konto `{id}`
  erfolgt, **shall** das System die Statement-Zeilen **dieses** Kontos zurückgeben — und **nur**
  dieses Kontos (kein Übergreifen auf andere `accountId`) — sortiert **neueste zuerst** (absteigend
  nach `occurredAt`; bei gleichem `occurredAt` ist die Sortierung stabil/deterministisch, z.B.
  zusätzlich nach `entryId`, damit die Antwort reproduzierbar ist). Jede zurückgegebene Zeile
  trägt die Felder aus REQ-STMT-01 (`entryId`, `accountId`, `amount`, `occurredAt`). Das Ergebnis
  enthält **jede** eindeutige `entryId` des Kontos **genau einmal** (Konsequenz aus REQ-STMT-02).

- **[REQ-STMT-04]** *(While — Anfangszustand)* **While** für ein Konto **noch keine** Events
  konsumiert wurden (kein `LedgerEntryRecorded` mit dieser `accountId` angekommen), **shall** die
  von `GET /accounts/{id}/statement` zurückgegebene Liste **leer** sein (eine erfolgreiche Antwort
  mit leerer Zeilenliste — **kein** Fehler, **kein** 404 für ein „leeres" Konto). Das gilt
  insbesondere für den frischen, leeren Speicher direkt nach der Migration: ohne konsumierte
  Events ist **jede** Statement-Abfrage leer.

- **[REQ-STMT-05]** *(Architektur / Persistenz — Tier-Begründung)* **Where** die
  Statement-Sicht und die „gesehen"-Menge gehalten werden, **shall** dies in einer **persistenten**
  Datenbank-Tabelle des `statement-service` geschehen, angelegt durch eine **neue** Migration
  unter `services/statement-service/migrations/**` (analog zum Migrations-Muster des
  `wallet-service`: `db.ts` mit `PgClient.layerConfig` + SQL-File-Loader für `NNNN_name.sql`).
  Die `entryId` ist der **Primärschlüssel** der Statement-Tabelle, sodass die Idempotenz aus
  REQ-STMT-02 **durch die Datenbank** erzwungen wird (ein zweites Insert derselben `entryId`
  verletzt den PK und wird verworfen/ignoriert) und einen Prozess-Neustart überlebt. **Diese
  Migration ist der Grund, warum das Feature T3 ist** (`services/*/migrations/**` ⇒ T3); eine
  T2-Variante (nur `services/statement-service/src/**`, ohne Persistenz) erfüllt REQ-STMT-01..04
  **nicht** (siehe Tier-Begründung oben). **Kein** Touch von `**/auth/**`.

- **[REQ-STMT-06]** *(Contract / Architektur — eine Wahrheit)* **Where** der Consumer das Event
  dekodiert, **shall** er an das **bereits in `packages/contracts/src/ledger.ts` exportierte**
  `LedgerEntryRecorded`-Schema (`effect/Schema`-Struct, importiert über `@obol/contracts`) binden
  und das eingehende NATS-Payload gegen dieses Schema **dekodieren/validieren**
  (`Schema.decode`), **bevor** es projiziert wird. Der `statement-service` definiert **keine**
  service-lokale Event-Kopie und ändert das Contract-Paket **nicht** (`packages/contracts/**`
  unberührt — der Producer hat das Schema bereits angelegt). Producer und Consumer teilen
  **dieselbe** Schema-Quelle. Es gibt **keinen** Import aus `@obol/wallet-service` (Service-
  Isolation; Kommunikation nur via `@obol/contracts` + Events).

- **[REQ-STMT-07]** *(If/Then — Validierung / Vergiftung verhindern)* **If** eine Nachricht auf
  dem Subject das `LedgerEntryRecorded`-Schema **verletzt** (fehlende/falsch typisierte Felder,
  `amount` nicht ganzzahlig, kein dekodierbares Payload), **then shall** das System **keine**
  Statement-Zeile daraus anhängen (eine schema-verletzende Nachricht darf die Projektion **nicht**
  korrumpieren) und die Verarbeitung des Streams **nicht** dauerhaft blockieren. Eine valide,
  schema-konforme Nachricht wird normal projiziert (REQ-STMT-01). (Der genaue Umgang mit der
  ungültigen Nachricht — verwerfen/loggen — ist Implementierungsdetail; Dead-Letter-Behandlung
  ist Out of Scope.)

- **[REQ-STMT-08]** *(Where / Subject)* **Where** der Consumer subscribed, **shall** er das
  **stabile, dokumentierte** Subject **`ledger.entry.recorded`** verwenden (die feste
  Subscription-Adresse aus dem Producer-Contract, `ledger-event-publish` REQ-EVT-10). Ein Wechsel
  des Subjects wäre eine bewusste, koordinierte Änderung auf beiden Seiten.

- **[REQ-STMT-09]** *(Performance)* **Where** `GET /accounts/{id}/statement` die Zeilen eines
  Kontos liest, **shall** der Zugriffspfad **indexgestützt** über `accountId` (in der Sortier-
  Richtung `occurredAt` absteigend) erfolgen, sodass die Abfrage nicht die gesamte
  Statement-Tabelle aller Konten sequenziell scannt (qualitativ, keine harten NFR-Zahlen). Das
  Anhängen einer Zeile beim Konsumieren bleibt **ein** zusätzlicher `INSERT` pro eindeutigem
  Event (Duplikate erzeugen keinen zusätzlichen dauerhaften Schreibvorgang — PK-Konflikt).

## Default-Annahmen (getroffen, nicht blockierend)

- **Statement-Tabelle, ein Zeilen-Schema, `entryId` als PK.** Eine Tabelle (z.B. `statement_line`)
  mit Spalten für die vier Eventfelder; `entry_id` ist PRIMARY KEY und trägt damit **zugleich** die
  Statement-Zeile **und** den Idempotenz-/Dedup-Anker (REQ-STMT-02/05) — keine getrennte
  „processed-events"-Tabelle nötig, weil eine Statement-Zeile pro Event entsteht und die Existenz
  der Zeile selbst „schon gesehen" bedeutet. Genaue Spaltennamen sind Detail der Migration
  `0001_statement_projection.sql`; das **Verhalten** (append, dedup per PK, leerer Anfangszustand)
  ist hier spezifiziert.
- **Idempotenz über DB-PK, nicht über In-Memory-Set.** `INSERT ... ON CONFLICT (entry_id) DO
  NOTHING` (oder äquivalent) macht das Anhängen idempotent und überlebt einen Neustart. Das ist
  die robuste Erfüllung von REQ-STMT-02 gegen NATS-at-least-once; ein reines Prozess-Gedächtnis
  würde redelivered Events nach einem Crash erneut anwenden.
- **`amount` wird unverändert übernommen.** Der vorzeichenbehaftete Wert aus dem Event wird
  gespeichert und zurückgegeben (REQ-STMT-01); der `statement-service` interpretiert das
  Vorzeichen **nicht** um und rechnet (in dieser Spec) **keinen** Saldo aus — er gibt die Zeilen
  aus. Ein abgeleiteter Kontostand/Running-Balance ist **nicht** gefordert (Out of Scope).
- **Sortierschlüssel `occurredAt` desc, Tie-Break deterministisch.** „Neueste zuerst" (REQ-STMT-03)
  über `occurredAt`; bei identischem `occurredAt` ein stabiler Zweitschlüssel (z.B. `entry_id`),
  damit die Antwort reproduzierbar und testbar ist. Eine globale Ledger-Reihenfolge garantiert der
  Producer nicht (REQ-EVT „Ordering Out of Scope") — die Sortierung der Sicht ist rein lokal über
  `occurredAt`.
- **DB-/NATS-Anbindung neu im Service.** `services/statement-service` bekommt service-lokal eine
  `db.ts` (Effect-Layer `PgClient.layerConfig`, env-konfiguriert analog `wallet-service/src/db.ts`)
  und einen NATS-Subscriber (Effect-Layer, env-konfiguriert); beide existieren heute nicht. Neue
  Dependencies in `services/statement-service/package.json` (Pg-/NATS-Client) sind zu erwarten —
  Hinweis: ein dadurch berührtes `pnpm-lock.yaml` gehört zum geschützten Satz (Admin-Override beim
  Merge, wie im Pilot-Log dokumentiert), ändert aber die hier abgeleitete Tier-Aussage nicht.
- **`{id}` ist die `accountId`.** Der Pfadparameter von `GET /accounts/{id}/statement` ist die
  `accountId`, gegen die die Zeilen (`statement_line.account_id`) gefiltert werden (REQ-STMT-03).
- **Health-Endpoint bleibt.** Der bestehende `GET /health` (Skelett) bleibt erhalten; die
  Statement-API wird **ergänzt**, nicht ersetzt.

## Out of Scope

- **Producer-Seite (`ledger-event-publish`).** Publizieren, Outbox, Subject-Definition sind bereits
  auf main abgenommen und **nicht** Teil dieser Spec. Diese Spec ist **nur** der Consumer/die
  Projektion.
- **Backfill / Replay historischer Einträge.** Diese Projektion baut sich aus Events auf, die
  **ab Einführung** des Consumers konsumiert werden. Ein Replay der vor dem Feature publizierten
  bzw. verpassten Events (z.B. JetStream-Replay ab Sequence 0) ist eine eigene Spec. Folge: für
  vor der Subscription geschriebene Einträge kann das Statement (zunächst) unvollständig sein —
  bewusst, hier nicht abgenommen.
- **Exactly-once-Konsum.** Garantiert wird **idempotente** Verarbeitung von at-least-once
  (REQ-STMT-02), **nicht** eine transaktionale exactly-once-Kopplung zwischen NATS-Ack und
  DB-Commit.
- **Abgeleiteter Saldo / Running-Balance / Aggregationen.** Das Statement gibt **Zeilen** zurück
  (REQ-STMT-03); eine Saldo-Spalte, Summen, Zeiträume oder Gruppierungen sind nicht gefordert.
- **Paginierung / Filter / Zeitraum-Query.** `GET /accounts/{id}/statement` gibt (in dieser Spec)
  die Zeilen des Kontos zurück; Limit/Offset/Cursor, Datumsfilter o.Ä. sind nicht abgenommen.
- **Dead-Letter / Backoff-Policy für vergiftete Nachrichten.** Dass eine schema-verletzende
  Nachricht die Projektion nicht korrumpiert und den Stream nicht dauerhaft blockiert, ist
  gefordert (REQ-STMT-07); ein Dead-Letter-Ziel und die konkrete Retry-/Backoff-Kurve sind nicht
  abgenommen.
- **Mehr-Instanz-Consumer / Concurrency.** Ein Wettlauf mehrerer Consumer-Instanzen um dasselbe
  Subject (Queue-Groups, Lastverteilung) und das Deployment-/Skalierungsmodell sind nicht
  abgenommen (der Referenz-Pilot fährt einzelläufig — analog der Concurrency-Out-of-Scope in
  `ledger-event-publish`). Die **Idempotenz** (REQ-STMT-02) ist davon unabhängig korrekt.
- **Änderung des `LedgerEntryRecorded`-Contracts.** Der Consumer **bindet** an das bestehende
  Schema (REQ-STMT-06); eine Erweiterung des Contracts (`type`, `currency`, `eventId` im Payload)
  ist nicht Teil dieser Spec. `packages/contracts/**` wird nicht berührt.
- **Authentifizierung/Autorisierung** am HTTP-Endpoint oder am NATS-Transport. Kein Auth-Touch
  (`**/auth/**` unberührt, REQ-STMT-05).
