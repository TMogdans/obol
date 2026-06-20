# Spec: Konto-Detail abfragen

Tier: T2

## User Story
Als Konto-Inhaber will ich die Stammdaten eines Kontos abrufen, um Eigentümer,
Währung und Anlagezeitpunkt einsehen zu können.

## Akzeptanzkriterien (EARS)
- **[REQ-ACCD-01]** *(When)* **When** ein `GET` auf `/accounts/{id}` für ein
  existierendes Konto erfolgt, **shall** das System genau die Felder
  `{ id, ownerId, currency, createdAt }` zurückgeben — ohne eingebetteten Saldo.
- **[REQ-ACCD-02]** *(When)* **When** ein Konto zurückgegeben wird, **shall**
  `createdAt` als ISO-8601-String (`created_at::text`, wie im `AccountRepo`)
  und `currency` als der gespeicherte Wert geliefert werden.
- **[REQ-ACCD-03]** *(If/Then)* **If** das Konto nicht existiert, **then shall**
  das System `404` mit dem strukturierten Fehler `AccountNotFound`
  (`_tag` + `accountId`) liefern — derselbe Fehler wie in REQ-BAL-02.
- **[REQ-ACCD-04]** *(If/Then)* **If** beim Lesen ein `SqlError` auftritt,
  **then shall** das System dies als 500-Defekt behandeln (`orDie`) und **nicht**
  als typisierten Client-Fehler ausweisen.
- **[REQ-ACCD-05]** *(While)* **While** die Abfrage verarbeitet wird, **shall**
  das System keinerlei Zustandsänderung vornehmen (read-only, idempotent).
- **[REQ-ACCD-06]** *(Performance)* **Where** das Konto über seine `id` gelesen
  wird, **shall** die Abfrage einen indizierten Primärschlüssel-Lookup
  (`WHERE id = …`) nutzen und keinen Full-Scan auslösen (qualitativ, keine harten
  NFR-Zahlen).
- **[REQ-ACCD-07]** *(Architektur)* **Where** der Response-Typ definiert wird,
  **shall** er **lokal** in `services/wallet-service/src/api.ts` liegen — kein
  Touch von `packages/contracts`, keine cross-service-Importe, kein Zyklus/Orphan
  (Tier bleibt T2).
- **[REQ-ACCD-08]** *(Contract)* **Where** `{id}` als Pfadparameter empfangen
  wird, **shall** er als opaker String behandelt werden (kein Format-/Schema-Check).

## Out of Scope
- Saldo / Kontostand — eigene Spec (`balance-query`, REQ-BAL-*).
- Schreiboperationen jeglicher Art — die Domain ist append-only.
- Authentifizierung / Autorisierung.
- Validierung des `id`-Formats (bewusst opaker String).
- Multi-Currency-Logik — `currency` ist der gespeicherte Wert.
