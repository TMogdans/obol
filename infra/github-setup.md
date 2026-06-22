# GitHub-Setup — der vollständige Käfig (Anker b), reproduzierbar

> Die komplette GitHub-Konfiguration des Obol-Referenz-Repos, so wie sie **aktuell live ist**
> (Stand 2026-06-22; der Bindungs-Anker läuft über devloops composite action `@v0.7.1`, das
> Review-Modell ist seit v0.3.0 CODEOWNERS-nativ). Zweck:
> nachbaubar machen — Grundlage für einen Tutorial-Blogpost
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
geschützter Satz nur per Admin-Override. Die Staffelung ist **GitHub-nativ über CODEOWNERS-by-path**
(`require_code_owner_reviews: true` + `count: 0`); ein fail-closed Required-Check sichert Tamper,
Approval-Gültigkeit und CODEOWNERS-Drift; ein Auto-Merge-Workflow vollzieht den Merge.

## Bausteine (Überblick)

| Baustein | Datei / Ort | Rolle |
|---|---|---|
| Gate-Suite (Säule 2) | `.github/workflows/ci.yml` | nicht-korrumpierbare Checks (typecheck, lint, knip, test, mutation, arch, semgrep, squawk, tier, trace) |
| Bindungs-Anker (b) | `.github/workflows/devloop-precondition-check.yml` → `uses:` devloop composite action `@v0.7.1` | fail-closed Merge-Wächter: Tamper, Approval-Gültigkeit, Tier-Ableitung, CODEOWNERS-Drift |
| Merge-Vollzug | `.github/workflows/auto-merge.yml` | schaltet Auto-Merge für Bot-PRs scharf + zieht BEHIND-PRs nach |
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

## Schritt 3 — Gate-Suite

`.github/workflows/ci.yml` definiert die Required-Jobs (Job-Name = Check-Kontext). Der Bindungs-Anker
(Schritt 4) braucht **keine** devloop-devDependency mehr: Seit devloop v0.7 referenziert er eine
öffentliche composite action, die ihr `dist/` selbst mitbringt (kein Vendoring, kein CI-Token, läuft
in jeder Org).

## Schritt 4 — Tier-gestufter Bindungs-Anker

`.github/workflows/devloop-precondition-check.yml` läuft auf `pull_request` **und**
`pull_request_review` (das menschliche Approve re-triggert ihn), checkt immer den PR-HEAD aus
(`pull_request.head.sha`, weil `github.base_ref` auf dem Review-Event leer ist) und referenziert
die devloop composite action (`uses: mayflower/devloop/.github/actions/precondition-check@v0.7.1`,
`github-token: ${{ github.token }}`), die intern vier getestete Prüfungen fährt — keine
Logik-Duplikation, kein Vendoring:

- `derive-tier` leitet das **autoritative** Tier aus dem Diff ab (nicht agent-deklariert, einzige Wahrheit).
- `check-codeowners` ist der **Drift-Wächter**: jeder T2/T3-Pfad der tier-map muss in CODEOWNERS abgedeckt sein.
- `verify-review` failt **fail-closed** auf Gate-Tampering (geschützter Satz) und auf ein **ungültiges**
  Approval (Agent/Autor self-approve oder veraltet). Den *Zwang* zum T2/T3-Approval übernimmt die Branch
  Protection (CODEOWNERS), nicht dieser Check — so bleibt kein lingering FAILURE über die zwei Events hängen.
- `verify-unskip` sichert die Test↔Code-Naht (implement entfernt nur `.skip`).

Der Workflow-Dateiname enthält `devloop-precondition-check` (so erkennt `devloop check-guardians`
den Anker).

## Schritt 5 — Branch Protection (gh api)

Das **Review-Objekt** erzwingt Code-Owner-Reviews pfad-sensitiv bei `required_approving_review_count: 0`
— so liefert CODEOWNERS die Tier-Staffelung GitHub-nativ. Die `contexts` sind die Job-Namen aus
`ci.yml` **plus** `devloop-precondition-check`.

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
  "required_pull_request_reviews": {
    "require_code_owner_reviews": true,
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": true,
    "require_last_push_approval": false
  },
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
Required Checks grün sind und das (für das Tier nötige) CODEOWNERS-Review vorliegt**. Der Workflow
braucht **kein eigenes Tier-Wissen** — Branch Protection (Checks + CODEOWNERS) ist die Bedingung:
T0/T1 sofort, T2/T3 nach Owner-Approval. Serverseitig = unabhängig von der lokalen Agent-Session.

Ein zweiter, `push:main`-getriggerter Job (`update-behind-auto-merge-prs`) zieht nach jedem Merge offene
Auto-Merge-PRs per `gh pr update-branch` nach: bei `strict`-Branch-Protection feuert das native
Auto-Merge sonst nicht, solange ein PR `BEHIND` ist (Pilot-Befund 2026-06-21, wallet-topup #29/#30).

## Verifikation

```bash
devloop check-guardians .            # exit 0 = alle 4 Wächter stehen
gh api repos/<owner>/<repo>/branches/main/protection \
  --jq '{checks:.required_status_checks.contexts|length, code_owner_reviews:.required_pull_request_reviews.require_code_owner_reviews, approvals:.required_pull_request_reviews.required_approving_review_count}'
```

Echter End-to-End-Test: ein **T1**-Bot-PR (reine Docs) muss ohne Approval grün durchlaufen und sich
serverseitig selbst mergen (`mergedBy: app/github-actions`).

## Das resultierende Merge-Modell (§9)

| Tier / Fall | mergebar, wenn … | Merge |
|---|---|---|
| **T0/T1** (kein CODEOWNER-Pfad) | alle Required Checks grün | Auto-Merge sofort (0 Approvals) |
| **T2** (`services/**`) | Checks grün + CODEOWNER-Approval auf HEAD | Auto-Merge nach Approval |
| **T3** (Migrations/auth/contracts/tools) | Checks grün + CODEOWNER-Approval auf HEAD | Auto-Merge nach Approval |
| **geschützter Satz** | nie ohne Admin-Override (precondition-check failt auf `protected-set-touched`) | Mensch + Override (Käfig-Bau) |

> Die Tier-Unterscheidung liefert **CODEOWNERS-by-path** GitHub-nativ — „alle Required Checks grün +
> nötiges Owner-Review" = „mergebar". Der Auto-Merge-Workflow bleibt dadurch tier-agnostisch; der
> precondition-check ist Wächter (Tamper/Approval-Gültigkeit/Drift), kein Approval-Tor.
