# CLAUDE.md — Arbeitsanweisungen für Coding-Agenten in Obol

Was Obol *ist* (append-only Ledger, Effect-TS, Postgres, NATS) steht in [README.md](./README.md).
Diese Datei sagt, *wie* ein Agent hier arbeitet.

## Kontext: Obol ist ein devloop-Pilot

Obol dient als Erprobungs- und Blogserie-Beispiel für das **devloop**-Framework (agentische
Dev-Loop-Kette, `https://github.com/mayflower/devloop`). `main` ist geschützt: Merge nur mit
allen grünen Gates **und** einem menschlichen CODEOWNER-Approval auf dem aktuellen HEAD. Der
Agent kann sich nicht selbst freigeben (Anker b, `devloop-precondition-check`).

## Agent-Identität — als Bot committen/pushen/PRs öffnen

Der Agent ist ein **eigener GitHub-Principal** (GitHub App), getrennt vom Menschen `@tmogdans`:
der Bot **produziert** (Branches, PRs), der Mensch **reviewt + merged**. Das löst den
Self-Approval-Deadlock. Um als Bot zu agieren (Helfer in `~/.config/obol-agent/`, nicht im Repo):

```bash
source ~/.config/obol-agent/env.sh
agwhoami            # read-only Check: Token (~1h) + Identität + Repo-Scope
agpush [branch]     # pusht HEAD als Bot (HTTPS + ephemerer Token); origin/SSH bleibt der Mensch
agpr <gh pr args>   # öffnet PR als Bot, z.B.  agpr --base main --head <branch> --title … --body …
```

Volldoku: [infra/agent-identity.md](./infra/agent-identity.md). `origin` und der persönliche
`gh`-Login bleiben unangetastet.

## Wie Änderungen nach main kommen

- **Normaler Code/Docs (T1/T2):** als **Bot** pushen + PR öffnen → Mensch approved → Gates grün →
  Merge. (Pusht der Mensch selbst, ist er PR-Autor und kann nicht approven → nur Admin-Override.)
- **Geschützter Satz** (CI-Workflows, Gate-Configs, `tools/`, `.devloop/`, Manifeste — siehe
  [.github/CODEOWNERS](./.github/CODEOWNERS)): löst den `protected-set-touched`-Alarm aus und
  braucht den Admin-Override (Käfig-Bau, T3) — das ist gewollt, kein Schlupfloch.
- **Features:** durch `/devloop:loop` schicken (specify → spec-to-tests → implement → critic).

## Pilot-Log

Stolpersteine (Gates, Rechte-Grenzen, sichtbar gewordene Lücken) in
[docs/pilot-log.md](./docs/pilot-log.md) festhalten — Material für Blog + Rückmeldung an devloop.
