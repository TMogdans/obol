# Branch Protection — der „Ort" der Gates (Säule 2)

> Reproduzierbare Einrichtung des geschützten `main`. Theorie: Framework §7 (Säule 2, Mechanismus
> „Ort") — ein Gate, das der Produzent erreichen kann, kann er abschalten. Echte Durchsetzung =
> server-seitige Checks + Branch Protection, die der Agent nicht umgehen kann.

## Prinzip

- Der **Agent committet via Branch + PR**, **mergt nicht** und kann die Gates nicht abschalten
  (`--no-verify` ist wirkungslos, weil die Checks server-seitig auf GitHub laufen).
- `main` akzeptiert nur PRs, die **alle Required Checks** bestehen **und** ein **CODEOWNER-Review**
  haben (der geschützte Satz: `.specify/`, Workflows, Gate-Configs, `tools/` — siehe `.github/CODEOWNERS`).
- **Irreduzible Autorität:** `enforce_admins` ist bewusst `false` — der menschliche Owner behält den
  Notfall-Override (Framework §7: ein Mensch ownt den geschützten Satz höher-autorisiert). In echtem
  Betrieb läuft der Agent unter einer **eigenen, nicht-Admin-Identität**, sodass er den Override nicht hat.

## Repo anlegen + initialen Stand pushen

```bash
cd ~/Code/obol
gh repo create TMogdans/obol --public --source=. --remote=origin --push
```

## Branch Protection auf `main` setzen

Die Required-Status-Check-Kontexte sind die **Job-Namen** aus `.github/workflows/ci.yml`.

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
      "tier (deterministic risk-tier derivation)"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "require_code_owner_reviews": true,
    "required_approving_review_count": 1
  },
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
  code_owner: .required_pull_request_reviews.require_code_owner_reviews,
  reviews: .required_pull_request_reviews.required_approving_review_count,
  admins: .enforce_admins.enabled,
  force_push: .allow_force_pushes.enabled
}'
```

## Hinweise

- Die Check-Kontexte müssen exakt den `name:`-Feldern der CI-Jobs entsprechen. Ändert sich ein
  Job-Name, muss der Kontext hier nachgezogen werden (sonst „expected"-Check, der nie grün wird).
- Solo-Setup: Mit `required_approving_review_count: 1` kann man eigene PRs nicht selbst approven
  (GitHub-Regel). Der Admin-Override (da `enforce_admins: false`) ist der bewusste Notausgang, bis
  eine getrennte Agenten-Identität + ein zweiter Reviewer existieren (T3-Mensch-Gate, §9).
