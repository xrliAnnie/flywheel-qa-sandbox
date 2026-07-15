# FLY-685 close_runner 留 stale cmux tab — 调研

Issue: FLY-685 (https://linear.app/geoforge3d/issue/FLY-685/bug-close-runner-不自动从-cmux-移除-runner-tab-关了的-runner-还留-stale-tab)
日期: 2026-07-02
基于: exploration.md

---

## 目标

让 `close_runner` 关掉的 cmux workspace pin **确定地、尽快地**被移除 —— 从「最多 5 分钟 / 靠 fragile event」变成「下一个 15s watcher tick 内确定清掉」，同时不引入误关 live runner 的风险。

## 约束

1. **close_runner 没有 cmux socket** (Bridge 由 launchd 起，非 cmux app 后代)。cmux CLI 在非 cmux 后代进程里会被拒 (除非 `socketControlMode=allowAll`，生产不保证)。→ close_runner **不能自己调 cmux close-workspace**。
2. **只有 watcher 能安全关 pin**。所以 close_runner 必须**跨进程通知 watcher**。
3. **同名 runner 重启不能被误关**：pin 的 title = `{LinearId}-claude-{title}`；同一 issue 重试会复用同样的 title。任何关闭动作必须复查「window + linked session 确实都没了」才能动手。
4. **byte-compat**：默认行为改变要有 kill-switch (仿 FLY-293 `FLYWHEEL_CMUX_ORPHAN_REAPER:-1`)。

## 方案对比

### 方案 A — 定向即时 close-request 信号 (推荐)

- **close_runner (TS)**：成功 kill window 后，把该 runner 的 `window_name` append 进一个 close-request 标记文件 (`/tmp/flywheel-cmux-close-requested`，env 可覆盖)。best-effort，绝不 block/失败 close。
- **watcher (bash)**：每个 healthy drain tick 新增 `process_close_requests()`：对每个 `window_name` 解析出 cmux workspace ref，复用 **FLY-293 已有的 revalidating 闸门** `close_orphan_workspace_pin_if_still_orphan` **无 grace** 立即关。

**为什么安全 (复用 FLY-293 闸门)**：`close_orphan_workspace_pin_if_still_orphan` 在真正 close 之前会 re-read cmux JSON + strict tmux inventory，复查整套谓词：ref 未漂移 + title 未变 + `is_managed_runner_title` + 没有同名 live agent window + 没有 `cmux-<title>` linked session。close_runner 是**先杀 window + linked session 再写 marker**，所以 watcher 读到 marker 时两者确实都没了 → 谓词过 → 关。若同名 runner 已重启 (window 又活了) → 谓词不过 → 跳过 → self-heal。**无 grace 是安全的**，因为这是「已知刚被 close_runner 杀掉的具体 window」，不是猜测的 orphan —— 跟 `reap_orphan_pins_oneshot` (operator 显式动作，也无 grace) 同理。

**re-queue 语义 (鲁棒性)**：
- cmux JSON 暂时不可用 (`workspace_refs_for` rc=2) → **保留** marker 到下 tick (transient)。
- 解析到 ref 且关成功 → 丢。
- title 解析不到任何 ref (pin 已没) → 丢。
- 有 ref 但闸门跳过 (谓词不过，如重启) → 丢 (重启的 runner 拥有这个 pin 了；真变 orphan 由 FLY-293 兜)。
- startup GC：丢掉 title 在 cmux 里已无对应 workspace 的陈旧条目 (仿 `gc_orphan_pin_state_file`)。

**优点**：最小改动；复用已证明安全的闸门；定向 (只碰刚杀的那个 window，零误关 live runner 风险)；watcher 挂/cmux flap 自动退回 FLY-293 reaper；kill-switch 干净。

### 方案 B — close_runner 直接 cmux close-workspace ❌

需 cmux socket (`socketControlMode=allowAll`，生产不保证) + 在 TS 里重写 title→ref 解析 + TOCTOU 复查 (bash 里已有一份)。脆弱、重复、allowAll 没设就静默失败。**否**。

### 方案 C — 全局调小 5 分钟 grace ❌

grace 存在正是为了保护「刚创建、linked session/rename 还没跟上」的 workspace。全局调小会误关。**否**。

### 方案 D — close_runner 触发 watcher 跑 `reap_orphan_pins_oneshot` 全扫 ⚠️

写一个 flag，watcher 下 tick 跑已有的 oneshot orphan reap。改动更少，但**一次 close 触发全 orphan 集合的扫描**，粒度粗。方案 A 定向 (只碰刚杀的那个) 更精确、语义更干净。作为 A 的退路记录，不首选。

## 复用点 (不重新发明)

- **闸门**：`close_orphan_workspace_pin_if_still_orphan(ref, title)` — 已有的 TOCTOU-safe 单一 close chokepoint。
- **ref 解析**：`workspace_refs_for(title)` — 已有，tri-state (rc=0 找到 / rc=1 无 / rc=2 JSON 不可用)。
- **managed title 判定**：`is_managed_runner_title(title)`。
- **文件 marker IPC 模式**：仿 `$CLEANUP_PENDING` / `$EVENT_FILE` (append + drain + `.processing` 崩溃恢复) 与 `$ORPHAN_PIN_STATE` (startup GC)。
- **kill-switch 约定**：仿 `FLYWHEEL_CMUX_ORPHAN_REAPER:-1` (默认开，`=0` 关)。
- **window_name 来源**：`killCmuxLinkedSession` 已经在 window 还活着时 `display-message` 解析出 `window_name` (返回 `cmuxSession = cmux-<window_name>`)。让它顺带返回 `windowName`，close_runner 复用，不重复 tmux 调用。

## 边界 / 风险

- **异常死的 runner (非 close_runner)**：不碰，仍走 FLY-293 orphan reaper (带 grace)。本 issue 只加速 close_runner 这条。
- **watcher 未运行**：marker 累积；watcher 重启时 startup GC + 正常 drain 处理，或 FLY-293 reaper 兜。defense in depth。
- **marker 文件写失败** (磁盘/权限)：best-effort，吞掉，退回 FLY-293 reaper。绝不影响 close 结果。
- **bash 3.2 兼容** (macOS `/bin/bash`)：新函数只用 POSIX-ish 结构 (仿现有函数)；注意 `set -euo pipefail` 下 arithmetic 前先校验数字 (本方案 marker 里不含数字时间戳，规避该坑)。

## 测试策略

- **TS (`close-runner.test.ts` + tmux-lookup)**：
  - kill 成功 → marker 文件写入了该 window_name。
  - kill 失败 (`res.killed=false`) → **不**写 marker (window 可能还活着，别提前关 pin)。
  - `killCmuxLinkedSession` 解析不到 window_name → 不写 marker。
  - marker 写失败 → close 结果不受影响 (best-effort)。
  - `FLYWHEEL_CMUX_CLOSE_REQUEST=0` → 不写 (byte-compat)。
- **bash (`test-cmux-sync.sh` / hooks-integration)**：
  - `process_close_requests` 对 fully-gone window → 走闸门关 pin。
  - 同名 live runner 存在 → 闸门跳过，不关。
  - cmux JSON 不可用 → marker 保留。
  - kill-switch off → 完全 inert (marker 不处理)。
  - startup GC 丢陈旧条目。

## Codex design review 关注点 (提前想)

- marker→close 的 TOCTOU：靠闸门内部 re-validate 收口 (无全局锁)，同 FLY-293 R1 MED-4 的处理。
- re-queue 是否会无限增长：只有 transient JSON-unavailable 才留；其余全丢；startup GC 收尾。
- 无 grace 是否安全：是 —— 定向已知已死的 window + 闸门复查，非猜测 orphan。
