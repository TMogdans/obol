# Branch Protection — der „Ort" der Gates (Säule 2)

> Reproduzierbare Einrichtung des geschützten `main`. Theorie: Framework §7 (Säule 2, Mechanismus
> „Ort") — ein Gate, das der Produzent erreichen kann, kann er abschalten. Echte Durchsetzung =
> server-seitige Checks + Branch Protection, die der Agent nicht umgehen kann.
>
> Teil des Gesamt-Setups → [github-setup.md](./github-setup.md). Diese Datei zeigt den **aktuellen
> Live-Stand** der Branch Protection.

## Prinzip

- Der **Agent committet via Branch + PR**, **mergt nicht** und kann die Gates nicht abschalten
  (`--no-verify` ist wirkungslos, weil die Checks server-seitig auf GitHub laufen).
- `main` akzeptiert nur PRs, die **alle Required Checks** bestehen. Die **Review-Pflicht ist NICHT
  global**, sondern **tier-gestuft im `devloop-precondition-check`** gekapselt (§9): T0/T1 ohne
  Approval, T2/T3 mit menschlichem CODEOWNER-Approval auf HEAD, geschützter Satz nur per Override.
- **Irreduzible Autorität:** `enforce_admins` ist bewusst `false` — der menschliche Owner behält den
  Notfall-Override (Framework §7: ein Mensch ownt den geschützten Satz höher-autorisiert). In echtem
  Betrieb läuft der Agent unter einer **eigenen, nicht-Admin-Identität**, sodass er den Override nicht hat.

## Repo anlegen + initialen Stand pushen

```bash
cd ~/Code/obol
gh repo create TMogdans/obol --public --source=. --remote=origin --push
```

## Branch Protection auf `main` setzen

Die Required-Status-Check-Kontexte sind die **Job-Namen** aus `.github/workflows/ci.yml` **plus**
`devloop-precondition-check`. **Kein globales Review** (`required_pull_request_reviews: null`) — die
Review-Pflicht lebt tier-gestuft im Check.

```bash
gh api -X PUT repos/TMogdans/obol/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "typecheck (tsc -b)",
      "lint (biome)",
      "knip (dead code / unused deps)",
      "test + coverage (vitest, Testcontainers)",
      "mutation (stryker, balance projection)",
      "arch (dependency-cruiser)",
      "escape-hatches (semgrep)",
      "migrations (squawk)",
      "tier (deterministic risk-tier derivation)",
      "devloop-precondition-check"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

## Verifikation

```bash
gh api repos/TMogdans/obol/branches/main/protection --jq '{
  checks: .required_status_checks.contexts,
  strict: .required_status_checks.strict,
  reviews: (.required_pull_request_reviews // "— (tier-gestuft im Check)"),
  admins: .enforce_admins.enabled,
  force_push: .allow_force_pushes.enabled
}'
```

## Warum kein globales Review mehr? (Evolution des Setups)

Anfangs stand hier ein **globales** `required_pull_request_reviews` (`require_code_owner_reviews:
true`, `count: 1`). Das erzwang ein menschliches Approval für **jeden** Merge — und kollabierte damit
die Risiko-Staffel (§9) auf „alles T3": auch T0/T1 (unkritische Docs) brauchten ein Approval, der
§9-Auto-Merge fiel weg (Pilot-Befund, `docs/pilot-log.md` 2026-06-20).

**Auflösung:** Die Review-Pflicht wurde aus der globalen Branch Protection **in den tier-gestuften
`devloop-precondition-check` verlagert** (er prüft das CODEOWNER-Approval nur für T2/T3, via der
CODEOWNERS-Logins als `humanReviewers`). Branch Protection erzwingt jetzt nur noch „alle Required
Checks grün" — und weil der Check §9 kapselt, ist das gleichbedeutend mit „nach §9 mergebar".

## Hinweise

- Die Check-Kontexte müssen exakt den `name:`-Feldern der CI-Jobs entsprechen. Ändert sich ein
  Job-Name, muss der Kontext hier nachgezogen werden (sonst „expected"-Check, der nie grün wird).
- Der Self-Approval-Schutz lebt jetzt im Check (Bot/Autor zählen nicht als Mensch) — kombiniert mit
  der getrennten Agent-Identität ([agent-identity.md](./agent-identity.md)) ist der Deadlock gelöst,
  ohne globales Review.
- `required_linear_history: true` → nur Squash/Rebase-Merges (kein Merge-Commit).
