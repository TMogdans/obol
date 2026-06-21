# Spec: Ledger-Event publizieren (ledger-event-publish)

Tier: T3

> Tier deterministisch abgeleitet (devloop `derive-tier`, `tools/tier-map.json`), nicht
> selbst gewählt. **T3** ist autoritativ, weil dieses Feature **zwei** T3-Pfade berührt:
> (1) ein neues Event-Schema in `packages/contracts/**` (REQ-EVT-02 fordert ein **dort**
> definiertes Schema; aktuell existiert in `packages/contracts/src/ledger.ts` nur
> `LedgerEntry`, **kein** `LedgerEntryRecorded`) und (2) eine neue Migration unter
> `services/wallet-service/migrations/**` für die at-least-once-Outbox (REQ-EVT-03). Jeder
> dieser Pfade allein ergäbe schon T3 (`packages/contracts/**`, `services/*/migrations/**`).
> Die in `derive-tier` gegebenen `touched`-Pfade: `packages/contracts/src/ledger.ts`,
> `services/wallet-service/migrations/0003_ledger_outbox.sql`,
> `services/wallet-service/src/{ledger,handlers,outbox,publisher,nats,main}.ts`.
> Das hier deklarierte Tier ist vorläufig/advisorisch; autoritativ wird es server-seitig aus
> dem tatsächlichen CI-Diff berechnet. Der Mensch erwartete T2 (Service-Grenze via Contract) —
> korrekt ist **T3** (Mensch-Gate; Contract- + Migrations-Berührung gewollt, kein Schlupfloch).

## User Story
Als nachgelagerter Service (z.B. `statement-service`) will ich über aufgezeichnete
Ledger-Einträge benachrichtigt werden, um eigene Sichten (Projektionen/Statements) zu
pflegen, ohne die Schreib-DB des wallet-service direkt lesen zu müssen.

Heute persistiert der wallet-service Ledger-Einträge append-only (`appendTopup`/`appendSpend`
in `services/wallet-service/src/ledger.ts`, genau **ein** `INSERT` in `ledger_entry` pro
erfolgreichem Request — REQ-TOP-01 / REQ-SPD-01) und **publiziert nichts**. NATS ist in der
Architektur (README) vorgesehen, aber im Service **noch nicht angebunden**. Dieses Feature
fügt den **Producer-Pfad** hinzu: nach erfolgreicher Persistenz wird **genau ein**
`LedgerEntryRecorded`-Event auf NATS publiziert, vertraglich beschrieben in
`packages/contracts`, und die Zustellung wird **at-least-once** garantiert (Outbox). Der
Consumer (`statement-service`) ist **nicht** Teil dieser Spec.

## Akzeptanzkriterien (EARS)

- **[REQ-EVT-01]** *(When)* **When** ein Ledger-Eintrag erfolgreich persistiert ist (genau
  der erfolgreiche `INSERT` in `ledger_entry` aus dem topup- bzw. spend-Pfad), **shall** das
  System **genau ein** `LedgerEntryRecorded`-Event mit den Feldern `entryId`, `accountId`,
  `amount`, `occurredAt` zur Zustellung auf NATS aufgeben — **ein** persistierter Eintrag
  führt zu **genau einem** Event (keine Duplikate beim Normalpfad, kein verlorenes Event).
  `amount` trägt den **gespeicherten, vorzeichenbehafteten** Betrag (positiv bei topup,
  negativ bei spend — wie in `ledger_entry.amount`), damit ein Consumer denselben Saldo wie
  `projectBalance` rekonstruieren kann. `occurredAt` ist der Aufzeichnungszeitpunkt des
  Eintrags (`ledger_entry.created_at`), `entryId` der Eintrags-PK (`led_<uuid>`), `accountId`
  die `account_id` des Eintrags.

- **[REQ-EVT-02]** *(Where / Contract)* **Where** das Event publiziert wird, **shall** sein
  Payload dem in `packages/contracts` neu definierten `LedgerEntryRecorded`-Schema (ein
  `effect/Schema`-Struct, exportiert über `packages/contracts/src/ledger.ts` →
  `packages/contracts/src/index.ts`) entsprechen und **vor** dem Publizieren gegen dieses
  Schema **encodiert/validiert** werden (`Schema.encode`/`Schema.decode`), sodass kein
  Event publiziert wird, das das Schema verletzt. Producer (diese Spec) und der künftige
  Consumer teilen **dieselbe** Schema-Quelle in `packages/contracts` (eine Wahrheit, keine
  Service-lokale Event-Kopie).

- **[REQ-EVT-03]** *(If/Then)* **If** das Publizieren auf NATS nach erfolgreicher Persistenz
  fehlschlägt (NATS nicht erreichbar, Timeout, Ack ausbleibend), **then shall** das System die
  Zustellung **at-least-once** garantieren: das Event wird **in derselben DB-Transaktion** wie
  der `ledger_entry` in eine **Outbox-Tabelle** geschrieben (atomar — entweder beide oder
  keiner), ein separater Publish-Schritt liest unverschickte Outbox-Zeilen, publiziert sie und
  markiert sie erst **nach** erfolgreicher Zustellung als verschickt; bei Publish-Fehler bleibt
  die Zeile unmarkiert und wird **wiederholt** (Retry), bis die Zustellung gelingt. Folge:
  mindestens-einmal-Zustellung; Duplikate sind erlaubt (Consumer-seitige Idempotenz ist Sache
  des Consumers, Out of Scope).

- **[REQ-EVT-04]** *(If/Then — Atomarität)* **If** das Schreiben der Outbox-Zeile fehlschlägt,
  **then shall** auch der `ledger_entry` **nicht** committet werden (gemeinsame Transaktion) —
  und umgekehrt: ein committeter `ledger_entry` **hat** stets seine Outbox-Zeile. Es gibt
  **keinen** Zustand „Eintrag persistiert, aber kein Event je aufgegeben". Damit kann das
  HTTP-Ergebnis von topup/spend (der zurückgegebene Saldo — REQ-TOP-04 / REQ-SPD-05) **nicht**
  Erfolg melden, ohne dass das Event garantiert (mindestens als Outbox-Zeile) existiert.

- **[REQ-EVT-05]** *(If/Then — Publish-Fehler isolieren)* **If** der Publish-Schritt (nach
  Commit) auf NATS fehlschlägt, **then shall** der ursprüngliche HTTP-Request (topup/spend)
  davon **unberührt** bleiben: er gilt bei committetem Eintrag als **erfolgreich** (der Eintrag
  ist die Wahrheit; der Saldo ist korrekt projizierbar), der Publish wird über die Outbox
  nachgeholt (REQ-EVT-03). Ein NATS-Ausfall darf **weder** den Schreibpfad blockieren **noch**
  als typisierter Client-Fehler (400/404/409) erscheinen **noch** den committeten Eintrag
  zurückrollen. (Schema-/Encode-Fehler beim Publizieren sind ein Producer-Defekt, kein
  Client-Fehler.)

- **[REQ-EVT-06]** *(While — append-only / kein Mutieren)* **While** Events aufgegeben und
  publiziert werden, **shall** der Producer den bestehenden Ledger-Schreibpfad unverändert
  append-only halten: weiterhin genau **ein** `INSERT` in `ledger_entry` pro erfolgreichem
  Request, **kein** `UPDATE`/`DELETE` an `ledger_entry` (REQ-TOP-05 / REQ-SPD-06, Engine-Rules
  `ledger_no_update`/`ledger_no_delete` aus Migration 0001 — **nicht** berührt). Die Outbox ist
  eine **eigene** Tabelle; ihre Sent-Markierung (ein `UPDATE` auf der Outbox-Zeile) ist ein
  Zustandsfeld der Outbox, **nicht** des Ledgers, und fällt nicht unter die Ledger-Append-only-
  Regel.

- **[REQ-EVT-07]** *(Contract / Architektur — Feldtypen)* **Where** das `LedgerEntryRecorded`-
  Schema definiert wird, **shall** es ein `Schema.Struct` mit `entryId: Schema.String`,
  `accountId: Schema.String`, `amount: Schema.Int` (vorzeichenbehaftet), `occurredAt:
  Schema.String` (ISO-8601-Zeitstempel, dieselbe String-Repräsentation wie
  `LedgerEntry.createdAt` im bestehenden Contract) sein. Keine weiteren Pflichtfelder in dieser
  Spec (siehe Default-Annahmen zu `type`/`eventId`). Damit ist das Event-Schema mit dem
  bestehenden `LedgerEntry`-Schema feldkompatibel (Teilmenge: `entryId`↔`id`,
  `occurredAt`↔`createdAt`).

- **[REQ-EVT-08]** *(Architektur — Grenzen / Tier-Begründung)* **Where** das Feature
  implementiert wird, **shall** der Touch auf folgende Bereiche begrenzt sein und damit
  begründet, warum es **T3** ist: das neue Event-Schema **in** `packages/contracts/**` (T3),
  **eine** neue Migration `services/wallet-service/migrations/0003_*.sql` für die
  Outbox-Tabelle (T3), sowie service-lokaler Producer-/Publisher-/NATS-Anbindungs-Code in
  `services/wallet-service/src/**` (T2). **Kein** Touch von `**/auth/**`. Es gibt **keine**
  T2-Variante dieses Features: REQ-EVT-02 verlangt das Schema in `packages/contracts` und
  REQ-EVT-03 die Outbox-Migration — beide sind per `tools/tier-map.json` T3.

- **[REQ-EVT-09]** *(Performance)* **Where** unverschickte Outbox-Zeilen gelesen werden,
  **shall** der Zugriff über die Pending-Auswahl indexgestützt erfolgen (ein Index auf dem
  Sent-Status / der Pending-Bedingung der Outbox-Tabelle), sodass der Publish-Drain nicht den
  vollständigen Outbox-Verlauf scannt (qualitativ, keine harten NFR-Zahlen). Das Aufgeben des
  Events im Schreibpfad bleibt **ein** zusätzlicher `INSERT` in derselben Transaktion (kein
  zusätzlicher Roundtrip gegen NATS auf dem Request-Pfad).

- **[REQ-EVT-10]** *(Where / Subject)* **Where** das Event publiziert wird, **shall** es auf
  ein **stabiles, dokumentiertes** NATS-Subject gehen (Default-Annahme `ledger.entry.recorded`,
  s.u.), damit der künftige Consumer eine feste Subscription-Adresse hat. Das Subject ist Teil
  des Producer-Contracts in dem Sinn, dass ein Wechsel eine bewusste, dokumentierte Änderung
  wäre.

## Default-Annahmen (getroffen, nicht blockierend)

- **`occurredAt` = `ledger_entry.created_at`.** Das Schema hat keine vom Aufzeichnungszeitpunkt
  getrennte „fachliche" Zeit; der Eintrag wird in dem Moment aufgezeichnet, in dem er
  persistiert wird. `occurredAt` ist die ISO-8601-String-Form von `created_at` (konsistent mit
  `LedgerEntry.createdAt`). Begründung dokumentiert, damit `spec-to-tests` die Feldquelle
  ableiten kann.
- **`amount` ist der gespeicherte, vorzeichenbehaftete Betrag.** Positiv bei topup, negativ bei
  spend — identisch zu `ledger_entry.amount`. Das Event spiegelt den **gespeicherten** Wert,
  nicht die Request-Menge; ein Consumer kann so via Summation denselben Saldo wie
  `projectBalance` bilden, ohne `type` interpretieren zu müssen.
- **Schema enthält in dieser Spec genau die vier vorgegebenen Felder.** `entryId`, `accountId`,
  `amount`, `occurredAt` (REQ-EVT-01/07). Ein optionales `type`-Feld (`topup`/`spend`) wäre
  ableitbar, ist aber **nicht** gefordert und bleibt **Out of Scope**, um den Contract minimal
  zu halten (Vorzeichen trägt die Saldo-Information; vgl. wallet-spend, das das Vorzeichen als
  Domänen-Detail behandelt).
- **Outbox als at-least-once-Mechanismus (statt reines In-Process-Retry).** Outbox-Pattern,
  weil nur das gemeinsame Commit von `ledger_entry` + Outbox-Zeile (REQ-EVT-04) den Zustand
  „persistiert, aber Event nie aufgegeben" ausschließt; ein reines best-effort-Retry ohne
  persistente Outbox überlebt keinen Prozess-Crash zwischen Commit und Publish. Die
  Outbox-Tabelle (Name z.B. `ledger_outbox`) trägt mindestens: Event-Identität, das
  serialisierte/feld-aufgelöste Payload (REQ-EVT-07-Felder), einen Sent-Status (+ Index,
  REQ-EVT-09) und eine Bezugnahme auf `entryId`. Genaue Spaltennamen sind Implementierungs-
  Detail der Migration 0003; das **Verhalten** (atomar mit dem Eintrag, drain-and-mark, retry
  bis Erfolg) ist hier spezifiziert.
- **Event-Idempotenz/Dedup-Schlüssel.** Eine pro Event stabile Identität (z.B. `eventId` oder
  Wiederverwendung von `entryId` als Dedup-Key) wird in der Outbox geführt, damit Retries
  beim Consumer deduplizierbar wären. Die **Consumer-seitige** Idempotenz ist Out of Scope;
  diese Spec garantiert nur at-least-once auf der Producer-Seite. Ob ein separater `eventId`
  ins **Payload** aufgenommen wird, ist nicht gefordert (Default: `entryId` ist eindeutig pro
  Eintrag und genügt als Dedup-Anker) — bewusst minimal gehalten.
- **NATS-Subject `ledger.entry.recorded`.** Stabile Default-Adresse (REQ-EVT-10); core NATS
  publish/ack genügt für at-least-once **in Kombination mit** der Outbox (die Outbox, nicht der
  Broker, trägt die Garantie). Ob JetStream genutzt wird, ist Implementierungs-Detail, solange
  die at-least-once-Garantie aus REQ-EVT-03 erfüllt ist.
- **NATS-Anbindung neu im Service.** Verbindung/Publisher werden service-lokal in
  `services/wallet-service/src/**` ergänzt (Effect-Layer, env-konfiguriert analog `DbLive` in
  `db.ts`); der wallet-service ist heute kein NATS-Client.

## Out of Scope

- **Consumer-Seite (`statement-service`).** Subscribe, Projektion/Statement-Aufbau und
  consumer-seitige Idempotenz/Dedup gehören in eine eigene Spec. Diese Spec ist **nur** der
  Producer.
- **Exactly-once-Zustellung.** Garantiert wird **at-least-once** (REQ-EVT-03); Duplikate sind
  erlaubt. Exactly-once (z.B. transaktionale Consumer-Dedup-Tabelle) ist nicht abgenommen.
- **Events für bestehende historische Einträge / Backfill.** Diese Spec publiziert Events für
  **neu** persistierte Einträge ab Einführung; ein Replay/Backfill der vor dem Feature
  geschriebenen `ledger_entry`-Zeilen ist eine eigene Spec.
- **Outbox-Drain-Betriebsmodell (Scheduler/Worker-Topologie, Skalierung, Mehr-Instanz-
  Locking).** Das **Verhalten** (drain unverschickte Zeilen, mark-after-ack, retry) ist
  spezifiziert; ein Mehr-Instanz-Wettlauf um dieselbe Outbox-Zeile (z.B. `FOR UPDATE SKIP
  LOCKED`) und das Scheduling-/Worker-Deployment bleiben einer Folge-Spec überlassen (der
  Referenz-Pilot fährt einzelläufig — analog der Concurrency-Out-of-Scope in wallet-spend).
- **Retry-Backoff-Policy / Dead-Letter.** Dass wiederholt wird, ist gefordert (REQ-EVT-03);
  die konkrete Backoff-Kurve und ein Dead-Letter-/Giving-up-Pfad nach N Versuchen sind nicht
  abgenommen.
- **Ordering-Garantien über mehrere Einträge.** Diese Spec garantiert nur genau-ein-Event-pro-
  Eintrag + at-least-once; eine globale oder per-Account-Reihenfolge der Events ist nicht
  zugesichert.
- **Zusätzliche Event-Felder (`type`, `currency`, `eventId` im Payload).** Bewusst nicht im
  Vier-Felder-Contract (s. Default-Annahmen).
- **Änderung der `ledger_entry`-Tabelle.** Keine neue Spalte an `ledger_entry`; die Outbox ist
  eine **separate** Tabelle (Migration 0003). `ledger_no_update`/`ledger_no_delete` bleiben
  unberührt.
- **Authentifizierung/Autorisierung am NATS-Transport.** Kein Auth-Touch (`**/auth/**`
  unberührt, REQ-EVT-08).
