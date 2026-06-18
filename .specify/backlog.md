# Backlog

Priorisierte Feature-Reihenfolge für das Obol-Wallet, abgeleitet aus einem
(angenommenen) Event Storming. Die Reihenfolge folgt dem fachlichen Lebenszyklus
eines Kontos und gleichzeitig einer aufsteigenden Tier-Staffelung — vom rein
lesenden T1 über service-lokale T2-Schreiboperationen bis zum service-kreuzenden
T3 mit Event-Contract.

| # | Feature | Tier | Spec | Status |
|---|---------|------|------|--------|
| 0 | Kontostand abfragen | T1 | `specs/balance-query/` | ✅ gebaut |
| 1 | Konto eröffnen | T2 | `specs/account-open/` | 📝 Spec |
| 2 | Top-up (Gutschrift) | T2 | _tbd_ | ⏳ |
| 3 | Einträge auflisten | T1 | _tbd_ | ⏳ |
| 4 | Kontoauszug-Event + statement-service-Consumer | T3 | _tbd_ | ⏳ |
| 5 | Spend (Belastung) | T3 | _tbd_ | ⏳ |

## Begründung der Reihenfolge
- **Konto eröffnen zuerst:** Ohne Konto gibt es nichts aufzuladen oder
  abzufragen. Es etabliert das Idempotenz-Muster (`Idempotency-Key`), das
  Top-up und Spend wiederverwenden.
- **Top-up vor Spend:** Ein Konto muss Guthaben haben, bevor es belastet werden
  kann. Spend trägt zusätzlich die Invariante „kein Überziehen" → höheres Tier.
- **Auflisten als T1 dazwischen:** rein lesend, kleiner Schritt, liefert sofort
  Sichtbarkeit auf die Ledger-Einträge.
- **Event + Consumer (T3):** erste echte Service-Grenze (NATS,
  `wallet.entry.recorded`), erster veröffentlichter Event-Contract.
- **Spend zuletzt (T3):** die geschäftskritischste Operation mit der härtesten
  Invariante — gebaut, wenn der Käfig sich an den vorigen Features bewährt hat.
