#!/bin/zsh
# FLY-2922 verify-then-submit hand-in (implement node). Run from the sandbox repo root under TURN.
#   LANE=A  (default) complete without --pr; prod PR cited in the report only.
#   LANE=B  open a docs-only sandbox PR first (only when the Lead explicitly asks for it).
#   DRY_RUN=1 run only the read-only assertions (design-node self check); never writes or reports.
set -u
EXPECT=2dd29e0276617cf21e31ce4bfe2a4df792d8cf0a
PROD=/Users/xiaorongli/Dev/flywheel-FLY-2922
PROD_REPO=xrliAnnie/flywheel
PROD_PR=1374
REVIEW_ID=92e28887
SANDBOX_BRANCH=project-slot-2-FLY-2922
DOC=engineering/doc/FLY-2922-unified-node-recovery
LEDGER=$DOC/progress.md
LANE=${LANE:-A}
DRY_RUN=${DRY_RUN:-0}
typeset -a DONE_STEPS
DONE_STEPS=()

fail() {
  local msg="BLOCKED-DETAIL: FLY-2922 verify-then-submit | failed: $1 | detail: $2 | completed steps: ${(j:,:)DONE_STEPS:-none} | action taken: no checkout/reset/stash on prod, no re-push, no code change | waiting for a new Lead instruction (not polling)"
  print -u2 -r -- "$msg"
  if [[ $DRY_RUN == 0 ]]; then
    node "$FLYWHEEL_COMM_CLI" ask --lead flywheel-test-2 --exec-id "$FLYWHEEL_EXEC_ID" --report "$msg" || print -u2 -- "report send failed (exit $?)"
  fi
  exit 1
}

# ---- Task 0: env, cwd, TURN ------------------------------------------------
[[ -n ${FLYWHEEL_COMM_CLI:-} && -f $FLYWHEEL_COMM_CLI ]] || fail env "FLYWHEEL_COMM_CLI missing"
[[ -n ${FLYWHEEL_EXEC_ID:-} ]] || fail env "FLYWHEEL_EXEC_ID missing"
[[ $LANE == A || $LANE == B ]] || fail env "LANE must be A or B (got $LANE)"
top=$(git rev-parse --show-toplevel 2>&1) || fail cwd "not a git worktree: $top"
[[ ${top:A} == ${PWD:A} ]] || fail cwd "run from the sandbox repo root ($top)"
branch=$(git branch --show-current 2>&1) || fail cwd "$branch"
[[ $branch == $SANDBOX_BRANCH ]] || fail cwd "branch=$branch expected=$SANDBOX_BRANCH"
if [[ $DRY_RUN == 0 ]]; then
  turn=$(node "$FLYWHEEL_COMM_CLI" turn --exec-id "$FLYWHEEL_EXEC_ID" 2>&1) || fail turn "turn command exit $? : $turn"
  if [[ $turn != yours* ]]; then print -- "TURN not yours ($turn): wait 60-90s and re-run; not a failure"; exit 3; fi
  [[ $turn == *phase=implement* ]] || fail turn "unexpected TURN phase: $turn"
fi
DONE_STEPS+=(task0)

# ---- Task 1: read-only assertions -------------------------------------------
git fetch origin flywheel-FLY-2922 >/dev/null 2>&1 || fail A0 "sandbox fetch origin flywheel-FLY-2922 exit $?"
mirror=$(git rev-parse --verify origin/flywheel-FLY-2922 2>&1) || fail A1 "$mirror"
[[ $mirror == $EXPECT ]] || fail A1 "mirror=$mirror expected=$EXPECT"
prod_head=$(git -C "$PROD" rev-parse --verify HEAD 2>&1) || fail A2 "$prod_head"
[[ $prod_head == $EXPECT ]] || fail A2 "prod HEAD=$prod_head expected=$EXPECT"
prod_branch=$(git -C "$PROD" branch --show-current 2>&1) || fail A3 "$prod_branch"
[[ $prod_branch == flywheel-FLY-2922 ]] || fail A3 "prod branch=$prod_branch"
prod_status=$(git -C "$PROD" status --porcelain 2>&1) || fail A4 "$prod_status"
[[ -z $prod_status ]] || fail A4 "prod tree dirty: ${prod_status//$'\n'/ ; }"
remote_line=$(git -C "$PROD" ls-remote --exit-code origin refs/heads/flywheel-FLY-2922 2>&1) || fail A5 "ls-remote exit $? : $remote_line"
[[ ${remote_line%%$'\t'*} == $EXPECT ]] || fail A5 "remote=${remote_line%%$'\t'*} expected=$EXPECT"
git -C "$PROD" cat-file -e "${EXPECT}:engineering/doc/milestones/FLY-2922.md" 2>/dev/null || fail A6 "milestone file missing in $EXPECT"
sb_status=$(git status --porcelain 2>&1) || fail A7 "$sb_status"
[[ -z $sb_status ]] || fail A7 "sandbox tree dirty: ${sb_status//$'\n'/ ; }"
# A8: production PR head + body markers (read-only). Outcomes: PASS | UNVERIFIABLE (gh unreachable / empty / unparsable) | BLOCKED (valid head that differs)
A8_STATUS=UNVERIFIABLE; A8_REASON=""; MISSING=""
if pr_json=$(gh pr view "$PROD_PR" --repo "$PROD_REPO" --json state,headRefOid,body 2>&1); then
  if pr_parsed=$(print -r -- "$pr_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch(e){process.exit(2)}if(!/^[0-9a-f]{40}$/.test(String(j.headRefOid||""))||typeof j.body!=="string"){process.exit(3)}process.stdout.write(j.headRefOid+"\n"+j.body)})' 2>/dev/null); then
    pr_head=${pr_parsed%%$'\n'*}
    pr_body=${pr_parsed#*$'\n'}
    [[ $pr_head == $EXPECT ]] || fail A8 "PR $PROD_REPO#$PROD_PR head=$pr_head expected=$EXPECT"
    typeset -a missing; missing=()
    for m in 'FLY-2921 must land first' preadmission-producer-rework-carveout merge-order-dependency-unstated shared-materializer-preconditions rework-replacement-context-not-preflighted exhausted-return-alert-advertises-refused-door "$REVIEW_ID"; do
      print -r -- "$pr_body" | grep -qF -- "$m" || missing+=("$m")
    done
    A8_STATUS=PASS; MISSING="${(j:,:)missing:-none}"
  else
    A8_REASON="gh output empty or unparsable (parse exit $?)"
  fi
else
  A8_REASON="gh exit $? : ${pr_json:0:100}"
fi
if [[ $A8_STATUS == PASS ]]; then
  PR_NOTE="A8=PASS (PR $PROD_REPO#$PROD_PR head == $EXPECT; body missing markers: $MISSING; sandbox never edits the prod PR — missing items are host-side Lead work)"
else
  PR_NOTE="A8=UNVERIFIABLE ($A8_REASON); prod PR head/body not observed from the sandbox"
fi
ASSERT_NOTE="A1-A7 PASS; $PR_NOTE"
DONE_STEPS+=(A1-A7 "A8=$A8_STATUS")
if [[ $DRY_RUN == 1 ]]; then print -- "DRY_RUN OK: $ASSERT_NOTE | head $EXPECT"; exit 0; fi

# ---- Task 2: ledger, push, freeze ---------------------------------------------
node "$FLYWHEEL_COMM_CLI" progress --exec-id "$FLYWHEEL_EXEC_ID" --file "$LEDGER" --phase implement --cursor 3/3 \
  --next "$ASSERT_NOTE; head $EXPECT; lane $LANE; next: report + complete needs_review" || fail ledger "progress exit $?"
DONE_STEPS+=(ledger)
post=$(git status --porcelain 2>&1) || fail ledger "$post"
[[ -z $post ]] || fail ledger "tree dirty after progress: ${post//$'\n'/ ; }"
git push -u origin "$SANDBOX_BRANCH" || fail push "push exit $?"
DONE_STEPS+=(push)
local_head=$(git rev-parse HEAD)
remote_sb=$(git ls-remote --exit-code origin "refs/heads/$SANDBOX_BRANCH" 2>&1) || fail push-sync "ls-remote exit $? : $remote_sb"
[[ ${remote_sb%%$'\t'*} == $local_head ]] || fail push-sync "remote=${remote_sb%%$'\t'*} local=$local_head"
# From here on the sandbox branch is read-only (mutation freeze).

# ---- Lane B only: docs-only sandbox PR ----------------------------------------
SANDBOX_PR=""
if [[ $LANE == B ]]; then
  [[ -f $DOC/handin-body.md ]] || fail laneB "$DOC/handin-body.md missing"
  pr_url=$(gh pr create --base main --head "$SANDBOX_BRANCH" --title "docs(FLY-2922): design-node verify-then-submit contract" --body-file "$DOC/handin-body.md" 2>&1) || fail laneB "gh pr create exit $? : $pr_url"
  SANDBOX_PR=${pr_url##*/}
  [[ $SANDBOX_PR == <1-> ]] || fail laneB "could not parse PR number from: $pr_url"
  DONE_STEPS+=(sandbox-pr-$SANDBOX_PR)
fi

# ---- Task 3: report, complete ---------------------------------------------------
report="DONE: FLY-2922 verify-then-submit | verified implementation head: $EXPECT (sandbox origin/flywheel-FLY-2922 = prod checkout $PROD @flywheel-FLY-2922 = GitHub $PROD_REPO refs/heads/flywheel-FLY-2922; both trees clean; $ASSERT_NOTE) | sandbox hand-in HEAD (docs only, $SANDBOX_BRANCH): $local_head | code review: $REVIEW_ID APPROVED (Lead hand-off 2026-09-27 12:09:19Z) | prod PR: $PROD_REPO#$PROD_PR | MEDIUM dispositions (as in PR body): carveout=landed (rework_delivery_owned); merge-order=stated (FLY-2921 lands first, 5357dd5ce merged); shared-materializer=landed (materializeReworkReplacementCoreTx revalidates tx/run status/tuple/writer/owner/budget); context-preflight=landed (stage+apply return HTTP 409 with the specific reason, invalid context = engine_rework_replacement_context_invalid; digest rechecked in tx) | LOW follow-ups: PR body sections Follow-ups + Follow-ups from effective code review round 4 | commits: none to code | lane: $LANE${SANDBOX_PR:+ sandbox PR #$SANDBOX_PR}"
node "$FLYWHEEL_COMM_CLI" ask --lead flywheel-test-2 --exec-id "$FLYWHEEL_EXEC_ID" --report "$report" || fail report "ask --report exit $?"
DONE_STEPS+=(report)
summary="FLY-2922: verified implementation head $EXPECT (code review $REVIEW_ID APPROVED, prod PR $PROD_REPO#$PROD_PR); sandbox hand-in is docs-only; no code changes; submit to QA"
if [[ $LANE == B ]]; then
  node "$FLYWHEEL_COMM_CLI" complete --route needs_review --pr "$SANDBOX_PR" --summary "$summary" || fail complete "complete exit $?"
else
  node "$FLYWHEEL_COMM_CLI" complete --route needs_review --summary "$summary" || fail complete "complete exit $?"
fi
print -- "hand-in complete (lane $LANE); this node is terminal — exit without polling turn or verify-approval"
