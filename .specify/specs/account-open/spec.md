# Spec: Konto eröffnen

## User Story
Als Wallet-Nutzer will ich ein Konto eröffnen, um anschließend Guthaben
aufladen und ausgeben zu können.

## Akzeptanzkriterien (EARS)
- **[REQ-ACC-01]** **When** ein POST auf `/accounts` mit einem nicht-leeren
  `ownerId` und einem `Idempotency-Key` erfolgt, **shall** das System ein neues
  Konto mit server-vergebener `id`, `currency = "EUR"` und `createdAt` anlegen
  und es mit `201` zurückgeben.
- **[REQ-ACC-02]** **When** ein POST auf `/accounts` mit einem bereits
  verwendeten `Idempotency-Key` erfolgt, **shall** das System das zuvor angelegte
  Konto unverändert mit `200` zurückgeben und kein zweites Konto anlegen.
- **[REQ-ACC-03]** **If** der `Idempotency-Key` fehlt, **shall** das System `400`
  mit einem strukturierten Fehler liefern.
- **[REQ-ACC-04]** **If** `ownerId` fehlt oder leer ist, **shall** das System
  `400` mit einem strukturierten Fehler liefern.
- **[REQ-ACC-05]** **When** derselbe `ownerId` mit einem neuen `Idempotency-Key`
  ein Konto eröffnet, **shall** das System ein weiteres, eigenständiges Konto
  anlegen (mehrere Konten pro Owner sind erlaubt).

## Out of Scope
- Top-up / Spend / Kontostand — eigene Specs.
- Multi-Currency — `currency` ist serverseitig fix `"EUR"` (Altlast-Spalte);
  echte Währungswahl wäre eine eigene Spec.
- Konto schließen/löschen — die Domain ist append-only.
- Authentifizierung / Autorisierung.

## Tier
T2 — berührt eine Migration (`account.idempotency_key`), aber keinen
contracts/**-Vertrag und keine Service-Grenze (kein NATS-Event).
