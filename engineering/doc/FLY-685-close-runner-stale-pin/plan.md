# FLY-685 close_runner 留 stale cmux tab — 实施计划

Issue: FLY-685 (https://linear.app/geoforge3d/issue/FLY-685/bug-close-runner-不自动从-cmux-移除-runner-tab-关了的-runner-还留-stale-tab)
日期: 2026-07-02
基于: research.md

Version: v1.56.0 (暂定；以 doc/VERSION 当前 v1.55.0 递增，ship 时以 Codex/CI 为准)
Status: codex-approved (design review 2 轮 APPROVED, 2026-07-02)

---

## 目标 (一句话)

让 `close_runner` 成功关掉 runner 后，把它那个 cmux workspace pin (左边 tab) **在下一个 15s watcher tick 内确定移除** —— 复用 FLY-293 已证明安全的关闭闸门，无 grace 但仍复查「window+linked-session 确已没」，同名重启不误关。异常死路径不变 (仍走 FLY-293 reaper 兜底)。

## 方案 (Tadashi 已批 · 方案 A)

close_runner (TS) 成功 kill window 后，写一条「close-request marker」(runner 的 `window_name`) → watcher (bash) 每 tick 读它，对每个 window_name 复用 `close_orphan_workspace_pin_if_still_orphan` 立即关 pin。

## 关键设计决定

1. **window_name 来源 = 复用 `killCmuxLinkedSession` 已返回的 `cmuxSession`** (`cmux-<window_name>`)，strip 前缀得 `window_name`。**不改** `killCmuxLinkedSession` 的返回 shape → 不碰 FLY-638 的 5 个 `toEqual` 测试。`cmuxSession` 只在 window 还活着能解析出 name 时存在 → window 已没时自然不写 marker (对：没东西可定向)。
2. **只在 `res.killed === true` 后写 marker**。kill 失败 (runner 可能还活着) 绝不写 → 不会提前关一个还活着 runner 的 pin。
3. **无 grace 安全**：marker 是「已知刚被 close_runner 杀掉的具体 window」，不是猜测 orphan；闸门内部仍 re-validate (window+linked-session 都没 + title 未漂移 + managed)。同 `reap_orphan_pins_oneshot` (operator 显式动作也无 grace)。
4. **kill-switch 默认开** (`FLYWHEEL_CMUX_CLOSE_REQUEST:-1`，`=0` 关) —— 两侧 (TS 写 + bash 读) 都 gate，`=0` 时 = 字节兼容旧行为 (退回 FLY-293 reaper)。
5. **异常死不碰**：非 close_runner 死掉的 runner 仍由 FLY-293 orphan reaper 兜 (带 grace)。

## 改动清单

### A. TS — 新 marker-write 模块 `packages/teamlead/src/bridge/cmux-close-request.ts`

```
export function requestCmuxPinClose(windowName: string): void
```
- 读 env `FLYWHEEL_CMUX_CLOSE_REQUEST` (默认 "1"；`=== "0"` → 直接 return，不写)。
- 读 env `FLYWHEEL_CMUX_CLOSE_REQUEST_FILE` (默认 `/tmp/flywheel-cmux-close-requested`)。
- **校验 windowName**：非空、trim 后非空、**不含换行/制表** (marker 文件是 line-based，含换行会腐化)、长度上限 (如 ≤200)。不合法 → skip (不抛)。
- best-effort append 一行 `windowName\n` (`fs.appendFileSync`，`try/catch` 吞错)。**绝不抛**、绝不 block close。

### B. TS — `packages/teamlead/src/bridge/close-runner.ts`

- import `requestCmuxPinClose`。
- 把 `await killCmuxLinkedSession(target.tmuxWindow).catch(...)` 改成 **捕获返回值** `const cmuxRes = await killCmuxLinkedSession(...).catch(() => undefined)`。
- 在成功 kill window 分支 (`res.killed`) 内，**在 `closeRunnerTerminalView` 之前** 写 marker：
  ```
  const wname = cmuxRes?.cmuxSession?.startsWith("cmux-")
    ? cmuxRes.cmuxSession.slice("cmux-".length)
    : undefined;
  if (wname) requestCmuxPinClose(wname);
  ```
- **位置=marker 写在 terminal-view 关闭之前**(Codex R1 #1)：`closeRunnerTerminalView` 是 best-effort UI 清理、await 一个**无 exec timeout 的 `osascript`** (`packages/core/src/tmux-viewer.ts` osascript close)，若它 hang，tmux window 已没但 marker 没写 → pin 掉回 5 分钟 FLY-293 兜底,破坏「immediate」保证。tmux kill 已成功 + watcher 仍会 revalidate → 提前写不增加误关风险。marker 写在 `res.killed` 确认后、`closeRunnerTerminalView` + 审计 event 之前。best-effort，不影响 close 结果。

### C. Bash — `scripts/flywheel-cmux-sync.sh`

1. **config** (顶部 config 区，仿 `ORPHAN_PIN_STATE`)：
   ```
   CLOSE_REQUEST_FILE="${FLYWHEEL_CMUX_CLOSE_REQUEST_FILE:-/tmp/flywheel-cmux-close-requested}"
   ```
2. **扩展 chokepoint 的 rc 契约** `close_orphan_workspace_pin_if_still_orphan` (Codex R1 #3)：把「**不确定**」(cmux JSON / tmux inventory 读失败：`get_cmux_workspaces_json`、`tmux list-sessions`、`collect_agent_window_names_strict`、python 解析失败) 的 `return 1` 改成 **`return 2`**；保留 `return 1` 给「**谓词跳过**」(malformed ref / ref gone / title drift / 非 managed / live window / linked session 还在)。
   - **对现有 FLY-293 caller 字节兼容**：`reap_orphan_workspace_pins` / `reap_orphan_pins_oneshot` 都是 `if close_...; then 成功; else 未关; fi` —— 任何非零都走「未关」分支，rc=2 与 rc=1 行为一致，不变。
   - 意义：让 `process_close_requests` 能区分「暂时不确定 (rc=2，可 re-queue)」vs「谓词跳过 (rc=1，绝不 re-queue —— 否则旧 marker 会穿过同名重启 runner、日后无 grace 关掉一个异常死 pin)」。
3. **新函数 `process_close_requests()`** (放在 FLY-293 reaper 区附近，紧接 `reap_orphan_pins_oneshot` 之后)：
   - kill-switch: `[[ "${FLYWHEEL_CMUX_CLOSE_REQUEST:-1}" == "0" ]] && return 0`
   - crash-recovery: 若存在 `${CLOSE_REQUEST_FILE}.processing` 先处理它 (仿 drain_events)。
   - `[[ -f "$CLOSE_REQUEST_FILE" ]] || return 0`；`mv "$CLOSE_REQUEST_FILE" "$tmp"` (原子取走，避免与 close_runner 并发 append 竞态)。
   - 逐行 window_name。**输入硬化 (Codex R1 #4，marker 文件当不可信本地 IPC)**：在 `is_managed_runner_title` 之前先拒空行、含 tab、超长行 (仿 `orphan_pin_refs` 跳过含 tab/newline 的 title)。
     - 非 `is_managed_runner_title` → 丢 (不是我们该动的 pin)。
     - **rc 捕获必须显式** (Codex R1 #2，`set -euo pipefail` 下 `refs=$(...)` 非零会直接退出 watcher)：
       ```bash
       local refs rc=0
       refs=$(workspace_refs_for "$wname") || rc=$?
       if [[ $rc -eq 2 ]]; then
         printf '%s\n' "$wname" >> "$CLOSE_REQUEST_FILE" 2>/dev/null || true   # cmux JSON 不可用 → re-queue
         continue
       fi
       ```
     - rc=0 且无 ref → 丢 (pin 已没)。
     - rc=0 且有 ref → 每个 ref：`local crc=0; close_orphan_workspace_pin_if_still_orphan "$ref" "$wname" || crc=$?`
       - crc=0 → closed_any=1，丢。
       - **crc=2 (final gate 不确定) → re-queue** (append 回 `$CLOSE_REQUEST_FILE`)。
       - crc=1 (谓词跳过=重启/非 orphan/已没) → 丢 (交回 FLY-293 兜，**绝不 re-queue**)。
   - `rm -f "$tmp"`；`[[ closed_any ]] && cmux_call refresh-surfaces || true`。
4. **wiring**：watch_loop 里 `process_pending_cleanups` 之后 (line ~2529) 加 `process_close_requests`。同时 `--once` 路径 (sync_once/reap 附近) 也调一次 (可选，保持与 reap 一致；主战场是 watch)。
5. **startup GC `gc_close_request_file()`** (仿 `gc_orphan_pin_state_file`)：丢掉 title 在 cmux 里已无对应 workspace 的陈旧行；env-gated (`FLYWHEEL_CMUX_CLOSE_REQUEST` off → skip)。在 `watch_main` 里 `gc_orphan_pin_state_file` 附近调用。cmux JSON 不可用 → skip (保留)。

## TDD 顺序 (RED → GREEN → REFACTOR)

### TS
1. `cmux-close-request.test.ts` (新)：
   - 写入：`requestCmuxPinClose("FLY-685-claude-x")` → 文件含该行。
   - env 覆盖文件路径生效。
   - append：两次调用 → 两行。
   - kill-switch `FLYWHEEL_CMUX_CLOSE_REQUEST=0` → 不写。
   - 非法 windowName (空 / 含 `\n` / 超长) → 不写。
   - 文件写失败 (指向不可写路径) → 不抛。
2. `close-runner.test.ts` (扩展，env 指向 temp 文件)：
   - killed close (cmuxRes 有 `cmuxSession`) → marker 写了对应 window_name。
   - `res.killed=false` → **不**写 marker。
   - cmuxRes 无 cmuxSession (window 已没) → 不写。
   - kill-switch off → 不写。
   - marker 写失败不影响 close 返回值 (仍 `{closed:true}`)。

### Bash (`scripts/test-cmux-sync.sh` + 视需要 hooks-integration)
3. `process_close_requests`：fully-gone window (stub: 无 live agent window + 无 cmux-<title> session + workspace 存在) → 闸门关 pin (断言 `close-workspace` 被调)。
4. 同名 live agent window 存在 → 闸门跳过 (rc=1)，不关，**不 re-queue** (marker 被丢)。
5. cmux JSON 不可用于 `workspace_refs_for` (rc=2) → marker re-queue (文件仍含该行)。
6. **`set -euo pipefail` 生存测试** (Codex R1 #2)：在 `( set -euo pipefail; ... )` 子壳里跑 `process_close_requests`、`workspace_refs_for` 返 rc=2 → 断言子壳**不退出** (watcher 存活) 且 marker 被 re-queue。
7. **final gate rc=2 re-queue** (Codex R1 #3)：`workspace_refs_for` rc=0 有 ref、但 `close_orphan_workspace_pin_if_still_orphan` 返 rc=2 (JSON 在终检时不可用) → marker re-queue；返 rc=1 (谓词跳过) → 丢。
8. **chokepoint rc 契约**：`close_orphan_workspace_pin_if_still_orphan` —— JSON/tmux 读失败 → rc=2；title drift / live window / linked session 还在 → rc=1。(顺带确认 FLY-293 `reap_orphan_workspace_pins` 现有测试仍绿：非零一律「未关」。)
9. **输入硬化** (Codex R1 #4)：marker 文件含空行 / 含 tab / 超长行 → 被拒 (不进 `is_managed_runner_title`、不关任何 pin)。
10. kill-switch `FLYWHEEL_CMUX_CLOSE_REQUEST=0` → 完全 inert (marker 不动)。
11. `gc_close_request_file` 丢陈旧行 (title 无对应 workspace)。

## 验证 / QA

- 全仓 `pnpm lint` (biome) + 两侧单测绿。
- bash: `bash -n` + Linux CI；但注意 bash 3.2 parse-vs-execute 分歧 (FLY-694 教训) —— 新函数只用现有函数同款结构，marker 不含数字时间戳 (规避 `set -euo pipefail` arithmetic 坑)。
- 独立 QA (Tadashi 要求)：真机 —— close_runner 一个真 runner → 观察 cmux tab 在 ≤15-30s 内消失 (对照修前留 5 分钟)；kill-switch off 时退回旧行为。
- **别自 ship** (Tadashi 明确)：PR → Codex code review → 独立 QA → founder gate。

## 风险 / 边界

| 风险 | 处理 |
|------|------|
| watcher 未运行 | marker 累积；重启 startup GC + drain 处理，或 FLY-293 reaper 兜。defense in depth。 |
| cmux flap / JSON 不可用 | 初检 (`workspace_refs_for` rc=2) **和** 终检 (`close_orphan_...` rc=2) 都 re-queue 到下 tick；持续不可用则 FLY-293 reaper 5min 兜。谓词跳过 (rc=1) 绝不 re-queue → 旧 marker 不会穿过同名重启 runner。 |
| 同名 runner 重启 | 闸门 re-validate (live window 存在→跳过)；无 grace 仍安全 (定向已死 window)。 |
| marker 文件权限/磁盘错 | best-effort，吞掉，退回 reaper，不影响 close。 |
| bash 3.2 兼容 | 复用现有函数结构；marker 无数字算术；bash -n + CI。 |
| 字节兼容 | 两侧 kill-switch，`=0` 逐字旧行为；OFF sentinel 测试。 |

## Codex design review 关注点 (提前答)

- **TOCTOU (marker→close)**：靠 `close_orphan_workspace_pin_if_still_orphan` 内部 re-validate 收口 (无全局锁)，同 FLY-293 R1 MED-4。
- **re-queue 无限增长**：只有 transient JSON-unavailable 才留；其余全丢；startup GC 收尾。
- **无 grace 安全性**：定向已知已死 window + 闸门复查，非猜测 orphan。
- **并发 append vs mv**：mv-to-.processing 原子取走 + re-queue 用 `>>` append 回，仿 drain_events TOCTOU 处理。
