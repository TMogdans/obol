# Backlog

Priorisierte Feature-Reihenfolge für das Obol-Wallet, abgeleitet aus einem
(angenommenen) Event Storming. Die Reihenfolge folgt dem fachlichen Lebenszyklus
eines Kontos. Das Tier ist **abgeleitet, nicht gewählt** (deterministisch aus den
berührten Pfaden, `tools/tier-map.json`) — es steigt daher nicht monoton mit der
fachlichen Reihenfolge: schon „Konto eröffnen" landet bei T3, weil es eine
Migration anfasst.

| # | Feature | Tier | Spec | Status |
|---|---------|------|------|--------|
| 0 | Kontostand abfragen | T1 | `specs/balance-query/` | ✅ gebaut |
| 1 | Konto eröffnen | T3 ¹ | `specs/account-open/` | 📝 Spec |
| 2 | Top-up (Gutschrift) | T2 ² | _tbd_ | ⏳ |
| 3 | Einträge auflisten | T1 | _tbd_ | ⏳ |
| 4 | Kontoauszug-Event + statement-service-Consumer | T3 | _tbd_ | ⏳ |
| 5 | Spend (Belastung) | T3 | _tbd_ | ⏳ |

¹ T3 **wegen der Migration** (`account.idempotency_key`), nicht wegen der
fachlichen Komplexität — `services/*/migrations/**` ⇒ T3, upgrade-wins.
² T2, solange Top-up nur `ledger_entry` schreibt (Spalte existiert bereits) und
keinen `contracts/**`-Event-Vertrag anfasst; sonst T3.

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
