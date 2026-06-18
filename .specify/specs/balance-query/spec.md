# Spec: Kontostand abfragen

## User Story
Als Konto-Inhaber will ich meinen aktuellen Kontostand abfragen, um zu wissen, wie viel Guthaben
verfügbar ist.

## Akzeptanzkriterien (EARS)
- **[REQ-BAL-01]** **When** ein GET auf `/accounts/{id}/balance` für ein existierendes Konto erfolgt, **shall** das
  System den Saldo als Summe aller `ledger_entry.amount` dieses Kontos zurückgeben.
- **[REQ-BAL-02]** **If** das Konto nicht existiert, **shall** das System `404` mit einem strukturierten Fehler liefern.
- **[REQ-BAL-03]** **While** keine Einträge existieren, **shall** der Saldo `0` sein.

## Out of Scope
- Schreiboperationen (Top-up/Spend) — eigene Specs, höheres Tier.
