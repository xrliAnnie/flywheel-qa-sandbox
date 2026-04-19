# Exploration: QA Test Slot Framework — Real Runner Support (A1 + W1 + F1) — FLY-115

**Issue**: FLY-115 (Extend test slot framework to support real Runner E2E)
**Date**: 2026-04-18
**Status**: Draft
**Trigger**: FLY-108 PR #155 Round 2 QA blocked — synthetic E2E 无法覆盖 "Lead → Runner → spin → PR" 完整链路；S4 (CIPHER backfill) 因 `:memory:` DB 被 DEFERRED。
**Blocks**: FLY-108 ship（Round 2 必须用新框架重跑）、FLY-99 Runner worktree fix QA、FLY-96 之后任何需要真 Runner 的 QA。

---

## 1. 问题域

### 1.1 FLY-96 现有框架做了什么

`scripts/test-deploy.sh` 在 `/tmp/flywheel-test-slot-N/` 起一个 Bridge + Lead（tmux），用 4 个 Discord test bot token、4 个隔离 channel、4 个端口，支持 4 个 QA agent 并行跑 **synthetic** Discord E2E：
- QA 手写 Linear-shape / session-shape payload 直接 POST 到 Bridge `/events`
- Bridge 发 `runs.start` / `session_completed` / `session_failed` 给 Lead
- Lead 读 inbox 发 Discord 通告
- QA 用 Chrome-in-Discord 验收

这条链路覆盖 **Bridge ↔ Lead ↔ Discord**，但完全不碰 Runner。

### 1.2 FLY-108 Round 2 暴露的 4 个 gap

按 Round 1 QA report + team-lead brief：

| # | Gap | 症状 | 影响 |
|---|-----|------|------|
| G1 | `projectRoot` 是空目录 `mkdir -p` | Runner `git worktree add` 直接挂（目标不是 git repo） | Runner 起不来 |
| G2 | `projectRepo = "test/test-slot-N"` 是假 slug | Runner `gh pr create` 挂（仓库不存在） | spin 最后一步 fail |
| G3 | Linear webhook 只指向 prod Bridge | test Bridge `localhost:19872` 收不到 `issue.assigned` | test Lead 永远不会自动分派 issue |
| G4 | `TEAMLEAD_DB_PATH=:memory:` | 外部查不到 session 行（CIPHER backfill 黑盒失败） | AC-8 类 AC 无法验证 |

这 4 个 gap 不是 FLY-96 设计错误 — synthetic 模式下它们是合理的省事。问题是我们现在要真跑 Runner，这些 shortcut 全部失灵。

---

## 2. 方案：A1 + W1 + F1（Annie 已拍板）

### 2.1 三个决定，各自独立正交

| Lane | Decision | 解决 gap |
|------|----------|---------|
| **A1** Sandbox fork repo | Runner push 到 `xrliAnnie/flywheel-qa-sandbox`，PR 开在 sandbox | G1 + G2 |
| **W1** Bypass Linear webhook | 新 `scripts/inject-linear-issue.sh` 直接写 inbox，不等 webhook | G3 |
| **F1** Sandbox 是 flywheel 的 fork | 继承 `.claude/commands/spin.md` + `CLAUDE.md` + infra | Runner 跑 spin 不用额外 setup |
| 附带 | `TEAMLEAD_DB_PATH` = slot-local SQLite 文件 | G4 |
| 附带 | Bridge stdout/stderr → `${SLOT_DIR}/bridge.log` | Round 1 QA 遗愿 — 看不到 Bridge 行为 |

### 2.2 为什么不选其他路线

**替代 A (A2)**：每个 slot 一个临时 throw-away repo。
- ❌ 每次 deploy 要 `gh repo create`，需要高权限 token，易累积废 repo，污染账号
- ❌ 无法继承 flywheel 的 spin.md / CLAUDE.md，Runner 起来后行为不可预测

**替代 W (W2)**：给 Linear 配多 webhook 指向 `localhost:19872`（用 ngrok / cloudflared）。
- ❌ 外部依赖（tunnel）不稳，webhook 去重难，Linear 侧还要为每个 slot 配一个 webhook
- ❌ 违背"不改 production infra 跑 QA"原则

**替代 F (F2)**：sandbox 是空 repo，Runner 跑前手动 bootstrap。
- ❌ 复杂度转嫁给 test-deploy.sh 或 QA agent，维护负担大
- ❌ fork from flywheel 自动 track upstream，sync 脚本最简单

→ **A1 + W1 + F1** 是决定成本最低、复原性最强的组合。

### 2.3 `--from-branch` 参数的必要性

测 FLY-108 时，slot 的 spin.md 必须是 **待测 PR 分支**的版本（Step 3.7 close-runner 逻辑在那个分支）。如果 slot 永远 checkout sandbox main，测 unmerged PR 等于白测。

所以 `test-deploy.sh --from-branch <branch>`（默认 main）决定 `git worktree add` 的起点。branch 必须在 sandbox 里存在（QA 或 Runner push 到 sandbox，或从 flywheel cherry-pick 过去）。

> **Codex review 必问**：branch 怎么到 sandbox？是 QA 手工 push？还是 deploy 自动 fetch from flywheel？详见 §5 Open Question OQ1。

---

## 3. 工作边界

### 3.1 In-scope（本 issue 做）

- `scripts/test-deploy.sh` 改造（参数、worktree、sandbox remote、DB path、bridge.log、pnpm rebuild better-sqlite3）
- `scripts/test-teardown.sh` 改造（worktree remove、branch cleanup、DB 清理）
- 新 `scripts/inject-linear-issue.sh`（写 Linear-shape payload 到 inbox）
- `.env` 新增 `FLYWHEEL_SANDBOX_REMOTE_URL`
- `doc/qa/framework/sandbox-sync-guide.md`（手工 sync 流程）
- `doc/qa/framework/real-runner-e2e-guide.md`（QA 怎么用 --from-branch）
- `packages/qa-framework/README.md`（real vs synthetic mode 对照）

### 3.2 Out-of-scope（刻意不碰）

- **创建 sandbox repo** — Annie 手工 `gh repo fork xrliAnnie/flywheel --fork-name flywheel-qa-sandbox`（已明确是 Annie 手工步骤）。plan 里以 ⚠️ 高亮 pre-deploy 前置条件。
- **自动 sync sandbox main** — 本 issue 只写 guide，不做 cron。未来如果频繁 drift 可单独起 issue。
- **QA 把待测 branch push 到 sandbox 的机制** — 把这个抽成一行 guide：`git push sandbox feat/...:feat/...`，不做自动化。
- **Linear webhook 真通路验证** — production infra，不在 per-PR QA scope（brief 明确）。
- **支持 4 个 slot 同时跑 real Runner** — 能并行，但 sandbox branch 命名要唯一（`qa-slot-${N}-${timestamp}`），这部分在 plan 里明确。
- **改 spin.md 或 Runner 代码** — 一行都不改。
- **改 Bridge / Lead 代码** — 一行都不改。配置化改动都走 env。

### 3.3 与 FLY-96 的关系

- **不破坏 synthetic mode**：`--from-branch` 缺省时，退回到跟 FLY-96 一样的行为？还是新版本直接要求必须有 sandbox？
- 倾向：`--from-branch` 缺省为 `main`（即 sandbox/main），worktree 总是创建。不保留"空 dir"模式。
- 理由：synthetic E2E 并不真的用 projectRoot（QA 直接 POST payload），`git worktree add` 的成本可忽略（几百毫秒），但去掉 legacy 模式能减少条件分支，测试 matrix 更简单。
- 若 Codex 说要保留 legacy，再加 `--mode synthetic`flag。先写成"总 worktree"，review 时再调整。

> **Codex review 必问**：是否需要保留 FLY-96 synthetic 兼容？详见 OQ2。

---

## 4. 关键假设（明摆出来）

A1. **sandbox repo 是 fork**，`gh repo fork` 默认把源 repo 所有 branch 拉过来。首次 clone + 后续 `git fetch origin` 都能拿到 sandbox/main。
A2. **QA 或 worker push 待测分支到 sandbox** 是手工步骤 — spin pipeline 里 push 会指向 `origin`，如果 origin 是 sandbox，Runner push 默认就落在 sandbox，PR 开在 sandbox。这点要在 guide 里写死。
A3. **inbox MCP 写文件到 `~/.flywheel/comm/<project>/inbox/<timestamp>.json`** 是当前约定。项目名是 test-deploy 生成的 `test-slot-N`，所以 inbox 路径是 `~/.flywheel/comm/test-slot-N/inbox/`。inject 脚本参数含 slot，路径自然推导出来。
A4. **Lead daemon 读 inbox 的轮询已经存在**（FLY-109 Lead resume inbox），我只是喂文件进去。
A5. **Linear-shape payload** 只要有 `issueId / title / description / assignee / project` 就够 Lead 走 spin；不需要完整 Linear GraphQL shape。具体 schema 需对齐（OQ3）。
A6. **better-sqlite3** 在 monorepo root `pnpm install` 时会为 root node_modules build 一份 native binding；但在 worktree 里有时缺失，因此 deploy 时跑一次 `pnpm rebuild better-sqlite3` 保底。
A7. **sandbox fork 的 main 会 drift from flywheel main**，但这是 Annie / team-lead 决定 sync 频率的问题，本 issue 只提供工具（sync guide），不做自动化。
A8. **无 Linear 写权限** — inject 不会往 Linear 真建 issue，Lead 看到的只是一个本地 payload。post-test cleanup 也不删 Linear（因为根本没建）。

---

## 5. Open Questions（留给 Codex design review 与 team-lead 拍板）

### OQ1. `--from-branch` 的 branch 怎么到 sandbox？

**候选**：
- **a. QA/worker 手工 push**：测 FLY-108 前先 `git push sandbox feat/v1.23.0-FLY-108-session-status-flip:feat/v1.23.0-FLY-108-session-status-flip`。简单，无黑魔法。
- **b. test-deploy 自动 fetch + push**：deploy 脚本探测本地 flywheel 有这个 branch，自动 push 到 sandbox。减少 QA 手动步骤，但脚本变复杂，需要 flywheel working copy 且无 dirty 状态。
- **c. test-deploy 从 flywheel 直接 clone worktree**，不用 sandbox remote：放弃 A1 的一半，PR open 就挂。

**倾向**：**a**（手工 push）。一行命令，对 QA agent 是明确指令，deploy 脚本保持单一职责。guide 里写清楚。

### OQ2. 是否保留 synthetic mode 兼容？

- **保留**：加 `--mode synthetic|real`（默认 real），synthetic 时 projectRoot 仍 mkdir 空目录。优点：FLY-96 现有 QA skill 不改。缺点：代码分支翻倍。
- **不保留**：所有 slot 都拉 worktree，synthetic QA 仍能 POST payload（不影响），但 deploy 成本上升 ~1s，FLY-96 synthetic skill 可能不知道 projectRoot 存在 git state。

**倾向**：**不保留**，统一成 real 模式。让 Codex 评。

### OQ3. Linear-shape payload 最小 schema

需要扒一下 Bridge 代码或 Lead inbox handler 看它 consume 的最小字段。假设：
```json
{
  "kind": "linear_issue_assigned",
  "issue": {
    "id": "FLY-XXX",
    "identifier": "FLY-XXX",
    "title": "...",
    "description": "...",
    "url": "https://linear.app/geoforge3d/issue/FLY-XXX/...",
    "team": {"key": "FLY"},
    "project": {"id": "764d7ab4-9a3b-43ea-99d9-7e881bb3b376", "name": "Flywheel"},
    "assignee": {"name": "..."},
    "labels": []
  }
}
```

→ Research 阶段会读 Bridge `src/handlers/` 和 Lead inbox handler 核实字段，plan 里会定死。

### OQ4. 4 slot 并行跑 real Runner 的 branch 冲突

同一个待测 PR 如果同时在 slot 1 和 slot 2 deploy，两个 worktree 都 checkout 同一 branch → `git worktree add -B` 冲突。

**缓解**：deploy 时用 `qa-slot-${N}-$(date +%s)` 当 worktree 的 **local** branch 名（`-B` 创建），以 `--from-branch` 的 commit 作为起点。local branch 只是工作区指针，teardown 时 `git branch -D`。不影响 sandbox 的 `feat/...` branch。

### OQ5. `--from-branch` 缺省值

- `main`（sandbox/main）：能跑但永远测不到待测 PR。
- 强制要求：没给就报错。

**倾向**：默认 `main`，让框架在"smoke test 自己"时能一键跑；测 PR 时 QA agent 必须给 `--from-branch`。guide 里写清楚。

### OQ6. teardown 时 branch 删除策略

- worktree 的 local temp branch `qa-slot-N-*` → 强删 `git branch -D`（不怕丢，每次 deploy 都新建）
- sandbox remote 的 `feat/...` branch → **不删**。那是 QA push 上去的，可能对应还在跑的 PR，worker 自己也可能在用。删它是 out-of-scope 破坏。

---

## 6. 成功标准（DoD 细化）

按 Linear DoD 落地：

1. `test-deploy.sh --from-branch main` deploy slot 1，`/tmp/flywheel-test-slot-1/project` 是 `xrliAnnie/flywheel-qa-sandbox` 的真 git worktree，`git status` 能 run。
2. `test-deploy.sh --from-branch feat/xxx` 拉到指定 branch 作为 worktree 起点（前提：QA 已把 branch push 到 sandbox）。
3. `inject-linear-issue.sh 1 FLY-115 "..." "..."` 写入文件到 `~/.flywheel/comm/test-slot-1/inbox/`，test Lead tmux 里能看到消息被消费，spawn Runner tmux。
4. Runner 在 slot 里走 spin（不挂），`gh pr create` 成功，PR 出现在 `xrliAnnie/flywheel-qa-sandbox` 的 PR 列表里。
5. `test-teardown.sh 1` 执行完后：tmux 窗口关闭、worktree remove 成功、`${SLOT_DIR}/teamlead.db` 删除、local temp branch 删除、slot lock 清理、sandbox remote branch 保留（不误删）。
6. FLY-108 Round 2 用新框架重跑，6 个验证点（含原 S4 CIPHER backfill）全 PASS。
7. 文档：sandbox-sync-guide.md、real-runner-e2e-guide.md、qa-framework README 更新齐全。

---

## 7. 风险与缓解

| 风险 | 触发 | 缓解 |
|------|------|------|
| sandbox fork 未创建就 deploy | Annie 忘了手工 fork | deploy 脚本启动时 `gh repo view xrliAnnie/flywheel-qa-sandbox`，不存在直接 fail-fast + 指令提示 |
| sandbox main drift from flywheel main 太远，Runner 跑不通 | 长期不 sync | guide 建议每次发大 PR 前 sync 一次；可加 deploy 时 `git log sandbox/main..flywheel/main` 差异告警（stretch goal） |
| 多 slot 并发 pnpm rebuild 踩脚 | 同一台机 deploy 多 slot | `pnpm rebuild` 在 slot-local node_modules，不跨 slot；若问题出现再加 flock |
| inject 的 Linear-shape payload schema drift | Lead 升级变了 | schema 定义跟 Bridge / Lead handler 对齐；plan 里列出 schema 单元测试 |
| teamlead.db 文件残留污染下次 deploy | teardown 漏删 | test-deploy 开头无条件 `rm -f ${SLOT_DIR}/teamlead.db`；teardown 也删（双重保险） |
| better-sqlite3 native build 在 CI 环境差异 | 跨机器跑 | `pnpm rebuild better-sqlite3` 每次 deploy 都跑；失败直接 exit |

---

## 8. 下一步

→ Research 阶段：
- 逐行读 `scripts/test-deploy.sh` (406 行) + `scripts/test-teardown.sh` (137 行) 标改动点
- 读 Bridge `/events` handler + Lead inbox handler，核实 Linear-shape payload 最小 schema
- 读 `~/.flywheel/comm/` 目录结构 + FLY-109 inbox 实现
- 核实 `pnpm rebuild better-sqlite3` 在 worktree 起不来时是否真的是这个命令
- 核实 Lead daemon launchctl 如何管 slot-scoped DB path env

→ 产出：`doc/engineer/research/new/FLY-115-qa-real-runner-support.md`

然后再进 plan。
