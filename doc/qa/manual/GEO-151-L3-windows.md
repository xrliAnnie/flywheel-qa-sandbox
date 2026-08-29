# GEO-151 L3 — macOS Window Capture Manual Test Plan

**Issue**: GEO-151 — ProofShot integration
**Stage**: C (Lead-side macOS screencapture)
**Audience**: Annie + whoever's QA-ing the release on her Mac
**Acceptance Criteria**: AC11 (happy path), AC12 (window not found / minimized), AC13 (Screen Recording permission missing)
**Pre-req**: C10 merged. Lead daemon restarted so `screencapture-l3-skill.md` is loaded.

---

## What this verifies (and what it doesn't)

C10's unit tests (`find-window.test.sh` + `screencap-skill-gate.test.sh`)
cover the script-layer logic deterministically: argument parsing, exit
codes, env-gate behavior. They CANNOT cover:

1. AppleScript actually walks System Events and returns real windowIDs.
2. `screencapture -l <id>` actually writes a PNG of the right window.
3. macOS Screen Recording permission flow (system dialog, user grant).
4. The Lead model honors the narrow trigger contract (fires when it
   should + skips when it shouldn't).
5. Discord MCP `reply` with `files=[...]` actually attaches the PNG.
6. Cross-Sonoma compatibility (Annie is on 15; older 14 / future 16 may
   shift the System Events AppleScript surface).

This plan walks Annie through 5 scenarios that cover all six items at
least once.

---

## One-time setup

```bash
# 1. Confirm Lead is loaded with the skill
grep "screencapture-l3-skill" ~/.flywheel/logs/<lead-name>.log | tail -3
# Expect: a recent "[lead] Appending L3 screencapture skill: ..." line

# 2. Pre-grant Screen Recording permission to Terminal.app (or whichever
#    process runs the Lead daemon — usually Terminal on Annie's setup).
#    System Settings → Privacy & Security → Screen Recording → toggle
#    Terminal.app on. May require Terminal restart.

# 3. Confirm find-window.sh on PATH (or accessible by Lead)
ls -la ~/Dev/flywheel/packages/teamlead/scripts/find-window.sh
# Should exist, mode 755
```

---

## Scenario 1 — cmux (AC11 happy path)

**Pre-state**: cmux is running with at least one visible window.

**Trigger** (in Annie's Lead chat thread):
```
截一下 cmux 现在啥状态
```

**Expected**:
1. Lead matches both trigger conditions (intent: 截 + app: cmux).
2. Lead runs:
   ```bash
   "$FLYWHEEL_TEAMLEAD_SCRIPT_DIR/find-window.sh" cmux
   ```
   → exits 0 with a window ID like `12345`.
3. Lead runs `screencapture -l 12345 -t png /tmp/flywheel-screencap-<ts>.png`.
4. Lead invokes:
   ```
   mcp__plugin_discord_discord__reply(
     chat_id: <Annie's current channel>,
     message: "cmux 当前状态 ↓",
     files: ["/tmp/flywheel-screencap-<ts>.png"]
   )
   ```
5. Annie sees the PNG in chat within ~5s. PNG content matches what was
   on screen at trigger time.
6. Temp file cleaned up (Lead `rm -f`).

**Recording**:
- ✅ Annie saw the screenshot
- ✅ Screenshot matches cmux content
- ⏱ Time from message to image visible: ___ s
- Sonoma version: 14.x / 15.x / 16.x

---

## Scenario 2 — Discord app (the Mac app, not the channel)

**Pre-state**: Discord.app is running (in the dock or a window).

**Trigger**:
```
看下 Discord app 有什么新消息
```

**Expected**: Same chain as Scenario 1 but the captured window is Discord.app.

**Edge case to watch**: Lead might confuse "Discord" the app with
"Discord" the channel. The trigger contract requires the keyword `app`
to disambiguate. If Lead fires without `app` mentioned, file a
follow-up issue to tighten the trigger contract.

---

## Scenario 3 — Bridge tmux window (Terminal)

**Pre-state**: Bridge is running in a tmux window inside a Terminal.app
window (Annie's normal setup).

**Trigger**:
```
show me the current Bridge tmux window
```

**Expected**:
1. Lead resolves `Terminal` (since tmux runs inside Terminal).
2. Captures whatever Terminal window is on top.
3. ⚠️ If Annie has multiple Terminal windows open, the captured window
   may not be the one with Bridge. Document this limitation in the
   skill prompt as a follow-up.

---

## Scenario 4 — Activity Monitor (sanity check)

**Pre-state**: Activity Monitor.app is NOT running.

**Trigger**:
```
screenshot Activity Monitor right now
```

**Expected**:
1. Lead runs `find-window.sh "Activity Monitor"` → exit 1 (no match).
2. Lead replies with the friendly error:
   > 未找到匹配 "Activity Monitor" 的窗口. 该应用可能未启动, 或窗口已最小化 / 移出屏幕.

3. NO screencapture call attempted.

**Then minimize the window test**:
1. Open Activity Monitor.
2. Minimize it (cmd+M).
3. Trigger again — should still get the "未找到" reply (find-window
   filters minimized windows).
4. Restore it.
5. Trigger again — should now succeed.

---

## Scenario 5 — Permission denied (AC13)

**Pre-state**: System Settings → Privacy & Security → Screen Recording
→ Terminal.app toggled **OFF**.

**Trigger**:
```
screenshot Chrome
```

**Expected**:
1. Lead runs find-window → returns a window ID (find-window doesn't
   need Screen Recording, only `screencapture` does).
2. Lead runs `screencapture -l <id> ...` → exits non-zero with stderr
   containing `not authorized` or `permission`.
3. Lead replies:
   > Screen Recording 权限缺失. 请到 System Settings → Privacy &
   > Security → Screen Recording 给 Terminal.app 授权. 重启 Lead daemon 后重试.
4. ⚠️ macOS may pop a system dialog the first time. Annie can grant
   it and the next trigger should succeed without daemon restart in
   modern macOS (verify on her version).

**Teardown**: Re-enable Screen Recording for Terminal.app.

---

## False-positive guards (skill should NOT fire)

These are NEGATIVE tests — Lead should reply normally without invoking
find-window:

| Trigger | Why it should skip |
|---|---|
| `我们看一下这个 bug` | No app named, just discussion |
| `look at PR #123` | PR is not a macOS app |
| `send me a screenshot` | No app named |
| `screenshot the test results` | Test results not an app |
| `截一下 GitHub` | GitHub is a website (web flow = ProofShot) |

For each: send the trigger to Lead, verify NO `find-window.sh` invocation
in the Lead log, verify Lead replied with text (not a PNG).

---

## Cross-Sonoma compatibility notes

**Sonoma 15.x** (Annie's primary): verified to work — fill in date after first successful run.

**Sonoma 14.x**: AppleScript System Events surface should be identical;
the `AXMinimized` attribute existed in 14. If Annie has access to a 14
machine, run scenarios 1+4 there and record results.

**Sonoma 16.x** (future): unknown. Re-run all scenarios after upgrade.

---

## Recording the result

Update `doc/qa/results/GEO-151-stageC-results.md` with date + outcome
per scenario. Stage C ship is blocked on Scenarios 1+4+5 passing
(critical paths); 2+3 nice-to-have.

False-positive guards must all pass — a single false-positive that
fires `screencapture` against unrelated chat would erode Annie's trust
in the skill.
