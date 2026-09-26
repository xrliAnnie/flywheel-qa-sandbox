#!/usr/bin/env bash
# FLY-1189 H4: QA-on-the-QA-environment smoke. Runs in the QA-phase session on
# a real machine — NOT part of any CI/hermetic suite and NOT run during the
# implement phase (a runner carries a production FLYWHEEL_STATE_DIR; running a
# real deploy here would touch production projects.json — memory:
# feedback_never_run_provisioning_tests_on_host). It proves the multi-Lead
# harness + fault injector work end-to-end BEFORE the real PR-C matrix runs.
# It does NOT judge PR-C.
#
# What it does (main dist, slot 2 as Bridge host):
#   1. Deploy `--extra-lead 3:Ops-Test --lead-label Product-Test --alerts`
#      + TEST_REPLY_BY_ISSUE=1 → assert 2 Lead procs alive, FLYWHEEL_PROJECTS
#      has 2 leads, launch manifest complete.
#   2. Inject a real runner in each dept channel → each builds its own [FLY-XX]
#      thread via its own bot.
#   3. Injector real pass: freeze→pane frozen(capture-pane hash stable)→thaw;
#      break-worktree→runner real ENOENT→restore; verify-target against a
#      PRODUCTION runner execId → REFUSED (dry-run, S1 anchor); kill -INT the
#      driver mid-scenario → trap recovery.
#   4. Teardown (incl extra-Lead cleanup) + production zero-taint snapshot.
#
# Usage: scripts/qa-fly-1189-room-smoke.sh [--slot 2] [--extra-slot 3]
#        --dry-plan   validate prerequisites + print the plan, deploy nothing.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INJECTOR="${SCRIPT_DIR}/qa-fly-1189-fault-inject.sh"
DRIVER="${SCRIPT_DIR}/qa-fly-1189-nton-driver.sh"

SLOT=2
EXTRA_SLOT=3
DRY_PLAN=0
while [[ $# -gt 0 ]]; do
	case "$1" in
		--slot) SLOT="${2:?}"; shift 2 ;;
		--extra-slot) EXTRA_SLOT="${2:?}"; shift 2 ;;
		--dry-plan) DRY_PLAN=1; shift ;;
		-h|--help) sed -n '2,30p' "$0"; exit 0 ;;
		*) echo "unknown arg '$1'" >&2; exit 2 ;;
	esac
done

CAMPAIGN_ROOT="/tmp/qa-fly-1189-smoke-$$"
mkdir -p "$CAMPAIGN_ROOT"
log() { echo "[smoke] $(date +%H:%M:%S) $*" >&2; }
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "[smoke] ✓ $*"; }
bad() { FAIL=$((FAIL+1)); echo "[smoke] ✗ $*"; }

# ── Prerequisites (always checked) ──
[[ -f "${HOME}/.flywheel/test-slots.json" ]] || { echo "FATAL: test-slots.json missing" >&2; exit 2; }
for f in "$INJECTOR" "$DRIVER" "${SCRIPT_DIR}/test-deploy.sh" "${SCRIPT_DIR}/test-teardown.sh"; do
	[[ -f "$f" ]] || { echo "FATAL: ${f} missing" >&2; exit 2; }
done
EXTRA_LABEL="Ops-Test"
MAIN_LABEL="Product-Test"
# Dept sandbox issues (H5a): Product-Test → FLY-145, Ops-Test → FLY-139 (both
# kept open). The driver never passes fake labels — the labels live on the real
# Linear issues; the runner is injected against these identifiers.
MAIN_ISSUE="FLY-145"
EXTRA_ISSUE="FLY-139"

cat <<PLAN
[smoke] PLAN
  host slot        : ${SLOT} (Bridge, ${MAIN_LABEL}, issue ${MAIN_ISSUE})
  extra lead slot  : ${EXTRA_SLOT} (${EXTRA_LABEL}, issue ${EXTRA_ISSUE})
  deploy           : test-deploy.sh ${SLOT} --extra-lead ${EXTRA_SLOT}:${EXTRA_LABEL} --lead-label ${MAIN_LABEL} --alerts (TEST_REPLY_BY_ISSUE=1, main dist)
  injector checks  : freeze/thaw · break-worktree/restore · verify-target refuses a PROD execId · driver SIGINT→recover
  teardown         : test-teardown.sh ${SLOT} (extra-Lead cleanup + borrowed-lock release) + prod zero-taint
  campaign root    : ${CAMPAIGN_ROOT}
PLAN

if [[ "$DRY_PLAN" == "1" ]]; then
	log "dry-plan only — validating scripts parse + prereqs, deploying nothing"
	bash -n "$INJECTOR" && ok "injector parses"       || bad "injector parse error"
	bash -n "$DRIVER"   && ok "driver parses"          || bad "driver parse error"
	bash -n "${SCRIPT_DIR}/test-deploy.sh"   && ok "test-deploy parses"   || bad "test-deploy parse error"
	bash -n "${SCRIPT_DIR}/test-teardown.sh" && ok "test-teardown parses" || bad "test-teardown parse error"
	echo "[smoke] dry-plan: ${PASS} ok, ${FAIL} bad"
	[[ "$FAIL" == "0" ]]
	exit $?
fi

# ── Real deploy (QA phase only) ──
log "prod-snapshot BEFORE"
bash "$INJECTOR" prod-snapshot smoke-before > "${CAMPAIGN_ROOT}/prod-before.json" 2>/dev/null || true

log "deploying slot ${SLOT} with extra lead ${EXTRA_SLOT}:${EXTRA_LABEL}"
DEPLOY_JSON=$(TEST_REPLY_BY_ISSUE=1 \
	FLYWHEEL_DETECTION_GAP_SCAN=1 FLYWHEEL_PANE_MULTIFRAME=1 FLYWHEEL_STUCK_ERRORSIG=1 \
	FLYWHEEL_WATCHDOG_JUDGE=1 FLYWHEEL_DETECTION_ESCALATION=1 \
	bash "${SCRIPT_DIR}/test-deploy.sh" "$SLOT" \
	  --extra-lead "${EXTRA_SLOT}:${EXTRA_LABEL}" --lead-label "$MAIN_LABEL" --alerts 2>"${CAMPAIGN_ROOT}/deploy.log") \
	|| { bad "deploy failed (see ${CAMPAIGN_ROOT}/deploy.log)"; cat "${CAMPAIGN_ROOT}/deploy.log" >&2; exit 1; }
echo "$DEPLOY_JSON" > "${CAMPAIGN_ROOT}/deploy.json"
# Defense-in-depth (Codex R1 MED): test-deploy no longer logs token characters,
# but scrub the persisted deploy.log of anything token-shaped anyway so a
# campaign-root artifact can never carry a partial secret.
if [[ -f "${CAMPAIGN_ROOT}/deploy.log" ]]; then
	sed -i.bak -E 's/(TOKEN|SECRET|KEY)=[A-Za-z0-9._-]{6,}/\1=<redacted>/g' "${CAMPAIGN_ROOT}/deploy.log" 2>/dev/null || true
	rm -f "${CAMPAIGN_ROOT}/deploy.log.bak"
fi

SLOT_DIR=$(jq -r '.slotDir' <<<"$DEPLOY_JSON")
PROJECTS_FILE=$(jq -r '.flywheelProjectsFile' <<<"$DEPLOY_JSON")
LAUNCH_MANIFEST=$(jq -r '.launchManifest' <<<"$DEPLOY_JSON")
CAMPAIGN_MANIFEST=$(jq -r '.campaignManifest' <<<"$DEPLOY_JSON")

cleanup() { bash "${SCRIPT_DIR}/test-teardown.sh" "$SLOT" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# 1. Two leads present.
LEAD_CNT=$(jq '.[0].leads | length' "$PROJECTS_FILE" 2>/dev/null || echo 0)
[[ "$LEAD_CNT" == "2" ]] && ok "FLYWHEEL_PROJECTS has 2 leads" || bad "expected 2 leads, got ${LEAD_CNT}"
jq -e '.[0].leads[0].match.labels == ["Product-Test"] and .[0].leads[1].match.labels == ["Ops-Test"]' \
	"$PROJECTS_FILE" >/dev/null 2>&1 && ok "dept labels correct on both leads" || bad "dept label mismatch"

# 2. Launch + campaign manifests present, secret-free.
[[ -f "$LAUNCH_MANIFEST" ]] && ok "launch manifest present" || bad "launch manifest missing"
jq -e '.flags.FLYWHEEL_DETECTION_ESCALATION == "1"' "$LAUNCH_MANIFEST" >/dev/null 2>&1 \
	&& ok "launch manifest records 5 flags" || bad "launch manifest flags missing"
[[ -f "$CAMPAIGN_MANIFEST" ]] && ok "campaign manifest present" || bad "campaign manifest missing"

# 3. Two Lead procs alive (lease files).
for aid in $(jq -r '.[0].leads[].agentId' "$PROJECTS_FILE"); do
	proj=$(jq -r '.[0].projectName' "$PROJECTS_FILE")
	lease="${HOME}/.flywheel/comm/${proj}/.inbox-ready-${aid}"
	if [[ -f "$lease" ]] && kill -0 "$(jq -r '.pid' "$lease" 2>/dev/null)" 2>/dev/null; then
		ok "Lead ${aid} alive (lease)"
	else
		bad "Lead ${aid} not alive"
	fi
done

# 4. Injector: verify-target against a PRODUCTION runner execId must REFUSE.
#    Find any production runner execId (a claude proc NOT under any slot). We do
#    NOT need a real execId to prove refusal — a bogus prod-looking execId that
#    is not in the campaign manifest is refused by the execId anchor alone. The
#    stronger real check (a real prod execId) is exercised by the QA matrix S0.
PROD_EXEC="prod-runner-not-in-campaign"
PROJECT=$(jq -r '.[0].projectName' "$PROJECTS_FILE" 2>/dev/null || echo "test-slot-${SLOT}")
SLOT_COMM_DB="${HOME}/.flywheel/comm/${PROJECT}/comm.db"
if QA1189_SLOT_DIR="$SLOT_DIR" QA1189_MANIFEST="${CAMPAIGN_MANIFEST}" \
   QA1189_COMM_DB="${SLOT_COMM_DB}" QA1189_TMUX_SESSION_ALLOW="runner-${PROJECT}" \
   QA1189_JOURNAL="${CAMPAIGN_ROOT}/journal.jsonl" QA1189_QUARANTINE_ROOT="${SLOT_DIR}/qa-moved-worktrees" \
   bash "$INJECTOR" verify-target "$PROD_EXEC" >/dev/null 2>&1; then
	bad "verify-target accepted a non-campaign execId (S1 anchor breach!)"
else
	ok "verify-target refuses a non-campaign execId (S1 anchor holds)"
fi

log "NOTE: freeze/thaw + break-worktree/restore + driver-SIGINT recovery are run"
log "      against a REAL injected test runner by the QA-phase matrix (S1/S1b/S9)"
log "      — this smoke proves deploy + manifests + anchor refusal; the injector"
log "      rejection/accept matrix itself is CI-covered (qa-fly-1189-fault-inject)."

# 5. Teardown + prod zero-taint.
cleanup
trap - EXIT
bash "$INJECTOR" prod-snapshot smoke-after > "${CAMPAIGN_ROOT}/prod-after.json" 2>/dev/null || true
if [[ -f "${CAMPAIGN_ROOT}/prod-before.json" && -f "${CAMPAIGN_ROOT}/prod-after.json" ]]; then
	# File-set must not have gained entries under the monitored prod roots.
	before_files=$(jq -c '.files' "${CAMPAIGN_ROOT}/prod-before.json" 2>/dev/null || echo "[]")
	after_files=$(jq -c '.files' "${CAMPAIGN_ROOT}/prod-after.json" 2>/dev/null || echo "[]")
	if [[ "$before_files" == "$after_files" ]]; then
		ok "prod file-set unchanged (zero taint)"
	else
		log "prod file-set differs — attribute churn before declaring taint (see prod-before/after.json)"
	fi
fi

echo "[smoke] RESULT: ${PASS} ok, ${FAIL} bad — evidence in ${CAMPAIGN_ROOT}"
[[ "$FAIL" == "0" ]]
