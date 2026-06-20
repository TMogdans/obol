// Tier-gestuftes Merge-Gate für den devloop-Anker (b), §9.
//
// KONSUMIERT zwei bestehende Wahrheiten — leitet selbst nichts ab, dupliziert keine Logik:
//   - das Tier kommt fertig auf stdin (aus Obols `pnpm run tier` = tools/derive-tier-cli.ts),
//   - die Approval-/Protected-Set-Logik aus devloops getesteten core-Funktionen.
//
// Gating (§9):
//   - protected-set berührt  -> FAIL (immer, tier-unabhängig; "Gate statt Code geändert"-Alarm).
//   - Tier T2 / T3           -> menschliches CODEOWNER-Approval auf dem aktuellen HEAD nötig.
//   - Tier T0 / T1           -> OK ohne Approval (es gibt nichts freizugeben; der
//                               Self-Approval-Schutz engagiert hier gar nicht -> §9-Auto-Merge).
//
// stdin JSON: { tier, reviews, prAuthor, headSha, botLogins, humanReviewers, diffPaths, protectedGlobs }
import { readFileSync } from "node:fs";
import { touchesProtectedSet } from "devloop/dist/core/protected-set.js";
import { evaluateApproval } from "devloop/dist/core/review.js";

const req = JSON.parse(readFileSync(0, "utf8"));
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const fail = (reason) => {
  out({ ok: false, tier: req.tier, reason });
  process.exit(1);
};

// 1. Geschützter Satz: IMMER prüfen, unabhängig vom Tier. Eine reine `.github/`-Änderung ist
//    z.B. per tier-map nur T1, berührt aber den geschützten Satz -> muss trotzdem ans Mensch-Gate.
if (touchesProtectedSet(req.diffPaths ?? [], req.protectedGlobs ?? [])) {
  fail(
    "protected-set-touched: der Diff ändert eine Gate-/Wächter-Config (Mensch-Gate + Admin-Override)",
  );
}

// 2. Tier-gestuftes Approval: nur T2/T3 verlangen einen menschlichen CODEOWNER auf HEAD.
if (req.tier === "T2" || req.tier === "T3") {
  const status = evaluateApproval(req.reviews ?? [], req);
  if (status !== "ok") {
    fail(
      `human-approval-${status}: Tier ${req.tier} verlangt das Approval eines menschlichen CODEOWNERs auf dem aktuellen HEAD (Agent/Autor können nicht selbst freigeben)`,
    );
  }
}

// 3. T0/T1 (ohne protected-set) -> kein Approval nötig.
out({ ok: true, tier: req.tier });
