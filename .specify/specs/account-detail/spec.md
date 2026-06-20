# Spec: Kontodetails abfragen (account-detail)

> Status: **REVIEWED** — menschlicher Spec-Review abgeschlossen; Annahmen A1–A6
> bestätigt (siehe „Review-Entscheidungen"). Diese Spec ist die autoritative
> Vorgabe für die nachfolgende spec-to-tests-Station.

## Tier
**T2** (vorläufig/advisorisch — steuert nur Critic-Tiefe und Stopp-Strenge in der
inneren Schleife). Autoritativ wird das Tier serverseitig auf CI aus dem **tatsächlichen
Diff** abgeleitet (§9/§10), nicht aus dieser Deklaration.

Ableitung (deterministisch, nicht selbst gewählt):
- Erwartet berührte Pfade: `services/wallet-service/src/api.ts`,
  `services/wallet-service/src/handlers.ts`, `services/wallet-service/src/accounts.ts`,
  `services/wallet-service/test/account-detail.test.ts` → alle unter `services/**` → **T2**.
- Der Response-Typ wird LOKAL in `services/wallet-service/src/api.ts` definiert (wie
  `Balance`); `packages/contracts/**` wird **nicht** berührt (Review-Entscheidung A3).
  Damit bleibt es bei **T2**.
- **Eskalationstrigger zu T3:** Sobald der Diff `packages/contracts/**`,
  `services/*/migrations/**`, `**/auth/**` oder `tools/**` berührt, springt das Tier
  per „upgrade-wins" auf **T3**. Diese Spec ist so geschnitten, dass kein
  contracts-/migrations-/auth-Pfad nötig ist.

## User Story
Als Konto-Inhaber will ich die Stammdaten eines einzelnen Kontos abrufen, um die
Eigenschaften des Kontos (Eigentümer, Währung, Anlagedatum) einzusehen — getrennt von
der reinen Saldo-Abfrage.

## Kontext
- `account-open` (`POST /accounts`, REQ-ACC-*) legt Konten an und gibt das vollständige
  Record (`id`, `ownerId`, `currency`, `createdAt`) zurück.
- `balance-query` (`GET /accounts/{id}/balance`, REQ-BAL-*) liefert nur den Saldo.
- Diese Spec ergänzt die **Detail-Lese-Sicht** auf das Konto selbst:
  `GET /accounts/{id}`. Sie ist die natürliche Schwester der beiden obigen Specs und
  spiegelt deren 200/404-/Idempotenz-Muster für reine Lesezugriffe.

## Akzeptanzkriterien (EARS)
- **[REQ-ACCD-01]** *(When — ereignisgetrieben)* **When** ein GET auf
  `/accounts/{id}` für ein existierendes Konto erfolgt, **shall** das System das
  Konto-Record mit `id`, `ownerId`, `currency` und `createdAt` und Status `200`
  zurückgeben.
- **[REQ-ACCD-02]** *(If/Then — Zustand)* **If** kein Konto mit dieser `id`
  existiert, **shall** das System `404` mit einem strukturierten Fehler (`_tag`
  `AccountNotFound`, `accountId`) liefern — konsistent zu REQ-BAL-02.
- **[REQ-ACCD-03]** *(Contract — Schnittstellenvertrag)* Das zurückgegebene
  `createdAt` **shall** ein ISO-8601-Zeitstring sein (über `created_at::text`,
  driver-unabhängig — wie in `AccountRepo`), und `currency` **shall** den
  gespeicherten Wert ausgeben (derzeit `"EUR"`).
- **[REQ-ACCD-04]** *(When — ereignisgetrieben, Idempotenz/Read-Safety)* **When**
  dieselbe `id` mehrfach abgefragt wird, **shall** das System bei unverändertem
  Kontozustand identische Antworten liefern und **keinen** Datenbankzustand
  verändern (reiner Lesezugriff, append-only Domain bleibt unberührt).
- **[REQ-ACCD-05]** *(If/Then — Zustand, Defekt-Abgrenzung)* **If** während der
  Abfrage ein `SqlError` auftritt, **shall** das System dies als unerwarteten
  Defekt behandeln und `500` liefern — der Fehler **shall nicht** als typisierter
  Client-Fehler (z.B. fälschlich als `404`) durchschlagen. (Spiegelt das
  `orDie`-Muster im `balance`-Handler.)
- **[REQ-ACCD-06]** *(Architektur)* Die Implementierung **shall** keine
  service-übergreifenden Importe einführen; der Response-Typ wird lokal in
  `services/wallet-service/src/api.ts` definiert (Review-Entscheidung A3), nicht
  über `packages/contracts`. Kein Zyklus, kein Orphan (dependency-cruiser bleibt grün).
- **[REQ-ACCD-07]** *(Performance — qualitativ)* **When** ein
  Konto-Detail abgefragt wird, **shall** der Lookup ein indizierter
  Primärschlüssel-Zugriff (`WHERE id = …`) sein — kein voller Tabellenscan. Keine
  harten Latenz-/Durchsatz-Zielwerte (Review-Entscheidung A5).

## Out of Scope
- Saldo — bleibt `GET /accounts/{id}/balance` (REQ-BAL-*). Kein Saldo im Detail-Record
  eingebettet (Review-Entscheidung A2).
- Auflisten/Suchen von Konten (`GET /accounts`), Paginierung, Filter nach `ownerId`.
- Schreiboperationen (Top-up/Spend), Konto schließen/löschen (append-only Domain).
- Authentifizierung / Autorisierung — kein `**/auth/**`-Pfad (würde T3 erzwingen).
- Multi-Currency.

## Review-Entscheidungen (bestätigt)
Der menschliche Spec-Review hat die zuvor offenen Annahmen wie folgt autoritativ
entschieden:

- **A1 (Route & Methode):** BESTÄTIGT — `GET /accounts/{id}`.
- **A2 (Response-Felder):** BESTÄTIGT — genau `{ id, ownerId, currency, createdAt }`
  (= bestehendes `Account`-Record). **Kein** Saldo eingebettet.
- **A3 (Tier-relevant — contracts):** BESTÄTIGT — der Response-Typ wird LOKAL in
  `services/wallet-service/src/api.ts` definiert (wie `Balance`), **ohne** Änderung
  an `packages/contracts/**`. Das Tier bleibt damit **T2** (CI leitet das Tier
  autoritativ aus dem tatsächlichen Diff ab).
- **A4 (Fehler-Typ-Wiederverwendung):** BESTÄTIGT — der vorhandene `AccountNotFound`
  wird wiederverwendet; gleicher `_tag` / gleiche Body-Form wie in REQ-BAL-02.
- **A5 (Performance, REQ-ACCD-07):** BESTÄTIGT — das Kriterium bleibt **qualitativ**
  (indizierter PK-Lookup, kein Full-Scan); keine harten NFR-Zahlen.
- **A6 (`id`-Validierung):** BESTÄTIGT — `id` wird als opaker String behandelt (wie in
  `balance`); kein Format-Check erzwungen.
