# FLY-754 viewer-execid session 堆积 — 调研

Issue: FLY-754 (https://linear.app/geoforge3d/issue/FLY-754/infrarootp1-viewer-execid-session-堆积-生成源不销毁annie-眼看它们自己-attach永久解)
日期: 2026-07-01
基于: exploration.md

## 代码地图（改动涉及的全部位点）

### 生成源

| 位点 | 作用 |
|------|------|
| `packages/core/src/tmux-viewer.ts:180-202` | `resolveViewerBackend()` + `viewerUsesTerminalApp()` —— FLY-650 中央 gate。**当前对 `"cmux"` 和 `"terminal-app"` 都返回 true** |
| `packages/core/src/tmux-viewer.ts:231-283` | `openTmuxViewer()` — gate 在最前（:236），过 gate 就进 opener 队列 |
| `packages/core/src/tmux-viewer.ts:285-341` | `doOpen()` — step 3 `setupViewerSession()` 建 `viewer-<execId>`；step 5 `runOpen()` osascript 开 tab；step 6 `runVerifyLog()` log-only |
| `packages/core/src/tmux-viewer.ts:475-502` | `runOpen()` — osascript 失败只 `console.warn`，**不清理已建的 viewer session**（泄漏点） |
| 调用方（全部经 gate）| `run-dispatcher.ts:364`、`run-dispatcher.ts:636`、`DagDispatcher.ts:92` — `onTmuxWindowCreated` 回调 |

### 销毁路径（保持不动）

- `closeRunnerTerminalView()`（tmux-viewer.ts:623）：close-runner.ts:296 / post-merge.ts:78 / actions.ts:1094（terminate）/ plugin.ts:2729（crash-reaper 注入）
- `terminal-tab-reaper.ts:157`：启动 one-shot，按 Terminal tab 标题扫（没 tab = 收不了）

### 兜底 sweep 需要的基建

- **挂载点**：`plugin.ts:2222-2233` — terminal-tab-reaper 的 fire-and-forget 位置，viewer sweep 加在旁边（同样 one-shot、fire-and-forget）
- **归属判定**：viewer 是 grouped session，`tmux ls -F '#{session_name}|#{session_group}|#{session_attached}'` 直接给出 base session 名 + attach 数（本机实测格式 `viewer-<uuid>|runner-flywheel|0`）
- **本 Bridge 的 base session 集合**：`run-infra.ts:548` 的 `sanitizeTmuxName(\`runner-${project.projectName}\`)`（`sanitizeTmuxName` 在 `packages/core/src/tmux-naming.ts:17`）；plugin.ts bootstrap 手里有 `projects: ProjectEntry[]`
- **终态判定**：`StateStore.ts:160-171` `OUTCOME_STATUSES`（completed/approved/approved_to_ship/blocked/failed/rejected/deferred/shelved/terminated）。注意 `TERMINAL_STATUSES` 包含 `awaiting_review`（FSM 单调性用），**sweep 不能用它** —— awaiting_review runner 活着等 wake

### 测试基建

- `packages/core/test/tmux-viewer.viewer-backend.test.ts` — FLY-650 gate 测试（`vi.mock("node:child_process")`，断言 cmux=true 需翻转）
- `packages/core/test/tmux-viewer.test.ts` / `.macos.test.ts` / `.concurrent.test.ts` — opener 流水线测试（跑在 terminal-app 语义下，需检查是否依赖 cmux 默认）
- `packages/teamlead/src/__tests__/terminal-tab-reaper.test.ts` — 新 sweep 测试的样板

## 关键设计判断

### 1. gate 收窄是「真行为变更」，不是 byte-compat（Lead 已确认接受）

FLY-650 故意让 cmux 保持旧行为；本修有意推翻它：cmux 机器上 Terminal.app opener 是坏的（tab drop）+ 冗余的（cmux-sync 已全权）。变更后：
- backend=`cmux` → 走与 `tmux-only` 相同的 skip 分支（log 一行、直接 return）
- backend=`terminal-app` → 行为不变（测试锁死）
- Linux（`tmux-only`/`none`）→ 本来就 skip，不变

### 2. runOpen 失败清理的安全边界

- osascript **报错**（`execFilePromise` reject）= tab 确定没建出来 → kill viewer session 安全。
- verify「tab not found」**不能**清理：osascript 查询可能失败/超时而 tab 实际存在，误杀会砍断活 attach。保持 log-only（FLY-128 设计有意如此）。

### 3. sweep 的判定规则（保守、race-free）

对每个 `viewer-<execId>`（`session_attached == 0`）：
- StateStore 有 row 且 status ∈ OUTCOME_STATUSES → **kill**（跑完没销毁的目标场景）
- 有 row 且 running/pending/awaiting_review 等活态 → **skip**（close_runner 以后管）
- 无 row → 仅当 `session_group` ∈ 本 Bridge base session 集合才 **kill**（自家真孤儿）；否则 skip —— 防止生产 Bridge 误杀 QA slot Bridge（`runner-test-slot-N`）的活 viewer（本机实测两类并存）
- `session_attached > 0` → 永远 skip（有人真在看）

viewer 是 grouped session：kill 只销毁这个「视图把手」，runner window/scrollback 全在 base session，不受影响（tmux session-group 语义 + FLY-116 注释确认）。

### 4. approved_to_ship 的例外？

approved_to_ship 在 OUTCOME_STATUSES 里但 runner 还要 ship（活着）。**sweep 需把 approved_to_ship 从 kill 集排除**（复用 OUTCOME_STATUSES 再 delete，或显式列表）。blocked/failed 可以 kill：0 client 说明没人在看，且 kill viewer 不碰 scrollback（PRESERVE 语义只针对 Terminal tab）。

## 真机验证方案（Lead 要求，Annie E2E 标准）

1. **修后 dispatch 0 新增**：529 Room slot 真 dispatch 一个 runner，`tmux ls | grep viewer- | wc -l` 前后对比 = 0 新增；Bridge log 出现 skip 行。
2. **sweep 清存量**：staging Bridge 重启，`viewer-*`（0 client、终态/自家孤儿）清零，数字前后对比。生产存量（当前 21 个）等 Tadashi 协调的批次重启验证（Cass 盯）。

## nested-attach（follow-up，不并入）

结论见 exploration.md：来源 = cmux-sync heal/reopen 文本注入竞态（FLY-169/254 的 gate→send 非原子），与 viewer 堆积无因果。行动：开 Flywheel label 的 follow-up issue，relates FLY-754。
