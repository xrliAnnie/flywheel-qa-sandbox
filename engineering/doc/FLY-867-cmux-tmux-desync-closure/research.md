# FLY-867 cmux 不同步 — 技术调研

Issue: FLY-867 (https://linear.app/geoforge3d/issue/FLY-867/bugcmux彻底收口-cmux-侧栏跟真实-tmux-不同步-死-runner-tab-关不掉-活-runner-不显示如-865修死)
日期: 2026-07-04
基于: exploration.md

> **SCOPE 更正（Lead 转 Annie）**：症状②（活 runner 不显示）作废，无确认真例子。**primary = 死 tab 清理修死 + QA 验证 + 清现存（只碰死的）**。下文 Fix A 的定位相应从「症状②修复」改为「死 tab 清理链的 select 正确性配套」（§2 已按新 scope 重排）。

---

## 1. 精化根因（真机日志 + 隔离复现，均已证）

### 底层病灶（一句话）
cmux-sync 用 **window name 作 key**，但 tmux 允许同名多窗口，且 **dead husk 窗口（remain-on-exit 尸体，pane_dead=1）不被过滤**。retry/park 反复建同名窗口、旧窗（husk 或活 parked）不清 → 累积同名窗口 → 打穿 name-keyed 模型。

### 症状①「死 tab 关不掉」= CREATE↔CLEANUP 无限震荡
`cleanup_stale_conservative`（脚本 2572）用 `is_pane_alive`（跨同名窗口查 pane_dead），死 husk 5min 后 → `cleanup_workspace_for`：关 cmux workspace + 杀 linked session **但不杀源 husk 窗口**。`get_tmux_agent_windows`（317）只滤 `|zsh$`/`|bash$`，**不滤 dead husk** → 下轮 `sync_additive` 仍见 husk 窗口 → `workspace_exists_for` MISSING → `create_workspace_for_window` 重建。
- **日志实证**（FLY-808，~7min 周期，workspace ref 一路递增）：
  ```
  12:51:56 close workspace:968 reason=stale-FLY-808   ← cleanup 关
  12:53:20 Creating workspace FLY-808 (@749)          ← additive 重建
  12:59:05 close workspace:972 ...                     ← 再关
  13:00:29 Creating workspace...                        ← 再建 (…→ws:1020)
  ```
- **单 husk（808/824/842）**：无歧义 → 每轮成功重建 → tab 常驻可见。
- **双 husk（787）**：select 歧义（见下）→ 建不了 → 当前 tab 消失但 husk 窗口滞留。

### 症状②「活 runner 不显示」= select-window 同名歧义
`create_workspace_for_window` ready gate（脚本 2097-2101）：
```bash
tmux select-window -t "=${view_session}:=${window_name}"   # 按 NAME 精确
```
同名多窗口 → tmux 报 `can't find window`（歧义）→ `deferring create` → **create 永远 defer**。
- **隔离 tmux server 复现**：2 个同名窗口，`select-window -t "=sess:=DUPNAME"` → `can't find window: DUPNAME` rc=1。✅
- **生产日志**：811(2活)/852(3活) 每轮在多个 window_id 间循环全部 `not ready — deferring`。

### 为何无人 reap 终态 husk（症状①的「攒」源头）
- crash-reaper（FLY-720）`getOrphanSessions` 只选 `status='running'`（StateStore.ts:2749），orphanThreshold 默认 60min → **终态 session 永不进候选**。
- GEO-270 `checkStaleCompleted` 只 `notifier.onSessionStale`（HeartbeatService.ts:863）**只 notify、不 reap**。
- cmux-sync 刻意把 dead-pin 划给 crash-reaper（注释 695-696）。
- close_runner 只在显式动作触发。
→ 终态 session 的 husk 无人 reap，永久累积。FLY-817 明确把这个自动 sweep 推 follow-up（且 819 QA 从没跑）。

## 2. 修复设计（按新 scope 重排：全部服务「死 tab 清理 + 别再攒」）

死 tab 清理链三环，缺一不可：
- **Fix B（止震荡）** = 核心：husk-only name 不再被重建 → tab 关掉后保持关闭。
- **Fix C（husk reaper）** = 别再攒：把 husk 窗口本身 reap 掉，源头归一。
- **Fix A（by-id select）** = 清理系统的安全配套：混合场景（如 834/850 = 1 死 husk + 1 活窗）里 tab 若被清后需重建，ready-gate 按 name select 会因 tmux 端同名 husk 歧义失败 → **活 runner 的 tab 建不回来**（清理误伤活 runner 可见性）。Fix B 只滤 create 候选、不消 tmux 端歧义，必须配 Fix A。

### Fix A — create ready-gate 按 window_id 选（清理链 select 正确性配套）
`select-window -t "=${view_session}:=${window_name}"` → `select-window -t "=${view_session}:${window_id}"`（`$2` 已传入 create_workspace_for_window）。grouped session 共享 window 对象，wid 是合法 view-session target；镜像 FLY-177 `refresh_linked_sessions`（脚本 2230）已验证做法。一行改动，低风险。
- 顺带：`create_recently_attempted`/`create_mark_attempted` 已按 (name,id) keyed，天然兼容。

### Fix B — 从 create 候选集排除 dead husk（止震荡，核心）
`get_tmux_agent_windows`（或 sync_additive/bootstrap 的 create 循环）跳过 **源 pane 全死** 的 window。husk-only name 不再被重建 → cleanup_stale_conservative 关掉 tab 后**保持关闭**（不再震荡）。
- 关键：不能全局改 `get_tmux_agent_windows`（is_pane_alive/reconcile/refresh 依赖它含 husk 判死活）。**只在 create 循环点加 husk-skip 门**最小、最安全。倾向新增 `window_source_pane_alive <sess> <wid>` 谓词，在 create 前置判断。

### Fix C — husk 窗口 reaper（「别再攒」，tmux 层）— 设计空间（交 Codex design review + Lead 定）
死 husk 窗口本身滞留 tmux（无 cmux tab，但累积 + 占内存）。reap 需**尊重 FLY-720 边界**（crash-reaper 拥 running-session 的 dead-pin，做 forensics scrollback 抓取，orphanThreshold 60min+crashGrace 后才 reap）。
- **方案 C1（duplicate-only，无 CommDB，最安全）**：只 reap「有活同名兄弟窗口」的 dead husk（纯重复尸体）。live 兄弟 = runner 活着 = crash-reaper 不会 own → 零 forensics 竞争。处理 834:26/850:27/787-dup。但**不覆盖 husk-only 终态**（808/824/842）。
- **方案 C2（long-grace）**：dead husk 死超过 grace（默认 90min，> crash-reaper 60min+crashGrace）才 reap，env 可调 + kill-switch。覆盖 husk-only；forensics 让 crash-reaper 先手（running 案例 60min 内不动）。
- **方案 C3（CommDB-coupled）**：bash 查 teamlead.db，只 reap 终态 session 的 husk。最精确但 window→execId 映射难（tmux_session 列空、一 issue 多 session）→ 复杂、耦合，倾向不做。
- **倾向 C1 + C2 组合**：C1 立即清重复尸体；C2 兜底 husk-only 终态。kill-switch `FLYWHEEL_CMUX_HUSK_REAPER=0` byte-compat。

## 3. 测试策略（TDD）
- Harness：`scripts/test-cmux-sync.sh`（4021 行），MOCK 系统（`MOCK_TMUX_WINDOWS`/`MOCK_PANE_DEAD`/`MOCK_TMUX_SELECTS`/`MOCK_CMUX_WORKSPACES_JSON`）+ 真 tmux 集成段（sandbox-gated）。
- **Fix A**：增强 mock `select-window`——`=sess:=name` 在 MOCK_TMUX_WINDOWS 中同名 ≥2 时 rc=1（忠实还原真 tmux 歧义），`=sess:@id` 命中即 rc=0。RED：旧码 dup-name 建不出 workspace；GREEN：Fix A 按 id 建成。既有 by-id 测试（FLY-177）不受影响。
- **Fix B**：MOCK 双窗口（1 活 @9 + 1 死 husk @7 同名）→ 断言 create 只对活窗口发起、husk-only name 不进 create。
- **Fix C**：MOCK 死 husk + 活兄弟 → 断言发 kill-window；husk 死 < grace → 不 reap；kill-switch=0 → 完全 inert。
- **真 tmux 集成**（sandbox 允许时）：造同名双窗口 + remain-on-exit 死 pane，端到端验 create-by-id + husk 不震荡。
- 全量 `bash scripts/test-cmux-sync.sh` 必须全绿（回归）。

## 4. 现存 mess 清理（Phase 1，ops）— 复核后精确窗口清单（2026-07-04 14:5x 快照）
- **纯死 husk（安全清，7 窗）**：787→4@603+12@283、808→1@749、824→19@1420、842→23@1517、834→26@1614（活兄弟 17@1412 保留）、850→27@1615（活兄弟 25@1583 保留）。→ kill 死 husk 窗口；husk-only 的 name（787/808/824/842）连带关其 cmux workspace + 杀 `cmux-<name>` linked session。
- **⚠️ 关键事实（必须 surface 给 Annie）**：她看到的 ~13 个「QA 完的死 tab」大部分（803/804/811/815/819/829/833/848/852/857/860）背后是 **parked-ALIVE claude 进程**（FLY-752 park / idle 等 wake）—— tab「在」是系统如实反映活进程。**只修死 tab 机制 + 清 7 窗 husk，这些 tab 不会消失。** 要它们消失 = Lead 走 `close_runner` 正规拆（Lead 驱动 runner lifecycle），清单交 Lead 拍。上游观察：parent 已 ship/close 的 parked QA 无人 finalize —— 管线缺口，列 follow-up，不并入本次 backstop。
- **806（awaiting_review 死 pane 13@710）**：非终态、待批 PR，但进程已死 ≠ 正常 awaiting（正常 awaiting 进程活着等 mailbox wake）→ 异常态，**不清**、flag 给 Lead。
- cmux tab 移除经 socket 操作（close-workspace，cmux 自持久化 state JSON）；不直接手改 state JSON 文件（若必须，原子写+备份）。**只碰死的，绝不碰活 lead/活 runner。** 清完报数字。
