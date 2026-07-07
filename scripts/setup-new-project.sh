#!/usr/bin/env bash
# FLY-284: setup-new-project.sh — the SINGLE, reusable, idempotent,
# FILESYSTEM-ONLY zero-to-one scaffolder for standing up a brand-new Flywheel
# project from scratch (no existing repo).
#
#   This fills the genuinely-new FRONT half of onboarding (repo skeleton +
#   .flywheel/.lead skeleton + doc-flow) that FLY-189/190/270 assumed already
#   existed. The BACK half (Discord bots, live ~/.flywheel/projects.json,
#   launchd, Bridge restart, gh repo create, Linear team/labels) is LIVE /
#   irreversible and is NEVER executed here — it is printed as a founder-gated
#   cutover checklist at the end. tidal-echo is this script's first real run.
#
# Usage:
#   scripts/setup-new-project.sh <project-name> <department> [options]
#
#   <project-name>   ^[a-z0-9][a-z0-9-]*$  (= repo name = projectName = dir basename)
#   <department>     ^[a-z0-9-]+$          (e.g. content, product, engineering)
#
# Options:
#   --target <dir>        scaffold target (default: $HOME/Dev/<project-name>)
#   --team <KEY>          Linear team key for config.yaml linear.team_id (default: TEAM)
#   --two-layer           generate a CoS Lead skeleton + a dept Lead skeleton
#                         (default: a single dept Lead)
#   --cos-persona <name>  persona name for the CoS identity skeleton (default: CoS)
#   --dept-persona <name> persona name for the dept Lead identity skeleton (default: Lead)
#   --repo-owner <owner>  GitHub owner for the printed `gh repo create` step (default: xrliAnnie)
#   --cos-id <id>         OPT-IN (FLY-648): CoS lead id — names .lead/<id>/ and the
#                         identity frontmatter (default: <project>-cos-lead, unchanged).
#                         claude-lead.sh only loads the CoS rule surface for the
#                         literal "cos-lead" (or FLYWHEEL_LEAD_ROLE=cos), so a
#                         fresh-instance setup passes --cos-id cos-lead to align the
#                         skeleton with the runtime agentId.
#   --dept-id <id>        OPT-IN (FLY-648): dept lead id (default: <project>-<department>-lead,
#                         unchanged) — same skeleton/agentId alignment for the dept Lead.
#
# Idempotent: re-running produces zero changes (skip-if-exists per file).
# Filesystem-only: writes ONLY under <target>; touches no live config / network.
set -euo pipefail

err() { echo "[setup-new-project] ERROR: $*" >&2; exit 1; }
log() { echo "[setup-new-project] $*"; }

# ── Arg parsing ──────────────────────────────────────────────────────────────
[ $# -ge 2 ] || err "usage: setup-new-project.sh <project-name> <department> [options]"
PROJECT="$1"; DEPT="$2"; shift 2

TARGET=""; TEAM="TEAM"; TWO_LAYER=false
COS_PERSONA="CoS"; DEPT_PERSONA="Lead"; REPO_OWNER="xrliAnnie"
COS_ID_OVERRIDE=""; DEPT_ID_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target)       TARGET="${2:?--target needs a value}"; shift 2 ;;
    --team)         TEAM="${2:?--team needs a value}"; shift 2 ;;
    --two-layer)    TWO_LAYER=true; shift ;;
    --cos-persona)  COS_PERSONA="${2:?--cos-persona needs a value}"; shift 2 ;;
    --dept-persona) DEPT_PERSONA="${2:?--dept-persona needs a value}"; shift 2 ;;
    --repo-owner)   REPO_OWNER="${2:?--repo-owner needs a value}"; shift 2 ;;
    --cos-id)       COS_ID_OVERRIDE="${2:?--cos-id needs a value}"; shift 2 ;;
    --dept-id)      DEPT_ID_OVERRIDE="${2:?--dept-id needs a value}"; shift 2 ;;
    *)              err "unknown option: $1" ;;
  esac
done

[ -n "$TARGET" ] || TARGET="${HOME}/Dev/${PROJECT}"

# ── 1. Validation ────────────────────────────────────────────────────────────
printf '%s' "$PROJECT" | grep -Eq '^[a-z0-9][a-z0-9-]*$' \
  || err "project-name \"$PROJECT\" must match ^[a-z0-9][a-z0-9-]*\$ (lowercase, digits, hyphens)"
printf '%s' "$DEPT" | grep -Eq '^[a-z0-9-]+$' \
  || err "department \"$DEPT\" must match ^[a-z0-9-]+\$ (lowercase letters, digits, hyphens)"

# Target git-root handling: create+init if absent; if it exists, it MUST be a
# git repo ROOT (guards against scaffolding into the wrong directory — same
# guard as setup-doc-flow.sh) BEFORE we write anything.
if [ ! -e "$TARGET" ]; then
  mkdir -p "$TARGET"
  git -C "$TARGET" init -q
  log "Created git repo at $TARGET"
else
  [ -d "$TARGET" ] || err "target \"$TARGET\" exists and is not a directory"
  GIT_TOPLEVEL="$(git -C "$TARGET" rev-parse --show-toplevel 2>/dev/null)" \
    || err "target \"$TARGET\" exists but is not inside a git repository (refusing to write)"
  TARGET_ABS="$(cd "$TARGET" && pwd -P)"
  GIT_TOPLEVEL_ABS="$(cd "$GIT_TOPLEVEL" && pwd -P)"
  [ "$TARGET_ABS" = "$GIT_TOPLEVEL_ABS" ] \
    || err "target \"$TARGET\" is not the git repo ROOT (toplevel is \"$GIT_TOPLEVEL_ABS\")"
fi
TARGET="$(cd "$TARGET" && pwd -P)"

DEPT_LEAD_ID="${PROJECT}-${DEPT}-lead"
COS_LEAD_ID="${PROJECT}-cos-lead"
# FLY-648 opt-in overrides (absent = byte-identical default behavior). Lead ids
# become .lead/<id>/ path components — enforce the claude-lead.sh grammar.
if [ -n "$COS_ID_OVERRIDE" ]; then
  printf '%s' "$COS_ID_OVERRIDE" | grep -Eq '^[a-z0-9][a-z0-9-]*$' \
    || err "--cos-id \"$COS_ID_OVERRIDE\" must match ^[a-z0-9][a-z0-9-]*\$"
  COS_LEAD_ID="$COS_ID_OVERRIDE"
fi
if [ -n "$DEPT_ID_OVERRIDE" ]; then
  printf '%s' "$DEPT_ID_OVERRIDE" | grep -Eq '^[a-z0-9][a-z0-9-]*$' \
    || err "--dept-id \"$DEPT_ID_OVERRIDE\" must match ^[a-z0-9][a-z0-9-]*\$"
  DEPT_LEAD_ID="$DEPT_ID_OVERRIDE"
fi
[ "$COS_LEAD_ID" != "$DEPT_LEAD_ID" ] || err "--cos-id and --dept-id resolve to the same lead id ($COS_LEAD_ID)"
EXECUTOR_REL=".flywheel/agents/${DEPT}/${DEPT}-executor.md"

# Small idempotent file writer: write heredoc only if the file is absent.
# Usage: write_if_absent <path>  (heredoc piped on stdin)
write_if_absent() {
  local path="$1"
  if [ -f "$path" ]; then log "exists, skipping: ${path#$TARGET/}"; cat > /dev/null; return; fi
  mkdir -p "$(dirname "$path")"
  cat > "$path"
  log "wrote: ${path#$TARGET/}"
}

# ── 2. .gitignore ────────────────────────────────────────────────────────────
write_if_absent "${TARGET}/.gitignore" << 'GITIGNORE_EOF'
# Flywheel Runner worktrees (each Runner gets ~/Dev/<project>/worktrees/<execId>)
worktrees/

# Node / tooling
node_modules/
dist/
.DS_Store
*.log
GITIGNORE_EOF

# ── 3. README + AGENTS placeholders (no presupposed domain content) ──────────
write_if_absent "${TARGET}/README.md" << README_EOF
# ${PROJECT}

A Flywheel-managed project (department: \`${DEPT}\`).

Issues flow: Linear (team \`${TEAM}\`) → Lead → Runner → PR. See \`AGENTS.md\` for
onboarding + working conventions, and \`.flywheel/config.yaml\` for the Runner /
doc-flow wiring.

> Scaffolded by \`flywheel/scripts/setup-new-project.sh\` (FLY-284). Fill in the
> project's real purpose, domain rules, and references in \`AGENTS.md\` once the
> Lead and founder have shaped the direction.
README_EOF

write_if_absent "${TARGET}/AGENTS.md" << AGENTS_EOF
# ${PROJECT} — Agent onboarding

> Placeholder. The project's domain conventions + hard rules are defined here by
> the Lead + founder after onboarding. Do NOT presuppose content/direction.

## What this project is

TODO (one-paragraph purpose — set during onboarding with the founder).

## Hard rules

TODO (domain safety boundaries — e.g. content rules, review gates).

## Workflow

- Read this file + \`.flywheel/config.yaml\` before starting.
- Department: \`${DEPT}\`. Process docs live under \`${DEPT}/doc/<ISSUE>-<slug>/\`
  (doc-flow baseline — see \`${DEPT}/doc/README.md\`).
- Produce work as a reviewable PR. Merge / ship stays founder-gated (FLY-175).
AGENTS_EOF

# ── 4. .flywheel/config.yaml (full, ConfigLoader-valid schema) ───────────────
write_if_absent "${TARGET}/.flywheel/config.yaml" << CONFIG_EOF
# Flywheel configuration for \`${PROJECT}\` — Blueprint/Runner-side config.
# Lead/Discord routing lives in ~/.flywheel/projects.json (machine-local, added
# at cutover). Scaffolded by setup-new-project.sh (FLY-284).

project: ${PROJECT}

linear:
  # Schema-required but NOT a runtime ingestion filter; real scoping is the
  # per-issue routing label + the FLY-127 run-start gate (projects.json).
  team_id: ${TEAM}

runners:
  default: claude
  available:
    claude:
      type: claude
      model: sonnet

teams:
  - name: default
    orchestrators:
      - type: dag
        runner: claude
        budget_per_issue: 10

decision_layer:
  autonomy_level: advisor            # merge / ship stay founder-gated (FLY-175)
  escalation_channel: discord

checkpoints:
  brainstorm:
    enabled: true
    timeout_ms: 86400000
    timeout_behavior: fail-close
  question:
    enabled: true
    timeout_ms: 86400000
    timeout_behavior: fail-open

# Single ${DEPT} executor; key = agent name, value = file + dispatch labels.
agents:
  ${DEPT}:
    agent_file: ${EXECUTOR_REL}
    department: ${DEPT}
    match:
      labels: ["${DEPT}"]
default_agent: ${DEPT}

# FLY-205: department-first doc-flow baseline.
doc_flow:
  enabled: true
  default_department: ${DEPT}
CONFIG_EOF

# ── 4b. FLY-727: deploy-report hook (auto-onboard this project to the digest) ─
# Every new project is born with a ready, best-effort wrapper it calls at its
# deploy point so the daily Flywheel digest covers it. It records one
# deployment_events row via the Bridge (report-deployed → /api/deployments/report;
# POSTs to the local Bridge or spools). Wiring it into the deploy point is a
# printed cutover step (§8) — the hook itself is filesystem-only, safe to scaffold.
write_if_absent "${TARGET}/.flywheel/hooks/report-deployment.sh" << HOOK_EOF
#!/usr/bin/env bash
# FLY-727: report a production deployment of \`${PROJECT}\` to the Flywheel daily
# digest ("who shipped what today", fleet-wide). Call at your deploy point / CI
# post-deploy step, e.g.:
#   .flywheel/hooks/report-deployment.sh --issue FLY-123 --pr 45 --merge-sha <40hex>
# Supply at least one identity: --merge-sha / --deployed-sha / --deploy-batch-id /
# --source-event-id. Best-effort: it NEVER fails your deploy — report-deployed POSTs
# to the local Flywheel Bridge (default http://localhost:9876; override with
# FLYWHEEL_BRIDGE_URL) or spools the event for a later drain. Needs the flywheel
# checkout (FLYWHEEL_DIR, default \$HOME/Dev/flywheel).
set -uo pipefail
FLYWHEEL_DIR="\${FLYWHEEL_DIR:-\$HOME/Dev/flywheel}"
COMM="\${FLYWHEEL_DIR}/packages/flywheel-comm/dist/index.js"
if [ ! -f "\$COMM" ]; then
  echo "[report-deployment] flywheel-comm not found at \$COMM — set FLYWHEEL_DIR; skipping (digest event not recorded)" >&2
  exit 0
fi
node "\$COMM" report-deployed --project "${PROJECT}" --source project-deploy "\$@" \\
  || echo "[report-deployment] deploy-report not confirmed (best-effort — spooled/deferred; digest event may be delayed)" >&2
exit 0
HOOK_EOF
chmod +x "${TARGET}/.flywheel/hooks/report-deployment.sh" 2>/dev/null || true

# ── 5. Executor agent (content → content-engineer framing; else generic) ─────
if [ "$DEPT" = "content" ]; then
  write_if_absent "${TARGET}/${EXECUTOR_REL}" << 'EXEC_EOF'
---
name: content-executor
description: General content engineer. Takes a Linear issue and produces content (text/media/publishing) end-to-end as a reviewable PR. NOT a thin wrapper around one tool.
model: opus
permissionMode: default
skills:
  - brainstorm
  - research
  - write-plan
  - implement
---

# Content Executor — general content engineer

You read a Linear issue and figure out what content work it needs — like an
engineer reads a ticket. You produce **content**, not code, but you ship it the
same way: a reviewable PR.

## CRITICAL RULES

**ALWAYS**
- Audit first — read `AGENTS.md` (project domain rules) + the task-relevant refs
  before doing anything. Never invent from zero.
- Documents in Chinese; technical terms / library names / code in English.
- Report back to your Lead ONLY via `flywheel-comm ask` (FLY-208). NEVER use the
  SendMessage tool to report (it is a black-hole inbox).

**NEVER**
- Merge to main or publish/upload without the founder gate (FLY-175) + any
  project preview gate the Lead runs.
- Decide aesthetic / taste judgments for the founder — those gate through the
  Lead's preview step and the founder.

## Protocol (HARD GATES — every tier)

1. **Onboard** — read `AGENTS.md` + the task-relevant refs.
2. **Brainstorm — GATE** — confirm scope interactively, one question at a time,
   ≥3 rounds. Block via `flywheel-comm gate brainstorm` until the Lead confirms.
3. **Research — GATE** — read the craft refs / history the task needs.
4. **Plan — GATE** — list artifacts + which hard rules apply.
   - When your prompt carries a DOC-FLOW block, write process docs into
     `<dept>/doc/<ISSUE-KEY>-<slug>/` exactly as it specifies.
5. **Implement** — produce the content artifact.
6. **Self-verify** — run any project lint/checks before review.
7. **Codex review → PR + handoff.**
EXEC_EOF
else
  write_if_absent "${TARGET}/${EXECUTOR_REL}" << EXEC_GENERIC_EOF
---
name: ${DEPT}-executor
description: ${DEPT} executor for ${PROJECT}. Takes a Linear issue and ships the work as a reviewable PR.
model: opus
permissionMode: default
skills:
  - brainstorm
  - research
  - write-plan
  - implement
---

# ${DEPT} executor — ${PROJECT}

You read a Linear issue and ship the work as a reviewable PR. Audit \`AGENTS.md\`
+ task refs first; follow TDD where code is involved. Report back to your Lead
ONLY via \`flywheel-comm ask\` (FLY-208) — never the SendMessage tool. Merge /
ship stay founder-gated (FLY-175).

## Protocol (HARD GATES)
Onboard → Brainstorm (GATE) → Research (GATE) → Plan (GATE) → Implement →
self-verify → Codex review → PR. When your prompt carries a DOC-FLOW block,
write process docs into \`${DEPT}/doc/<ISSUE-KEY>-<slug>/\`.
EXEC_GENERIC_EOF
fi

# ── 6. Lead identity skeleton(s) ─────────────────────────────────────────────
# Dept Lead (always).
write_if_absent "${TARGET}/.lead/${DEPT_LEAD_ID}/identity.md" << DEPT_ID_EOF
---
name: ${DEPT_LEAD_ID}
description: ${PROJECT} ${DEPT} Lead (${DEPT_PERSONA}) — manages ${DEPT} Runners end-to-end, communicates with the founder via Discord.
model: opus
memory: user
disallowedTools: Write, Edit, MultiEdit, Agent, NotebookEdit
permissionMode: bypassPermissions
---

# ${DEPT_PERSONA} — ${PROJECT} ${DEPT} Lead

You are **${DEPT_PERSONA}**, the Lead of the \`${PROJECT}\` ${DEPT} department.
You manage ${DEPT} Runners that produce work end-to-end as reviewable PRs. You
are a manager/architect, not a doer.

## Discord identity (TODO — fill at cutover)
- Bot id: TODO
- chatChannel (#${PROJECT}): TODO
- core channel (#${PROJECT}-core): TODO   # top-level issue-bearing posts
- #leads-roundtable: cross-dept, mention-gated only

## Role
- Discuss direction with the founder → spawn Runners (\`canSpawnRunners: true\`)
  → track progress like an architect → report at milestones.
- Linear scope: every issue handed to a Runner MUST carry this project's routing
  label or \`/api/runs/start\` 403s (FLY-127). Filter your Linear queries to this
  project.
- Preview/approval gate: post deliverables for the founder; never decide
  taste/quality for the founder.
- Merge / ship / Runner-lifecycle stay founder-gated (FLY-175). Report back via
  \`flywheel-comm ask\`; never the SendMessage tool.
- memory user_id (shared bucket): \`${PROJECT}\`.

> TODO at cutover: fill bot id + channel ids + any ${DEPT}-specific gates
> (e.g. media preview). Keep project-specific rules in THIS file — do NOT create
> \`.lead/shared/\` (it forces common-rules.md + department-lead-rules.md or launch fails).
DEPT_ID_EOF

# CoS Lead (only with --two-layer).
if [ "$TWO_LAYER" = true ]; then
  write_if_absent "${TARGET}/.lead/${COS_LEAD_ID}/identity.md" << COS_ID_EOF
---
name: ${COS_LEAD_ID}
description: ${PROJECT} Chief of Staff (${COS_PERSONA}) — triage, routing, founder roll-up. Does NOT spawn Runners or touch deliverables.
model: opus
memory: user
disallowedTools: Write, Edit, MultiEdit, Agent, NotebookEdit
permissionMode: bypassPermissions
---

# ${COS_PERSONA} — ${PROJECT} Chief of Staff

You are **${COS_PERSONA}**, the CoS for \`${PROJECT}\`. You coordinate; you do NOT
manage Runners and do NOT produce deliverables — you route work to the dept Lead
(${DEPT_PERSONA}) and report to the founder.

## Discord identity (TODO — fill at cutover)
- Bot id: TODO
- chatChannel / core channel (#${PROJECT}-core): TODO   # = generalChannel
- #leads-roundtable: cross-dept, mention-gated only

## Role
- \`canSpawnRunners: false\`. The launchd plist MUST set \`FLYWHEEL_LEAD_ROLE=cos\`
  or the CoS base rules (cos-lead-rules.md) will NOT load and you'd be treated as
  a dept Lead.
- **Triage → present to the founder → wait for explicit confirmation → apply the
  dept routing label → route to the dept Lead** via \`/api/chat-threads/send\`
  (issue thread, not a top-level Discord post). Label-before-route is your job
  (FLY-127), not the dept Lead's.
- **NEVER route via #leads-roundtable** — internal handoff stays in #${PROJECT}-core.
- Digest Bridge events → brief the founder in the core channel; do NOT execute
  approve/reject/retry (that is the dept Lead's / founder's call).
- Merge / ship / Runner-lifecycle are founder-gated (FLY-175). Report back via
  \`flywheel-comm ask\`; never the SendMessage tool.
- memory user_id (shared bucket): \`${PROJECT}\`.

> TODO at cutover: fill bot id + channel ids. Keep rules in THIS file — do NOT
> create \`.lead/shared/\`.
COS_ID_EOF
fi

# ── 7. Reuse doc-flow baseline (creates <dept>/doc/ + README + retro/.gitkeep) ─
# config.yaml above already carries a doc_flow block, so setup-doc-flow.sh's
# anchored-grep idempotency makes it skip the config append (no double-write).
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -x "${SELF_DIR}/setup-doc-flow.sh" ]; then
  "${SELF_DIR}/setup-doc-flow.sh" "$TARGET" "$DEPT" | sed 's/^/    /' || err "setup-doc-flow.sh failed"
else
  log "WARN: setup-doc-flow.sh not found next to this script — skipped doc/ scaffold"
fi

# ── 8. Gated cutover checklist (PRINTED ONLY — never executed here) ──────────
cat << CUTOVER_EOF

[setup-new-project] Done. Filesystem scaffold complete at:
    ${TARGET}

────────────────────────────────────────────────────────────────────────────
GATED CUTOVER (LIVE — founder must approve + be present; NOT run by this script)
Order matters (FLY-270: projects.json-first → manifest → install plist):
────────────────────────────────────────────────────────────────────────────
 1. Commit + push the scaffold via the normal PR flow.
 2. Create the GitHub repo:  gh repo create ${REPO_OWNER}/${PROJECT} --private
    then push the initial commit.
 3. Linear: create the team/labels for routing (e.g. team key for \`${TEAM}\`
    + one routing label per Lead).
 4. Discord: create the bot(s) + channel(s); put token(s) in ~/.flywheel/.env;
    fill the bot id / channel ids into the .lead/*/identity.md TODOs.
 5. Edit live ~/.flywheel/projects.json — add the ${PROJECT} entry, including
    memoryAllowedUsers (memory validation is fail-closed).
 6. Run claude-lead.sh once per Lead to generate + validate the manifest,
    then stop that manual process.
 7. Install/reload the launchd plist per Lead. The CoS plist MUST set
    FLYWHEEL_LEAD_ROLE=cos (verify: launchctl print … | grep FLYWHEEL_LEAD_ROLE).
 8. Restart the Bridge (batch with any in-flight Bridge PRs).
 9. Verify: bots online + reply in their channels + a real founder chat.
10. Digest onboarding (FLY-727): wire .flywheel/hooks/report-deployment.sh into
    ${PROJECT}'s deploy point (or CI post-deploy) — call it with
    --issue FLY-N | --pr N --merge-sha <sha> at each production deploy. That records
    a deployment_events row so the daily fleet-wide digest covers ${PROJECT}.
────────────────────────────────────────────────────────────────────────────
CUTOVER_EOF
