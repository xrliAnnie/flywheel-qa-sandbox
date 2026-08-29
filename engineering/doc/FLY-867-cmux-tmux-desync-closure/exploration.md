# FLY-867 cmux 侧栏跟真实 tmux 不同步 — 探索

Issue: FLY-867 (https://linear.app/geoforge3d/issue/FLY-867/bugcmux彻底收口-cmux-侧栏跟真实-tmux-不同步-死-runner-tab-关不掉-活-runner-不显示如-865修死)
日期: 2026-07-04
基于: 无

---

> **SCOPE 更正（2026-07-04，Lead 转 Annie）**：865 其实在 cmux 看得见 → 原「症状②活 runner 不显示」例子作废、无确认真例子，**不作为独立 bug 追**。确认的 bug 只有一个：**① 测完的死 runner tab 清不掉**。本文档保留调查全貌；修复叙事以 research.md（修订版）为准 —— 全部围绕死 tab 清理。

## 1. 症状 & 真机盘点

Annie 确认的 bug（2026-07-04，要求「修死别再攒」）：
1. **死 runner tab 关不掉** —— cmux 侧栏留 ~13 个 QA 完的死 grouped session tab。
2. ~~活 runner 不显示~~ —— 已作废（见上）。调查中发现的 811/852「有活进程无 tab」现象记录在案，仅作附带观察。

### 真机四方交叉盘点（runner-flywheel 组）

| window name | 活 pane | 死 husk | cmux-linked session | socket workspace | CommDB 最新态 | 分类 |
|---|---|---|---|---|---|---|
| FLY-787 | 0 | 2 | Y | MISSING | failed/completed | **纯死 husk** |
| FLY-808 | 0 | 1 | Y | Y | failed | **纯死 husk（有 tab）** |
| FLY-824 | 0 | 1 | Y | Y | completed | **纯死 husk（有 tab）** |
| FLY-842 | 0 | 1 | Y | Y | blocked | **纯死 husk（有 tab）** |
| FLY-806 | 0 | 1 | Y | Y | **awaiting_review** | 死 pane 但**非终态**（待批 PR）→ 不清 |
| FLY-834 | 1 | 1 | Y | Y | blocked(qa) | 混合：清 husk 保活窗 |
| FLY-850 | 1 | 1 | Y | Y | blocked(qa) | 混合：清 husk 保活窗 |
| FLY-811 | 2 | 0 | Y | **MISSING** | terminal(qa) | **活但无 tab（症状②）** parked-alive |
| FLY-852 | 3 | 0 | Y | **MISSING** | failed(qa) | **活但无 tab（症状②）** parked-alive |
| FLY-803/804/815/829/833/848/857/860 | 1+ | 0 | Y | Y | terminal(qa) | parked-alive（进程活，CommDB 终态） |
| FLY-696/722/863/864/865 | 1+ | 0 | Y | Y | 活（running/awaiting_review） | **活 runner（红线，不碰）** |

关键真相：Annie 以为「死了」的一批 QA（803/815/852…），其 **claude 进程其实还活着（parked）** —— FLY-752 QA fix-loop：QA FAIL 后 `declare-state park` 等重唤醒，进程不退。清它们 = 终止活进程，属红线范畴。

## 2. 根因（两症状，均真机确认）

两症状同一底层病灶：**cmux-sync 是 title/name-keyed（workspace 按 tmux window name 索引），但 tmux 允许多个同名窗口** —— retry/re-dispatch/park 反复建同名新窗口、旧窗口（死 husk 或活 parked）不清 → 累积同名多窗口。

### 症状②（活 runner 不显示）— 100% 复现确认

`create_workspace_for_window`（scripts/flywheel-cmux-sync.sh:2097）的 ready gate：
```bash
tmux select-window -t "=${view_session}:=${window_name}"   # 按 NAME 精确匹配
```
当同名多窗口存在时，tmux 报 `can't find window`（歧义），select 失败 → `deferring create` → **create 永远 defer，活 runner 永远拿不到 tab**。

隔离 tmux server 复现（2 个同名窗口）：`select-window -t "=sess:=DUPNAME"` → `can't find window: DUPNAME` rc=1。✅

生产 watcher 日志实证：811/852 每轮在 @2152/@2191/@1642（3 个重复 window_id）间循环，全部 `not ready (session/select-window) — deferring`。

### 症状①（死 tab 关不掉）— 无人 reap 终态 husk

Runner 到终态（completed/failed/blocked）后其 claude 退出，`remain-on-exit on` 留下死 husk 窗口（pane_dead=1）。**没有任何组件 reap 终态 session 的 husk**：
- **crash-reaper（FLY-720）** `getOrphanSessions` 只选 `status='running'`（StateStore.ts:2749）→ 终态 session 从不进候选。
- **GEO-270 checkStaleCompleted** 只 `notifier.onSessionStale`（HeartbeatService.ts:863）**只发通知、不 reap**。
- **cmux-sync watcher** 刻意把 dead-pin 当「present」（注释 line 695-696，边界划给 crash-reaper）→ 从不清 husk。
- **close_runner** 只在显式动作（approve/defer/terminate/auto-QA/post-merge）触发，不在每次终态自动跑。

死 husk 保住 window name「still active」→ `cleanup_stale_workspaces`（按 name 存在性判断）跳过 + `cmux-<name>` linked session 还在 → orphan-pin reaper 跳过 → **死 tab 永久累积**。

### FLY-817 缺口链印证

FLY-817（清 ~100 CommDB 僵尸行）明确把「自动化 cmux-terminal-dead-pin sweep」列 NON-goal 推 follow-up，787-class 死 pin 只做「deploy 期人工步骤」；而 FLY-819（817 QA）从没跑 → 那步人工清理也没做。**FLY-867 = 这个被推迟且从没建的自动 sweep。**

## 3. 修复方向（backstop 层收口）

不去改整条 dispatch/retry/close_runner 管线（超范围+风险高）；把 **cmux-sync watcher + reaper 层做成对同名/husk 鲁棒的 backstop**：

- **Fix A（症状②）**：`create_workspace_for_window` ready gate 改按 **window_id** 选（`$2` 已传入，grouped session 共享 window 对象，wid 是合法 view-session target），镜像 FLY-177 `refresh_linked_sessions` 已有做法。→ 同名多窗口下 create 不再歧义失败。
- **Fix B（症状①）**：watcher 新增周期 husk-reaper：reap **死 husk（pane_dead=1）且非 crash-reaper 所有（终态 session）** 的 runner 窗口 + 其 cmux tab，grace 门 > crash-reaper 总 grace 保 forensics 边界。

## 4. 待 Lead 决策点（brainstorm gate）

1. **清理策略**：Annie 以为死的多是 parked-alive（活进程）。安全能清的**纯死 husk 只有 787/808/824/842 + 834:26/850:27（~6 窗）**；parked-alive（803/811/815/852…）要清=终止活进程（红线，需授权）。是否只清纯死 husk、parked-alive 留给 Annie 单独定夺？
2. **Fix B 归属**：husk reaper 放 watcher（bash，自包含、不需重启 Bridge）还是 Bridge crash-reaper（正统 owner、知 CommDB 态、但需重启）？倾向 watcher。
3. **806（awaiting_review 死 pane）**：非终态、待批 PR，暂不清、单独 flag？
