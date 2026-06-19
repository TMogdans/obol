# Pilot-Log — devloop-Erprobung gegen Obol

Chronik der Stolpersteine während der devloop-Pilotierung (Phase E). Jeder Eintrag hält einen
konkreten Vorfall fest: ein Gate, das griff (oder nicht), eine Rechte-Grenze, eine sichtbar
gewordene Lücke. Zweck: belastbares Material für die Blogserie und Rückmeldung an die
devloop-Seite — keine Theorie, sondern was im realen Repo passiert ist.

**Format pro Eintrag:**

```
## JJJJ-MM-TT — Kurztitel
- Auslöser: welches Gate / welche Rechte-Grenze / welcher Vorfall
- Was passierte: 1–2 Sätze
- Ausgang: gefangen / eskaliert / Lücke sichtbar geworden
- Beleg: PR-Link, CI-Run oder Commit-Hash
- Lehre: 1 Satz
```

---

## 2026-06-19 — Setup-PR blockiert sich selbst (Käfig-Bau ist T3)
- Auslöser: `devloop-precondition-check` (Wächter) + geschützter Satz / Rechte-Grenze
- Was passierte: PR #7 verdrahtet den precondition-check und berührt dabei zwangsläufig den geschützten Satz (`.github/`, `package.json`, `.devloop/`) — ohne menschliches Approval auf HEAD.
- Ausgang: gefangen — der Check ging fail-closed (`human-approval-missing`); der Merge erfolgte bewusst per Admin-Override (`enforce_admins: false`).
- Beleg: PR [#7](https://github.com/TMogdans/obol/pull/7), CI-Run 27845571851
- Lehre: Die Gates, die den Käfig bauen, sind selbst T3 — der Admin-Override ist hier kein Schlupfloch, sondern der vorgesehene Weg (Framework §1.3).

## 2026-06-19 — Generisches Template bricht lokales Format-Gate
- Auslöser: `lint`-Gate (Biome)
- Was passierte: `/devloop:init` legte `.devloop/bot-logins.json` mehrzeilig an; Obols Biome-Check verlangt das Array einzeilig → `lint` rot.
- Ausgang: gefangen — das Gate stoppte den PR; Fix per `biome check --write` → grün.
- Beleg: PR [#7](https://github.com/TMogdans/obol/pull/7), Commit `55557f3`
- Lehre: Repo-agnostische Generatoren müssen an das Formatier-Gate des Ziel-Repos angepasst werden; das Gate fängt die Abweichung zuverlässig.

## 2026-06-19 — Tier-Format-Mismatch (zwei Tier-Wahrheiten drohten)
- Auslöser: Integration / `derive-tier` (Design-Befund, kein Laufzeit-Vorfall)
- Was passierte: devloops `derive-tier` erwartet `{rules,default}`, Obol hat `{Tier:[globs]}`; zunächst per Inline-Adapter im Workflow überbrückt — wodurch eine zweite Tier-Ableitung neben Obols `tools/derive-tier.ts` entstand.
- Ausgang: Lücke sichtbar geworden → an devloop zurückgemeldet. Auflösung: den `derive-tier`-Schritt aus dem precondition-check entfernen (`verify-review` nutzt das Tier nicht), Obols `tier`-Job bleibt die einzige Tier-Wahrheit.
- Beleg: PR [#7](https://github.com/TMogdans/obol/pull/7); devloop ≥ v0.1.1 unterstützt das `{Tier:[globs]}`-Format nun auch nativ
- Lehre: Eine Verifikation, die das Tier nicht verwendet, soll es auch nicht ableiten — sonst entstehen zwei Wahrheiten, die divergieren können (Anti-Pattern §6.2/§8).
