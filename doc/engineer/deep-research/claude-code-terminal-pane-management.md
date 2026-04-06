# Claude Code Terminal Pane Management Research

**Date**: 2026-04-02  
**Author**: Claude Code  
**Target**: Flywheel Lead terminal window management on demand

---

## Executive Summary

Claude Code has a sophisticated **PaneBackend interface** for managing terminal pane visibility, but it operates at the *layout level* (showing/hiding panes within a tmux session), **not** at the *user display level* (opening terminal windows).

**Key Finding**: Flywheel's current approach using **AppleScript to open Terminal.app windows** (via `openTmuxViewer()`) is the correct pattern. Claude Code does not have a built-in mechanism to "open a terminal window for the user on demand" — this is an OS-level concern, not an agent-side one.

---

## Part 1: Claude Code's PaneBackend Interface

### Type Definitions

**File**: `src/utils/swarm/backends/types.ts`

The PaneBackend interface defines pane management operations:

```typescript
export type PaneBackend = {
  readonly type: BackendType  // 'tmux' | 'iterm2'
  readonly displayName: string
  readonly supportsHideShow: boolean  // KEY: Does this backend support visibility toggling?
  
  isAvailable(): Promise<boolean>
  isRunningInside(): Promise<boolean>
  
  // Pane creation & styling
  createTeammatePaneInSwarmView(name, color): Promise<CreatePaneResult>
  sendCommandToPane(paneId, command, useExternalSession?)
  setPaneBorderColor(paneId, color, useExternalSession?)
  setPaneTitle(paneId, name, color, useExternalSession?)
  enablePaneBorderStatus(windowTarget?, useExternalSession?)
  rebalancePanes(windowTarget, hasLeader)
  
  // KEY VISIBILITY OPERATIONS
  killPane(paneId, useExternalSession?): Promise<boolean>
  hidePane(paneId, useExternalSession?): Promise<boolean>
  showPane(paneId, targetWindowOrPane, useExternalSession?): Promise<boolean>
}
```

### Key Insight: Visibility Operations Are Layout-Level

The `hidePane` / `showPane` operations manage **internal tmux pane layout**, not user-visible terminal windows:
- `hidePane`: Moves pane to a detached hidden session (tmux internal)
- `showPane`: Joins hidden pane back into main window (tmux internal)

These do NOT open a terminal window for the user to see.

---

## Part 2: TmuxBackend Implementation

### File: `src/utils/swarm/backends/TmuxBackend.ts`

#### hidePane Operation
```typescript
async hidePane(paneId: PaneId, useExternalSession = false): Promise<boolean> {
  // Creates hidden session if it doesn't exist
  await runTmux(['new-session', '-d', '-s', HIDDEN_SESSION_NAME])
  
  // Moves pane to hidden session (internal tmux management)
  const result = await runTmux([
    'break-pane',
    '-d',
    '-s', paneId,
    '-t', `${HIDDEN_SESSION_NAME}:`
  ])
  return result.code === 0
}
```

**Purpose**: Hide a Worker pane from the leader's tmux layout (e.g., worker crashed, leader wants to focus). Pane remains running but invisible.

#### showPane Operation
```typescript
async showPane(
  paneId: PaneId,
  targetWindowOrPane: string,
  useExternalSession = false
): Promise<boolean> {
  // Join hidden pane back into main window
  const result = await runTmux([
    'join-pane', '-h', '-s', paneId, '-t', targetWindowOrPane
  ])
  
  // Reapply layout
  await runTmux(['select-layout', '-t', targetWindowOrPane, 'main-vertical'])
  return result.code === 0
}
```

**Purpose**: Restore a hidden Worker pane back into the leader's visible layout.

#### Backend Registry Detection
```typescript
export class TmuxBackend implements PaneBackend {
  readonly type = 'tmux' as const
  readonly displayName = 'tmux'
  readonly supportsHideShow = true  // ← TmuxBackend CAN hide/show
}
```

---

## Part 3: Backend Comparison

| Backend | Type | supportsHideShow | Visibility Mechanism |
|---------|------|------------------|----------------------|
| **TmuxBackend** | tmux | ✅ `true` | Uses `break-pane` + hidden session |
| **ITermBackend** | iTerm2 | ❌ `false` | No native hiding (dead pane recovery only) |
| **InProcessBackend** | in-process | N/A | No panes (runs in Leader's process) |

**Key**: ITermBackend intentionally does NOT support hide/show because iTerm2 native splits don't have a clean way to hide/restore panes.

---

## Part 4: What Claude Code Does NOT Have

### No "Open Terminal Window" Operation

Claude Code's PaneBackend interface has **NO operation to open a terminal window for the user**:
- No `attachTerminal()`, `openWindow()`, or `showUserTerminal()` method
- The Coordinator/Leader panes are created and live in tmux/iTerm2
- User interaction happens either:
  1. **Inside tmux**: User attaches with `tmux attach` (user's responsibility)
  2. **Inside iTerm2**: User sees split panes natively (automatic)
  3. **Standalone tmux**: User must manually attach

### No "Focus Pane" Operation

There's no operation to programmatically focus/select a specific pane for user viewing. The layout is managed, but the user's terminal focus is OS-level.

---

## Part 5: Flywheel's Current Approach

### File: `packages/core/src/tmux-viewer.ts`

Flywheel **correctly** handles opening terminal windows using **AppleScript**:

```typescript
export function openTmuxViewer(sessionName: string): void {
  const tmuxPath = resolveTmuxPath()
  
  // Two-phase AppleScript state machine:
  // Phase 1: Wait for real tmux client to attach (bounded 120s)
  // Phase 2: Auto-close when tmux exits
  
  const script = [
    'tell application "Terminal"',
    `  set viewerTab to do script "${shellCmd}"`,  // Runs: tmux attach -t session
    '  activate',
    '  ... polling loop to detect attachment ...',
    '  ... auto-close when tmux exits ...',
    'end tell'
  ].join('\n')
  
  execFile('osascript', ['-e', script])  // Fire-and-forget async
}
```

**Strengths**:
- ✅ Opens Terminal.app window (user-visible)
- ✅ Attaches to tmux session (shows all panes)
- ✅ Deduplicates (skips if already attached)
- ✅ Auto-closes when session ends
- ✅ Async, non-blocking

---

## Part 6: Flywheel's Terminal MCP

### File: `packages/terminal-mcp/src/index.ts`

Current capabilities:
- ✅ `capture`: Read pane output (tmux capture-pane)
- ✅ `list`: List active sessions
- ✅ `search`: Search pane output
- ✅ `status`: Detect terminal status
- ✅ `input`: Send commands to panes (write operations)

**What it does NOT do**:
- ❌ Open terminal windows (Lead can use openTmuxViewer() instead)
- ❌ Hide/show panes in layout (Claude Code's domain)
- ❌ Manage terminal visibility (OS-level concern)

---

## Part 7: How Claude Code Manages Pane Layout

### Coordinator Pattern (Leader in Tmux)

When the Coordinator/Leader is **inside tmux**:

```
TmuxBackend.createTeammatePaneInSwarmView()
  → Creates panes via: tmux split-window -h -p 70%
  → Leader on left (30%), teammates on right (70%)
  → Panes are visible immediately in the same window
  → No separate "show" operation needed
```

### External Session Pattern (Leader Outside Tmux)

When the Coordinator/Leader is **outside tmux**:

```
TmuxBackend.createTeammatePaneInSwarmView()
  → Creates external swarm session: tmux new-session -d -s claude-swarm
  → Creates panes in that session
  → Panes exist in tmux, but nobody is viewing them yet
  → User must manually: tmux attach -t claude-swarm
  → OR use openTmuxViewer() to auto-open Terminal.app
```

### The Key Difference

- **Layout management** (show/hide within tmux): `TmuxBackend.hidePane() / showPane()`
- **User-visible terminal**: `openTmuxViewer()` (OS-level, not Claude Code-level)

Claude Code does NOT manage user-visible terminals — that's the harness/IDE's job.

---

## Part 8: Answer to Core Questions

### Q1: How does Claude Code's TmuxBackend let the Leader show a Worker's pane to the user?

**A**: It doesn't. Claude Code manages pane *layout* (hiding/showing panes within tmux), not user *visibility*. The Leader's panes are created and managed by tmux. The user sees them through:
- A terminal window (iTerm2, Terminal.app, or manual `tmux attach`)
- Or the Claude Code IDE's built-in terminal panel (for non-swarm scenarios)

### Q2: Is there a "show pane" / "focus pane" / "open terminal" operation?

**A**: 
- **Show pane**: ✅ Yes, `showPane()` — but this re-joins a hidden pane into the layout, not showing it to the user
- **Focus pane**: ❌ No, Claude Code doesn't manage focus (OS concern)
- **Open terminal**: ❌ No, Claude Code doesn't open terminal windows (Flywheel's `openTmuxViewer()` does this)

### Q3: Does Claude Code use tmux split-window, or does it open separate Terminal.app windows?

**A**: **tmux split-window** only. All panes are in the same tmux session/window, split with `split-window -h -p 70%`. Panes are laid out horizontally in a single window, not separate windows.

### Q4: What's the PaneBackend interface?

**A**: See types.ts above. Key visibility methods:
- `killPane()`: Close a pane
- `hidePane()`: Move pane to hidden session (internal tmux)
- `showPane()`: Restore hidden pane to layout (internal tmux)

### Q5: Is Terminal MCP the right approach, or should Flywheel use Claude Code's built-in pane management?

**A**: **Both are correct for different purposes**:
- **Terminal MCP**: Read/write operations on panes (capture, input). Useful for tooling.
- **openTmuxViewer()**: Opens Terminal.app window for user to see. This is OS-level, not Agent-level.

Flywheel should NOT use Claude Code's `hidePane/showPane()` for Lead → user visibility. Use `openTmuxViewer()` instead.

### Q6: Could Flywheel's Lead simply use Bash to run `tmux` commands or AppleScript?

**A**: ✅ **Yes, this is the pattern**:
- `openTmuxViewer()` uses Bash + AppleScript (correct)
- Terminal MCP uses Bash (`tmux capture-pane`, `tmux send-keys`) (correct)
- These are all valid, OS-level operations

Claude Code's PaneBackend is a *wrapper* around these same Bash/tmux commands, but it's designed for agent *swarm layout*, not for user visibility.

---

## Recommendations for Flywheel

### 1. Current Approach: KEEP `openTmuxViewer()`

The existing `openTmuxViewer()` implementation is production-ready. It correctly:
- Opens Terminal.app (user-visible)
- Attaches to tmux session
- Shows all panes (no selective hiding)
- Auto-deduplicates and auto-closes

**Use case**: Lead wants to show the user a running Runner session on demand.

```typescript
// In Bridge API or Lead agent:
import { openTmuxViewer } from 'core/src/tmux-viewer'
openTmuxViewer('geoforge3d-peter')  // Opens Terminal.app showing the session
```

### 2. Terminal MCP: KEEP Current Operations

The Terminal MCP provides read/write operations for Lead → Runner communication:
- `capture`: See what's happening in a pane
- `input`: Send commands to panes
- `search`: Find specific sessions

These are useful for programmatic access (e.g., Lead sending instructions via MCP `input` tool).

### 3. DON'T Use Claude Code's `hidePane/showPane()`

These are internal layout operations, not suitable for:
- Opening user-visible terminals
- Selectively showing Runners to the user

**Why**: They operate on tmux's internal pane registry, not on OS-level terminal windows.

### 4. Architecture Decision: Lead "Open Terminal" Command

If you want a Lead to open a terminal on demand, **add a Bridge API endpoint**:

```
POST /api/sessions/:id/open-terminal
  → Reads session config
  → Calls openTmuxViewer(sessionName)
  → Returns success
  → Terminal.app opens automatically
```

This keeps the concern separation clean:
- **Agent side**: openTmuxViewer() (OS operations)
- **API side**: Endpoint to trigger it
- **Lead side**: Call the endpoint

### 5. If You Need Selective Pane Visibility

If Flywheel later wants to:
- Hide crashed Runners from the Lead's view
- Show only "important" Runners

Then use **Claude Code's approach**:
```typescript
// Requires Leader to be inside a TmuxBackend-managed session
const backend = await detectAndGetBackend()  // TmuxBackend
await backend.hidePane(crashedPaneId)  // Internal layout only
await backend.showPane(paneId, targetWindow)  // Restore it
```

But this requires the Lead to be running in a tmux session managed by Claude Code's swarm infrastructure, which is out of scope for current Flywheel architecture.

---

## Summary Matrix

| Concern | Solution | Location | Owned By |
|---------|----------|----------|----------|
| **Layout management** (hide/show panes within tmux) | `TmuxBackend.hidePane/showPane()` | Claude Code | Claude Code swarm |
| **User sees panes** (open Terminal.app) | `openTmuxViewer()` | Flywheel | Flywheel Lead |
| **Read pane output** | Terminal MCP `capture` | Flywheel | Flywheel Lead |
| **Send commands to panes** | Terminal MCP `input` | Flywheel | Flywheel Lead |

---

## Conclusion

**The answer is simple**: Flywheel's Lead should use `openTmuxViewer()` (already implemented in packages/core) to open Terminal.app windows showing the Runner's tmux session. This is the correct OS-level pattern, separate from Claude Code's internal pane management.

Claude Code's PaneBackend is powerful for managing teammate visibility *within* the swarm layout, but it's not designed for opening user-visible terminal windows — that's an OS/harness concern.

Flywheel's current architecture separates these concerns correctly:
- **Agents** (Lead/Runner) run locally
- **Terminal visibility** is handled by openTmuxViewer() (OS/AppleScript)
- **Read/write operations** are handled by Terminal MCP (Bash + tmux)
