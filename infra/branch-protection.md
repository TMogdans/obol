# Branch Protection — der „Ort" der Gates (Säule 2)

> Reproduzierbare Einrichtung des geschützten `main`. Theorie: Framework §7 (Säule 2, Mechanismus
> „Ort") — ein Gate, das der Produzent erreichen kann, kann er abschalten. Echte Durchsetzung =
> server-seitige Checks + Branch Protection, die der Agent nicht umgehen kann.
>
> Teil des Gesamt-Setups → [github-setup.md](./github-setup.md). Diese Datei zeigt den **aktuellen
> Live-Stand** der Branch Protection (verifiziert 2026-06-21 gegen `gh api`; Modell seit devloop
> v0.3.0 CODEOWNERS-nativ, unter v0.4.1/v0.5.0 unverändert).

## Prinzip

- Der **Agent committet via Branch + PR**, **mergt nicht** und kann die Gates nicht abschalten
  (`--no-verify` ist wirkungslos, weil die Checks server-seitig auf GitHub laufen).
- `main` akzeptiert nur PRs, die **alle Required Checks** bestehen.
- Die **T2/T3-Review-Pflicht ist GitHub-nativ über CODEOWNERS-by-path** durchgesetzt (§9, seit
  v0.3.0): `require_code_owner_reviews: true` bei `required_approving_review_count: 0`. Ein PR ohne
  CODEOWNER-Pfad (T0/T1) braucht **null** Approvals → Auto-Merge; ein PR, der einen CODEOWNER-Pfad
  berührt (T2/T3), **erzwingt ein menschliches Owner-Review**. Die Pfad-Sensitivität von CODEOWNERS
  liefert die Tier-Staffelung, ohne dass die Branch Protection das Tier kennen muss.
- Der `devloop-precondition-check` ist **kein Approval-Tor** mehr (das ist die Branch Protection). Er
  *passt*, solange ein PR nur auf Review wartet, und **failt nur bei echten Problemen**: Gate-Tampering
  (geschützter Satz berührt), ein **ungültiges** Approval (Agent/Autor self-approve oder veraltet) oder
  **CODEOWNERS-Drift** (ein T2/T3-Pfad ohne Owner). So bleibt kein veraltetes FAILURE über die zwei
  Trigger-Events (`pull_request` + `pull_request_review`) hängen.
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
`devloop-precondition-check`. Das **Review-Objekt** erzwingt Code-Owner-Reviews pfad-sensitiv bei
globalem `required_approving_review_count: 0`.

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
  "required_pull_request_reviews": {
    "require_code_owner_reviews": true,
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": true,
    "require_last_push_approval": false
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
  code_owner_reviews: .required_pull_request_reviews.require_code_owner_reviews,
  approvals_required: .required_pull_request_reviews.required_approving_review_count,
  admins: .enforce_admins.enabled,
  force_push: .allow_force_pushes.enabled
}'
```

## Wie das Review-Modell sich entwickelt hat (Evolution des Setups)

Drei Stufen, jede aus einem Pilot-Befund (`docs/pilot-log.md`):

1. **Global `count: 1` + `require_code_owner_reviews: true`** — erzwang ein Approval für *jeden* Merge
   und kollabierte die Risiko-Staffel (§9) auf „alles T3": auch unkritische T0/T1-Docs brauchten ein
   Approval, der §9-Auto-Merge fiel weg.
2. **Review-Pflicht in den `devloop-precondition-check` verlagert** (`required_pull_request_reviews:
   null`) — tier-gestuft im Check geprüft. Problem: ein gleichnamiger Required-Check auf zwei Events
   hinterließ veraltete FAILURE-Runs, die den Merge blockierten (§9-Regression, v0.2.x/v0.3.0).
3. **CODEOWNERS-nativ (aktueller Stand, seit v0.3.0):** `required_approving_review_count: 0` +
   `require_code_owner_reviews: true`. Die **Pfad-Sensitivität von CODEOWNERS** liefert die
   Tier-Staffelung GitHub-nativ: T0/T1 (kein Owner-Pfad) → 0 Approvals → Auto-Merge; T2/T3 (Owner-Pfad
   berührt) → erzwungenes menschliches Owner-Review. Der `devloop-precondition-check` ist damit **kein
   Approval-Tor** mehr, sondern ein **fail-closed-Wächter** gegen Gate-Tampering, ungültige Approvals
   und CODEOWNERS-Drift — und hinterlässt kein lingering FAILURE mehr.

**Voraussetzung des aktuellen Modells:** jeder T2/T3-Pfad der `tier-map` muss in `CODEOWNERS` abgedeckt
sein, sonst mergte T2/T3 still ungeprüft. Diese Invariante bewacht der `check-codeowners`-Step im
precondition-check fail-closed (Drift-Wächter).

## Hinweise

- Die Check-Kontexte müssen exakt den `name:`-Feldern der CI-Jobs entsprechen. Ändert sich ein
  Job-Name, muss der Kontext hier nachgezogen werden (sonst „expected"-Check, der nie grün wird).
- Der Review-*Zwang* für T2/T3 ist GitHub-nativ (CODEOWNERS); der Check prüft zusätzlich die
  *Gültigkeit* eines vorhandenen Approvals (Bot/Autor zählen nicht als Mensch). Kombiniert mit der
  getrennten Agent-Identität ([agent-identity.md](./agent-identity.md)) ist der Self-Approval-Deadlock
  gelöst.
- `dismiss_stale_reviews: true` → ein neuer Push verwirft frühere Approvals; freigegeben wird immer
  der aktuelle HEAD.
- `required_linear_history: true` → nur Squash/Rebase-Merges (kein Merge-Commit).
