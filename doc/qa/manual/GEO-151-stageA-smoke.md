# GEO-151 Stage A — Manual Smoke Test (AC9)

**Issue**: GEO-151 ProofShot integration
**Stage**: A (UI capture pipeline)
**Acceptance Criteria**: AC9 — `proofshot pr <num>` posts a GitHub PR comment after PR open.
**Pre-req**: Stage A1–A7 merged to `main`. Annie's machine has `proofshot` CLI v1.3.1+ on PATH (`proofshot --version`). GitHub auth available via `gh auth status`.

---

## Scope

Stage A E2E unit tests in `proofshot-stage-a-smoke.test.ts` cover the
**in-process correlation chain** (handler → mailbox mock → manifest → notify
→ POST → artifact-event → mock runtime.deliver). What they CANNOT cover:

1. Real `proofshot` CLI behavior — does it actually exit 0 / write artifacts
   / talk to a dev server?
2. Real Bridge HTTP `/events` route — does the express handler call
   `handleArtifactEvent` correctly?
3. Real Lead Claude CLI session — does it pick up the artifact_delivery
   message from its mailbox and invoke `mcp__plugin_discord_discord__reply`?
4. Real Discord — does Annie see the screenshot in chat?
5. **AC9 specifically**: `proofshot pr <pr-number>` posts a comment on the
   GitHub PR with the capture artifacts attached.

This manual smoke walk-through proves items 1–5 once per release.

---

## Setup (one-time per release)

```bash
# 1. Verify ProofShot CLI present + version
proofshot --version    # → expect ≥ v1.3.1

# 2. Verify GitHub auth
gh auth status         # → expect "Logged in to github.com as xrliAnnie"

# 3. Enable ProofShot in a test project (use a throwaway worktree)
cd ~/Dev/GeoForge3D
cat > .flywheel/config.yaml.proofshot-smoke <<'EOF'
project: GeoForge3D
linear: { team_id: GEO }
runners: { default: claude, available: { claude: { type: claude } } }
teams: [{ name: dev, orchestrators: [{ type: code, runner: claude, budget_per_issue: 5 }] }]
decision_layer: { autonomy_level: manual_only, escalation_channel: "#flywheel-dev" }
skills:
  proofshot:
    enabled: true
    dev_command: "pnpm dev"
    capture_stages: [test]
    vision_default: true
    vision_token_budget: 8000
EOF
# Backup current config and swap.
mv .flywheel/config.yaml .flywheel/config.yaml.backup
mv .flywheel/config.yaml.proofshot-smoke .flywheel/config.yaml

# 4. Restart Bridge so the new config is picked up
restart-services.sh bridge
```

## Walk-through (run once per release)

### Part 1 — Capture chain works end-to-end

```bash
# 1. Start a Runner on any test issue (use a recent low-stakes one)
# (Use whatever Bridge command Annie normally uses to start a Runner.)

# 2. Inside the Runner shell, trigger a manual visual-capture (since the
#    automatic stage_changed=test hasn't fired yet):
flywheel-comm visual-capture \
  --kind ui \
  --description "AC9 smoke" \
  --output "$HOME/.flywheel/screens/$FLYWHEEL_EXEC_ID/manual-smoke" \
  --dedup-key "$FLYWHEEL_EXEC_ID|test|ui" \
  --attempt 1
```

**Expected**:
- Wrapper acquires lock at `/tmp/flywheel-proofshot-port.lockd`
- ProofShot spins up dev server, captures a few PNGs + SUMMARY.md
- Wrapper writes `manifest.json` into the output dir with wire-form
  `dedup_key`, `attempt`, `execId`, `issue_id`, `project_name`
- Lock released

### Part 2 — Notify reaches Bridge

```bash
# Still in the Runner shell:
flywheel-comm notify --paths-from "$HOME/.flywheel/screens/$FLYWHEEL_EXEC_ID/manual-smoke/manifest.json"
```

**Expected**:
- `notify: posted=true audit=true paths=N`
- Bridge log shows the POST `/events artifact_emitted` arriving and
  `handleArtifactEvent` taking over (look for log line containing
  `artifact_delivery: {seq, delivered}`)

### Part 3 — Lead → Discord

**Expected**:
- Within ~5 seconds, the Lead Claude CLI session for the project picks up
  the `artifact_delivery` event from its mailbox.
- Lead invokes `mcp__plugin_discord_discord__reply` with the file paths.
- Annie sees the screenshot(s) in the chat thread for the issue.

**If it doesn't show**: check
- Lead daemon log (`tail ~/.flywheel/logs/<lead>.log | grep artifact_delivery`)
- Lead's inbox file: `cat <claude-config>/teams/<lead>/inboxes/<lead>.json`
- StateStore `lead_events` row: should have `delivered_at` set
- If `delivered_at` is null but `delivery_attempts > 0`, HeartbeatService
  will retry on next 60s cycle (up to 3 attempts) — wait + re-check.

### Part 4 — AC9: `proofshot pr <num>` posts to GitHub PR

```bash
# After the Runner opens a PR (via flywheel-comm stage set pr_created or
# Runner's own gh pr create), grab the PR number:
PR_NUM=$(gh pr list --json number --jq '.[0].number')

# Run the ProofShot built-in PR comment uploader:
proofshot pr "$PR_NUM"
```

**Expected**:
- `proofshot pr` exits 0
- `gh pr view $PR_NUM --comments` shows a new comment with the capture
  artifacts (ProofShot uploads them as attachments to the comment body).

---

## Teardown

```bash
cd ~/Dev/GeoForge3D
# Restore the original config
mv .flywheel/config.yaml.backup .flywheel/config.yaml
restart-services.sh bridge

# Optional: clean up screens
rm -rf ~/.flywheel/screens/<execId>/manual-smoke
```

---

## Recording the result

Update `doc/qa/results/GEO-151-stageA-results.md` with date + outcome.

Each section above passes (✅) or fails (❌). A single ❌ blocks Stage A
ship. Open follow-up issues for any item that fails and link them in the
PR before merging.
