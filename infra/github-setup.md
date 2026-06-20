# GitHub-Setup — der vollständige Käfig (Anker b), reproduzierbar

> Die komplette GitHub-Konfiguration des Obol-Referenz-Repos, so wie sie **aktuell live ist**
> (Stand 2026-06-20). Zweck: nachbaubar machen — Grundlage für einen Tutorial-Blogpost
> („So baust du einen verantwortbaren agentischen Merge-Käfig"). Theorie: Framework §3 (Gewalten-
> teilung), §7 (geschützter Satz / „Ort" der Gates), §9 (Risiko-Staffel), §1.3/§1.4 (Containment).
>
> Detail-Dokumente: [agent-identity.md](./agent-identity.md) (GitHub App) ·
> [branch-protection.md](./branch-protection.md) (Branch Protection im Detail).

## Das Modell in einem Absatz

Der Agent ist ein **eigener GitHub-Principal** (App), der **produziert** (Branches, PRs), aber nie
**merged/approved** — das tut der Mensch bzw. der serverseitige Auto-Merge. Die Autorität sitzt
**server-seitig** (Anker b): Required CI-Checks + Branch Protection, die der Agent nicht umgehen
kann. Der Merge ist **risiko-gestaffelt** (§9): T0/T1 auto, T2/T3 nach menschlichem Approval,
geschützter Satz nur per Admin-Override. Ein tier-gestufter Required-Check kapselt diese Regel;
ein Auto-Merge-Workflow vollzieht sie.

## Bausteine (Überblick)

| Baustein | Datei / Ort | Rolle |
|---|---|---|
| Gate-Suite (Säule 2) | `.github/workflows/ci.yml` | nicht-korrumpierbare Checks (typecheck, lint, knip, test, mutation, arch, semgrep, squawk, tier, trace) |
| Bindungs-Anker (b) | `.github/workflows/devloop-precondition-check.yml` + `tools/devloop-precondition-gate.mjs` | tier-gestuftes Merge-Gate (kapselt §9) |
| Merge-Vollzug | `.github/workflows/auto-merge.yml` | schaltet GitHubs Auto-Merge für Bot-PRs scharf |
| Geschützter Satz | `.github/CODEOWNERS` + `.devloop/{bot-logins,protected-globs}.json` | was der Agent nicht einseitig ändern darf |
| Risiko-Staffel | `tools/tier-map.json` + `tools/derive-tier-cli.ts` | Tier deterministisch aus Pfaden (einzige Wahrheit) |
| Agent-Identität | GitHub App (s. agent-identity.md) | Produzent-Principal, getrennt vom Menschen |

## Schritt 1 — Agent-Identität (GitHub App)

Vollständig in [agent-identity.md](./agent-identity.md). Kern: eine GitHub App mit **Contents:
write + Pull requests: write + Metadata: read** und **bewusst KEIN `workflows`-Scope** (so kann
der Agent-Token CI-Definitionen nicht ändern — Capability-Grenze über CODEOWNERS hinaus, §7).
Login (`…[bot]`) in `.devloop/bot-logins.json` eintragen.

## Schritt 2 — Geschützter Satz (CODEOWNERS + .devloop)

`.github/CODEOWNERS`: alle Pfade, deren Änderung die *Verifikation* ändert (CI, Gate-Configs,
`tools/`, `.devloop/`, `.specify/`, Manifeste) → `@<mensch>`. Der Agent-Bot ist **nicht** Code
Owner (er soll nicht sein eigenes Output abnehmen).

`.devloop/protected-globs.json`: dieselbe Menge als Glob-Liste (der Check liest sie für den
`protected-set-touched`-Alarm). `.devloop/bot-logins.json`: die Bot-Logins (zählen nie als Mensch).

## Schritt 3 — Gate-Suite + devloop-CLIs

`.github/workflows/ci.yml` definiert die Required-Jobs (Job-Name = Check-Kontext). Die devloop-CLIs
kommen als **git-gepinnte devDependency** (public Repo → kein CI-Token):

```bash
pnpm add -D -w "github:mayflower/devloop#<commit-sha>"
```

## Schritt 4 — Tier-gestufter Bindungs-Anker

`.github/workflows/devloop-precondition-check.yml` leitet das Tier **nicht selbst ab**, sondern
konsumiert Obols `pnpm run tier` (einzige Wahrheit) und ruft `tools/devloop-precondition-gate.mjs`:

- `protected-set` berührt → **fail** (immer; Mensch-Gate + Admin-Override)
- Tier **T2/T3** → menschliches CODEOWNER-Approval auf HEAD nötig
- Tier **T0/T1** → grün **ohne** Approval

Der Workflow-Dateiname enthält `devloop-precondition-check` (so erkennt `devloop check-guardians`
den Anker). Das Gate konsumiert devloops getestete core-Funktionen (`evaluateApproval`,
`touchesProtectedSet`) — keine Logik-Duplikation.

## Schritt 5 — Branch Protection (gh api)

Die Review-Pflicht lebt **nicht** global in der Branch Protection, sondern tier-gestuft im
precondition-check. Darum: `required_pull_request_reviews: null`. Die `contexts` sind die
Job-Namen aus `ci.yml` **plus** `devloop-precondition-check`.

```bash
gh api -X PUT repos/<owner>/<repo>/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "typecheck (tsc -b)", "lint (biome)", "knip (dead code / unused deps)",
      "test + coverage (vitest, Testcontainers)", "mutation (stryker, balance projection)",
      "arch (dependency-cruiser)", "escape-hatches (semgrep)", "migrations (squawk)",
      "tier (deterministic risk-tier derivation)", "devloop-precondition-check"
    ]
  },
  "required_pull_request_reviews": null,
  "enforce_admins": false,
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

- **`enforce_admins: false`** ist bewusst: der menschliche Owner behält den Notfall-Admin-Override
  (für den Käfig-Bau und den T3-Merge). In echtem Betrieb läuft der Agent unter einer eigenen
  Nicht-Admin-Identität, hat den Override also nicht.
- **`required_linear_history: true`** → nur Squash/Rebase-Merges.

## Schritt 6 — Repo-Settings (gh api)

```bash
gh api -X PATCH repos/<owner>/<repo> \
  -F allow_auto_merge=true \
  -F delete_branch_on_merge=true \
  -F allow_merge_commit=false   # nur Squash/Rebase (passt zu linear history)
```

(Aktueller Live-Stand: `allow_auto_merge: true`, `delete_branch_on_merge: true`. `allow_merge_commit`
steht noch auf `true` — bei `required_linear_history` faktisch ungenutzt; `false` macht es explizit.)

## Schritt 7 — Auto-Merge-Vollzug

`.github/workflows/auto-merge.yml` schaltet für **Bot-PRs** GitHubs natives Auto-Merge scharf
(`gh pr merge --auto --squash`). Der Merge passiert serverseitig (GITHUB_TOKEN), **sobald alle
Required Checks grün sind**. Weil der precondition-check §9 kapselt, braucht der Workflow **kein
eigenes Tier-Wissen**: T0/T1 sofort, T2/T3 nach Approval. Serverseitig = unabhängig von der lokalen
Agent-Session.

## Verifikation

```bash
devloop check-guardians .            # exit 0 = alle 4 Wächter stehen
gh api repos/<owner>/<repo>/branches/main/protection \
  --jq '{checks:.required_status_checks.contexts|length, reviews:(.required_pull_request_reviews//"—")}'
```

Echter End-to-End-Test: ein **T1**-Bot-PR (reine Docs) muss ohne Approval grün durchlaufen und sich
serverseitig selbst mergen (`mergedBy: app/github-actions`).

## Das resultierende Merge-Modell (§9)

| Tier / Fall | precondition-check grün, wenn … | Merge |
|---|---|---|
| **T0/T1** | alle Gates grün | Auto-Merge sofort |
| **T2** | grün + 1 CODEOWNER-Approval auf HEAD | Auto-Merge nach Approval |
| **T3** | grün + CODEOWNER-Approval auf HEAD | Auto-Merge nach Approval |
| **geschützter Satz** | nie ohne Admin-Override | Mensch + Override (Käfig-Bau) |

> Die Tier-Unterscheidung ist **im Check gekapselt** — „alle Required Checks grün" = „nach §9
> mergebar". Der Auto-Merge-Workflow bleibt dadurch tier-agnostisch.
