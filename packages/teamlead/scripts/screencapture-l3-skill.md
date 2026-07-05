# GEO-151 L3 — macOS Window Capture Skill (Lead-side)

When Annie asks to see a specific macOS application window in chat, you
(the Lead) capture the window with `screencapture -l` and reply with the
PNG via the Discord MCP `reply` tool.

This skill ONLY exists for **Annie-initiated, ad-hoc visual inspection**
of running apps on her Mac. It is NOT for capturing PRs, code diffs, or
browser content — those flow through ProofShot in the auto-trigger path.

## ⚠️ Narrow trigger contract — both conditions MUST hold

Trigger this skill **only when both** are true:

1. **Annie's message contains an explicit "show me this window" intent**.
   Trigger keywords (case-insensitive): `截图`, `screenshot`, `show me`,
   `看一下`, `look at`, `截`, `看下` — AND the keyword is paired with a
   description of what to look at (UI / 当前状态 / 现在啥样).
2. **Annie's message names a specific macOS application or window**.
   Examples: `cmux`, `Discord` (the app, not the channel), `Chrome`,
   `Terminal`, `Activity Monitor`, `Slack`, `Notion`. Or a window title
   fragment in quotes (`"GeoForge3D — VS Code"`).

If either is missing → **do not trigger**. Reply normally as in any chat.

## ❌ Do NOT trigger on (false-positive guards)

- General discussion: "我们看一下这个 bug" / "let's look at this PR"
- Code / text / file references: "look at the diff", "看 PR #123"
- Implicit references: "what does it look like" without an app name
- Annie asking for a Bridge/Runner status, log dump, or text artifact
- Ambiguous "screenshot" without app: "send me a screenshot" alone
- Browser pages (use the ProofShot pipeline instead — auto-fires on
  `stage_changed=test`)

When in doubt, **don't fire** and reply asking which app/window Annie means.

## ✅ Examples that should fire

- `截一下 cmux 现在啥状态` → trigger: app=`cmux`, intent=show
- `看下 Discord app 有什么新消息` → trigger: app=`Discord`, intent=show
- `screenshot Activity Monitor right now` → trigger: app=`Activity Monitor`
- `show me the current Bridge tmux window` → trigger: app=`Terminal` (where
  Bridge tmux runs) — verify the active window matches

## ❌ Examples that should NOT fire

- `我们看一下这个 bug` → no app, just discussion
- `look at the PR` → PR is not a macOS app window
- `send me a screenshot` → no app named
- `截 GitHub` → GitHub is a website not a macOS app; suggest using ProofShot

## Workflow (after trigger confirmed)

1. Resolve the windowID:
   ```bash
   "$FLYWHEEL_TEAMLEAD_SCRIPT_DIR/find-window.sh" "<app-name>"
   ```
   - Returns one line: a numeric window ID (the `screencapture -l` target).
   - Returns empty string + exit 1 if no matching window is found or all
     matching windows are minimized / off-screen.

2. If find-window returned empty → reply friendly error to Annie:
   - `未找到匹配 "<app>" 的窗口. 该应用可能未启动, 或窗口已最小化 / 移出屏幕.`
   - Suggest: `请打开应用 + 把目标窗口拖回可见区域, 然后再说一次.`

3. If find-window returned a windowID → capture:
   ```bash
   ts="$(date +%Y%m%d-%H%M%S)"
   out="/tmp/flywheel-screencap-${ts}.png"
   screencapture -l "<windowID>" -t png "$out"
   ```

4. Check exit + stderr:
   - exit 0 → reply with the PNG attached:
     ```
     mcp__plugin_discord_discord__reply(
       chat_id: "<current-channel-id>",
       message: "<app-name> 当前状态 ↓",
       files: ["/tmp/flywheel-screencap-<ts>.png"]
     )
     ```
   - exit ≠ 0 with stderr containing `not authorized` / `permission` →
     reply with the permission instruction:
     ```
     Screen Recording 权限缺失. 请到 System Settings → Privacy & Security
     → Screen Recording 给 Terminal.app (或 cmux / 当前跑 Lead 的进程) 授权.
     重启 Lead daemon 后重试 (`restart-services.sh <lead-name>`).
     ```
   - other exit ≠ 0 → reply with the raw stderr + suggest retry.

5. After successful capture, delete the temp file:
   ```bash
   rm -f "$out"
   ```
   (You don't need to track these — Discord has the attached copy.)

## Escape hatch

If Annie complains the skill is too noisy / mis-fires:

- She can `export LEAD_DISABLE_SCREENCAPTURE_SKILL=1` and restart the Lead;
  the launcher will skip appending this file entirely. No code change
  needed — useful when iterating on the trigger contract.

## Why not always-on capture?

This skill fires manually because:
- The visual capture path (ProofShot) already handles PR/code reviews
  automatically on `stage_changed=test`. L3 is the gap-filler for
  "show me your desktop" moments.
- macOS Screen Recording permission is per-process and can prompt a
  GUI dialog the first time — we don't want that surprising Annie
  during background work.
- Capturing every window mention would spam Discord with PNGs nobody
  asked for.
