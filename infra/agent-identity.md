# Agent Identity — giving the coding agent its own GitHub principal

> Reproducible setup for the agent's GitHub identity. Theory: Framework §7 (Säule 2, separation of
> powers) — the producer (agent) must not be the approver (human). A GitHub App gives the agent its own
> principal so it can open PRs that a human CODEOWNER reviews and merges. This resolves the self-approval
> deadlock that `branch-protection.md` flags as the open issue ("until a separate agent identity + a
> second reviewer exist").

## Why

The agent is the **producer**: it writes code, pushes branches, and opens PRs. It must **not** merge or
approve them — that is the human's job, and it is the whole point of Säule 2. The gates plus a CODEOWNER
review are what make "weakening a gate needs separate, human approval" real.

But if the agent and the human share **one** GitHub identity, GitHub's self-approval rule fires: with
`required_approving_review_count: 1` and "Require review from Code Owners", you cannot approve your own
PR. One identity → every merge is blocked → **deadlock**. The only honest escape was the admin override
(`enforce_admins: false`), which is a backdoor, not a workflow.

The fix is to make the agent a **separate principal**. Then the human is genuinely a different account
and can review and approve the agent's PRs without tripping self-approval.

We use a **GitHub App** rather than a machine user, because:

- **Scales across repos** — one App installs onto any number of repos with no extra accounts, seats, or
  invitations to manage.
- **Short-lived tokens** — the App mints installation access tokens that expire in ~1 hour. There is no
  long-lived PAT sitting in a dotfile waiting to leak.
- **Works on personal repos** — on a personal account, fine-grained PATs do not grant a collaborator the
  access needed here; a GitHub App installed on the repo does. (This is a documented GitHub feature gap,
  not a misconfiguration on our side.)

> **Note on values.** The concrete IDs below are *this* setup's values. They are **not secrets** (App ID
> and Installation ID are public-ish identifiers), but if you reproduce this you must replace them with
> **your own**.
>
> | Thing | This setup's value (replace with yours) |
> | --- | --- |
> | Repo | `TMogdans/obol` |
> | App ID | `4084385` |
> | Installation ID | `141072400` |
> | Bot login | `sir-tobys-usefull-helper-agent[bot]` |
> | Bot numeric user ID | `294760428` |
> | Private key (local only) | `~/.ssh/…private-key.pem` |

## Create the App

GitHub → **Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**.

1. **Name** it (becomes the `…[bot]` login, e.g. `sir-tobys-usefull-helper-agent`).
2. **Homepage URL**: any valid URL (required field; not used).
3. **Webhook**: **uncheck "Active"**. The agent polls/pushes; it does not receive webhooks. No webhook =
   no endpoint to secure.
4. **Repository permissions** — grant only what the producer role needs:
   - **Contents**: **Read and write** (push branches)
   - **Pull requests**: **Read and write** (open PRs)
   - **Metadata**: **Read-only** (mandatory; granted automatically)
5. **Deliberately no Workflow scope.** CI definitions (`.github/workflows/**`) are part of the protected
   set the agent must not be able to rewrite. Withholding the workflow permission means the App's token
   cannot push changes to workflow files at all — defense in depth on top of CODEOWNERS.
6. **Where can this App be installed?** → **Only on this account.**
7. **Create**, then under **Private keys** → **Generate a private key**. A `.pem` downloads.
   Move it somewhere private and lock it down — never commit it:

   ```bash
   mv ~/Downloads/<app-name>.*.private-key.pem ~/.ssh/
   chmod 600 ~/.ssh/<app-name>.*.private-key.pem
   ```

Note the **App ID** shown on the App's settings page.

## Install it

On the App's page → **Install App** → install it on your account, scoped to the target repo(s)
(e.g. `TMogdans/obol`). After installing, the browser URL ends with the **Installation ID**:

```
https://github.com/settings/installations/141072400
                                          ^^^^^^^^^ Installation ID
```

Record it. App ID + Installation ID + private key are the three inputs the token minter needs.

## Local wiring

Two zero-dependency files live in `~/.config/obol-agent/`. They keep the bot's auth completely separate
from your personal git/`gh` setup: your SSH `origin` remote and your personal `gh` login are never
touched. The bot pushes over a one-off HTTPS URL with a short-lived token, and opens PRs with `GH_TOKEN`
set only for that single command.

### `mint-token.mjs` — the token minter

Mints a short-lived (~1 h) installation access token. Zero dependencies: it builds and signs an RS256 JWT
with Node's built-in `crypto`, exchanges it for an installation token via `fetch`, and prints **only the
token** to stdout (diagnostics go to stderr) so it can be consumed by other scripts. The token never
passes through argv or shell history.

```javascript
#!/usr/bin/env node
// Mint a short-lived GitHub App installation access token (valid ~1h).
// Zero dependencies: Node's built-in crypto (RS256 JWT) + fetch.
//
// Prints ONLY the token to stdout, so it can be consumed by other scripts:
//   TOKEN="$(node mint-token.mjs)"
// Diagnostics go to stderr.
//
// Config via env (with sensible defaults for this machine):
//   OBOL_AGENT_APP_ID            GitHub App ID
//   OBOL_AGENT_INSTALLATION_ID   Installation ID (App installed on the repo)
//   OBOL_AGENT_KEY               path to the App private key (.pem)

import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import { homedir } from "node:os";

const APP_ID = process.env.OBOL_AGENT_APP_ID ?? "4084385";
const INSTALLATION_ID = process.env.OBOL_AGENT_INSTALLATION_ID ?? "141072400";
const KEY_PATH =
  process.env.OBOL_AGENT_KEY ??
  `${homedir()}/.ssh/sir-tobys-usefull-helper-agent.2026-06-18.private-key.pem`;

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function makeJwt(appId, pem) {
  const now = Math.floor(Date.now() / 1000);
  // iat backdated 60s to tolerate clock skew; exp max 10 min per GitHub.
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(pem);
  return `${signingInput}.${b64url(signature)}`;
}

async function main() {
  let pem;
  try {
    pem = readFileSync(KEY_PATH, "utf8");
  } catch (e) {
    console.error(`[mint-token] cannot read key at ${KEY_PATH}: ${e.message}`);
    process.exit(1);
  }

  const jwt = makeJwt(APP_ID, pem);
  const res = await fetch(
    `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "obol-agent-token-minter",
      },
    },
  );

  if (!res.ok) {
    const body = await res.text();
    console.error(`[mint-token] token request failed: ${res.status} ${res.statusText}\n${body}`);
    process.exit(1);
  }

  const data = await res.json();
  console.error(`[mint-token] ok — token expires at ${data.expires_at}`);
  process.stdout.write(data.token);
}

main().catch((e) => {
  console.error(`[mint-token] unexpected error: ${e.message}`);
  process.exit(1);
});
```

The three inputs are env-overridable (`OBOL_AGENT_APP_ID`, `OBOL_AGENT_INSTALLATION_ID`,
`OBOL_AGENT_KEY`) and default to this machine's values — **replace the defaults, or set the env vars,
for your own App.**

### `env.sh` — the sourceable helpers

Source this to get three shell functions. It sets the bot as the commit author/committer **via process
env** (`GIT_AUTHOR_*` / `GIT_COMMITTER_*`), so it overrides identity for these commands only and never
rewrites the repo's git config or your personal identity. Tokens are cached in the shell session
(refreshed after 50 min) and stay out of argv.

```bash
#!/usr/bin/env bash
# Act as the GitHub App bot for the Obol agent loop, WITHOUT touching your
# personal git/gh auth or the repo's SSH `origin` remote.
#
#   source ~/.config/obol-agent/env.sh
#   agwhoami            # sanity check: token + identity, read-only
#   agpush [branch]     # push current HEAD as the bot (HTTPS + short-lived token)
#   agpr  <gh pr args>  # open a PR as the bot
#
# The bot is the PRODUCER. You (a CODEOWNER) review and merge. Different
# principals -> no self-approval deadlock.

# Fixed install location (works under bash and zsh, regardless of CWD).
OBOL_AGENT_DIR="${OBOL_AGENT_DIR:-$HOME/.config/obol-agent}"
OBOL_AGENT_REPO="${OBOL_AGENT_REPO:-TMogdans/obol}"

# Bot identity for commit author/committer. Uses process env (GIT_AUTHOR_* /
# GIT_COMMITTER_*) so it overrides for these commands only and never rewrites
# the repo's git config or your personal identity.
export GIT_AUTHOR_NAME="sir-tobys-usefull-helper-agent[bot]"
export GIT_AUTHOR_EMAIL="294760428+sir-tobys-usefull-helper-agent[bot]@users.noreply.github.com"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

# Mint an installation token and cache it for the shell session (valid ~1h;
# refreshed after 50 min). The token never appears in argv or shell history.
_obol_agent_token() {
  local now; now="$(date +%s)"
  if [ -z "${OBOL_AGENT_TOKEN:-}" ] || [ "$now" -ge "${OBOL_AGENT_TOKEN_EXP:-0}" ]; then
    OBOL_AGENT_TOKEN="$(node "$OBOL_AGENT_DIR/mint-token.mjs")" || return 1
    OBOL_AGENT_TOKEN_EXP="$(( now + 3000 ))"
    export OBOL_AGENT_TOKEN OBOL_AGENT_TOKEN_EXP
  fi
}

# Push current HEAD to <branch> as the bot. `origin` (your SSH remote) is left
# untouched; we push to the HTTPS URL with an inline credential helper that
# reads the token from the environment (so it stays out of argv).
agpush() {
  local branch="${1:-$(git rev-parse --abbrev-ref HEAD)}"
  _obol_agent_token || return 1
  git -c credential.helper= \
      -c credential.helper='!f() { echo username=x-access-token; echo "password=$OBOL_AGENT_TOKEN"; }; f' \
      push "https://github.com/$OBOL_AGENT_REPO.git" "HEAD:refs/heads/$branch"
}

# Open a PR as the bot.
agpr() {
  _obol_agent_token || return 1
  GH_TOKEN="$OBOL_AGENT_TOKEN" gh pr create --repo "$OBOL_AGENT_REPO" "$@"
}

# Read-only sanity check.
agwhoami() {
  _obol_agent_token || return 1
  echo "commit author : $GIT_AUTHOR_NAME <$GIT_AUTHOR_EMAIL>"
  GH_TOKEN="$OBOL_AGENT_TOKEN" gh api /installation/repositories \
    --jq '.repositories[].full_name' | sed 's/^/token scope   : /'
}
```

Key properties:

- **`origin` stays SSH and personal.** `agpush` pushes to a literal `https://github.com/<repo>.git` URL
  with an inline credential helper; it never reads or writes the `origin` remote.
- **`gh` stays your login.** `agpr`/`agwhoami` set `GH_TOKEN` only for that one invocation, so your
  interactive `gh auth` is untouched.
- **The bot is the committer.** Commits made under this shell carry the bot as author and committer, but
  the repo's `.git/config` is never modified.

## Use it

```bash
source ~/.config/obol-agent/env.sh

agwhoami            # read-only: prints the bot's commit identity + the repos the token can see
# ... agent does its work, commits on a feature branch ...
agpush my-feature   # push HEAD to refs/heads/my-feature as the bot
agpr --fill --base main --head my-feature   # open the PR as the bot
```

`agwhoami` is the cheap "is everything wired?" check. `agpush` defaults to the current branch name if you
omit the argument. `agpr` forwards all arguments straight to `gh pr create`.

## Verify

The throwaway-PR test proves the deadlock is actually resolved.

1. As the bot, push a trivial branch and open a PR:

   ```bash
   source ~/.config/obol-agent/env.sh
   git checkout -b chore/identity-smoke-test
   git commit --allow-empty -m "chore: identity smoke test"
   agpush chore/identity-smoke-test
   agpr --fill --base main --head chore/identity-smoke-test
   ```

2. Check authorship and review state (using **your personal** `gh`, not the bot's):

   ```bash
   gh pr view chore/identity-smoke-test --json author,reviewDecision
   ```

   You should see `author.login` = `app/sir-tobys-usefull-helper-agent` (i.e. the `…[bot]` principal) and
   `reviewDecision` = `REVIEW_REQUIRED`.

3. As the **human CODEOWNER**, approve it:

   ```bash
   gh pr review chore/identity-smoke-test --approve
   ```

   This now succeeds. Before the separate identity existed, GitHub blocked this as self-approval. That is
   the deadlock, gone.

4. Clean up:

   ```bash
   gh pr close chore/identity-smoke-test --delete-branch
   ```

## Why the bot is NOT in CODEOWNERS

The split of roles is the whole design: the **bot produces, the human approves**. Adding the bot to
[`.github/CODEOWNERS`](../.github/CODEOWNERS) would let the producer sign off on its own output and defeat
Säule 2. It would also not work: a GitHub App is not a user account and cannot be requested as a code
owner reviewer. CODEOWNERS stays exclusively human (`@tmogdans`).

## Security notes

- **The private key is the only long-lived secret.** Keep it outside the repo, `chmod 600`, and never
  commit it. Anyone with the `.pem` can mint tokens for the App. If it leaks, revoke it on the App's
  settings page and generate a new one.
- **Tokens are short-lived.** Installation access tokens expire in ~1 hour; `env.sh` re-mints them as
  needed. Nothing long-lived is written to disk or shell history.
- **App ID and Installation ID are not secret.** They are identifiers, safe to keep in scripts and in
  docs like this one. Only the private key (and the minted tokens) must be protected.
- **Least privilege.** The App holds only Contents + Pull requests (write) and Metadata (read), and
  deliberately no Workflow scope — so even a compromised token cannot rewrite the CI gates.
