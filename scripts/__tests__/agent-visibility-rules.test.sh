#!/usr/bin/env bash
# FLY-2643: production Lead/Runner visibility is a default hard rule.
# Exercise the real Claude dry-run assembler and the shared Codex resolver so a
# prose-only file that no launcher consumes cannot satisfy this suite.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLAUDE_LEAD="$ROOT/packages/teamlead/scripts/claude-lead.sh"
RULES_DIR="$ROOT/packages/teamlead/lead-rules-base"
RESOLVER="$ROOT/packages/teamlead/scripts/lead-rules-bundle.sh"
RULE_NAME="visible-tui-default.md"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/fly2643-rules.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

HOME_FIXTURE="$TMP/home"
PROJECT_ROOT="$HOME_FIXTURE/project"
PROJECTS="$TMP/projects.json"
mkdir -p "$HOME_FIXTURE/.flywheel" \
  "$PROJECT_ROOT/.lead/cos-lead" \
  "$PROJECT_ROOT/.lead/product-lead" \
  "$PROJECT_ROOT/.lead/infra-lead" \
  "$PROJECT_ROOT/.lead/companion-lead" \
  "$PROJECT_ROOT/.lead/anna-interviewer-lead"
printf '%s\n' '{"granularity":"per-lead","setBy":"test","setAt":"2026-09-17T00:00:00.000Z"}' \
  >"$HOME_FIXTURE/.flywheel/summary-config.json"
for lead in cos-lead product-lead infra-lead companion-lead; do
  printf -- '---\nname: %s\n---\nfixture\n' "$lead" >"$PROJECT_ROOT/.lead/$lead/identity.md"
done
printf -- '---\nname: anna-interviewer-lead\n---\nfixture\n' \
  >"$PROJECT_ROOT/.lead/anna-interviewer-lead/agent.md"

cat >"$PROJECTS" <<JSON
[
  {"projectName":"fixture","projectRoot":"$PROJECT_ROOT","leads":[
    {"agentId":"cos-lead","summaryRole":"aggregator","chatChannel":"101","match":{"labels":["cos"]},"botTokenEnv":"FIXTURE_BOT_TOKEN","botUserId":"10000000000000001","canSpawnRunners":false},
    {"agentId":"product-lead","summaryRole":"producer","chatChannel":"102","match":{"labels":["product"]},"botTokenEnv":"FIXTURE_BOT_TOKEN","botUserId":"10000000000000002","canSpawnRunners":true},
    {"agentId":"infra-lead","summaryRole":"recipient","chatChannel":"103","match":{"labels":["infra"]},"botTokenEnv":"FIXTURE_BOT_TOKEN","botUserId":"10000000000000003","canSpawnRunners":true},
    {"agentId":"companion-lead","summaryRole":"exempt","chatChannel":"104","match":{"labels":["companion"]},"botTokenEnv":"FIXTURE_BOT_TOKEN","botUserId":"10000000000000004","canSpawnRunners":false,"companion":true,"department":"life"},
    {"agentId":"anna-interviewer-lead","summaryRole":"exempt","chatChannel":"105","alertChannel":"106","match":{"labels":["external"]},"department":"external","botTokenEnv":"FIXTURE_BOT_TOKEN","botUserId":"10000000000000005","alertBotTokenEnv":"FIXTURE_BOT_TOKEN","canSpawnRunners":false,"external":true}
  ]}
]
JSON

claude_rule_names() {
  local lead="$1" output plan bundle projects_json
  projects_json="$(<"$PROJECTS")"
  output="$(env -i HOME="$HOME_FIXTURE" PATH="$PATH" \
    FLYWHEEL_LEAD_DRY_RUN=1 FLYWHEEL_PROJECTS="$projects_json" \
    FIXTURE_BOT_TOKEN=fixture TEAMLEAD_API_TOKEN=fixture \
    bash "$CLAUDE_LEAD" "$lead" "$PROJECT_ROOT" fixture 2>&1)"
  plan="$(printf '%s\n' "$output" | sed -n '/LAUNCH_PLAN_BEGIN/,/LAUNCH_PLAN_END/p')"
  bundle="$(printf '%s\n' "$plan" | awk -F '\t' '
    $1 == "ARG" && previous == "--append-system-prompt-file" { print $2 }
    $1 == "ARG" { previous = $2 }
  ')"
  test -r "$bundle"
  sed -n 's/^  [0-9][0-9]*\. [^/]*\/\([^ ]*\) — .*/\1/p' "$bundle"
}

assert_has_rule() {
  local label="$1"; shift
  if ! "$@" | grep -Fxq "$RULE_NAME"; then
    printf 'FAIL: %s did not assemble %s\n' "$label" "$RULE_NAME" >&2
    exit 1
  fi
}

assert_lacks_rule() {
  local label="$1"; shift
  if "$@" | grep -Fxq "$RULE_NAME"; then
    printf 'FAIL: %s leaked internal %s\n' "$label" "$RULE_NAME" >&2
    exit 1
  fi
}

assert_has_rule "Claude CoS" claude_rule_names cos-lead
assert_has_rule "Claude department" claude_rule_names product-lead
assert_has_rule "Claude infra" claude_rule_names infra-lead
assert_lacks_rule "Claude companion" claude_rule_names companion-lead
assert_lacks_rule "Claude external" claude_rule_names anna-interviewer-lead

codex_rule_names() {
  local role="$1"
  FLYWHEEL_LEAD_HAS_SUMMARY_DUTY=0 \
    bash -c 'source "$1"; compute_lead_rule_bundle "$2" "$3" mailbox 1' \
      _ "$RESOLVER" "$role" "$RULES_DIR" | sed 's#.*/##'
}

assert_has_rule "Codex CoS" codex_rule_names cos
assert_has_rule "Codex department" codex_rule_names dept
assert_has_rule "Codex infra" codex_rule_names dept
assert_lacks_rule "Codex companion" codex_rule_names companion

test "$(python3 -c 'import pathlib,sys; print(len(pathlib.Path(sys.argv[1]).read_text()))' "$RULES_DIR/$RULE_NAME")" -le 280
grep -Fq '不可见' "$RULES_DIR/$RULE_NAME"
grep -Fq '未上线' "$RULES_DIR/$RULE_NAME"
grep -Fq "$RULE_NAME" "$RULES_DIR/default-enable-policy.md"
grep -Fq 'LEAD_VISIBILITY' "$RULES_DIR/runbooks/patrol-v1.md"
grep -Fq '窗口存在' "$RULES_DIR/runner-patrol-rules.md"
grep -Fq 'visible TUI' "$ROOT/packages/claude-runner/agents/codex-runner-contract.md"
grep -Fq 'verify-agent-visibility.sh' "$ROOT/engineering/doc/FLY-2444-flywheel-lead-launcher/lead-in-any-repo.md"

printf 'PASS: internal Claude/Codex Lead bundles carry the visible-TUI rule; companion/external boundaries remain narrow\n'
