# Research: QA Test Slot Framework — Real Runner Support — FLY-115

**Issue**: FLY-115
**Date**: 2026-04-18
**Source**: `doc/engineer/exploration/new/FLY-115-qa-real-runner-support.md`

> 方法：审计现有 `scripts/test-deploy.sh` (406 行) + `scripts/test-teardown.sh` (137 行)，读 CommDB / Bridge / Lead 源码核实 payload 路径与 schema，验证 env 依赖。不凭印象。

---

## 1. 现有 `test-deploy.sh` 改动锚点（精确行号）

| 行号 | 现状 | 改动 |
|------|------|------|
| 155-159 | `SLOT_DIR=/tmp/flywheel-test-slot-N`，`mkdir -p ${SLOT_DIR}/project` 空目录 | 删 `mkdir project`，改为 `git worktree add -B qa-slot-${SLOT}-$(date +%s) ${SLOT_DIR}/project <--from-branch>`。需要一个 **persistent sandbox clone** 作为 worktree 的 host repo。 |
| 241-252 | `FLYWHEEL_PROJECTS.projectRepo = "test/test-slot-${SLOT}"` 假 slug | 改为 `"xrliAnnie/flywheel-qa-sandbox"`（所有 slot 共享同一 projectRepo；branch 隔离靠 worktree temp branch 名） |
| 337-344 | Bridge 启动 `TEAMLEAD_DB_PATH=":memory:"`，`npx tsx run-bridge.ts &` 直接继承 stdout/stderr | 1) `TEAMLEAD_DB_PATH="${SLOT_DIR}/teamlead.db"`；2) 改为 `... > "${SLOT_DIR}/bridge.log" 2>&1 &` |
| 全新 | — | deploy 开头加：`gh repo view xrliAnnie/flywheel-qa-sandbox` 预检；失败 fail-fast + 提示 Annie 手工 `gh repo fork` |
| 全新 | — | deploy 开头加：`sandbox-clone` ensure（首次 `git clone --bare git@github.com:xrliAnnie/flywheel-qa-sandbox.git ~/.flywheel/qa-sandbox-clone`；后续 `git -C ~/.flywheel/qa-sandbox-clone fetch --all`） |
| 全新 | — | worktree 前加：`[[ -n "$LINEAR_API_KEY" ]] || { echo "LINEAR_API_KEY required"; exit 1; }`（/api/runs/start 依赖） |
| 338-344 | Bridge 启动无 `pnpm rebuild` | 在第一次 deploy（或 teardown 后重 deploy）时，`pnpm rebuild better-sqlite3` 一次性跑一次（worktree 可能缺 native binding） |

### 1.1 Persistent sandbox clone vs. per-slot clone

**比较**：

- **A. per-slot 完整 clone**：每个 slot 各 `git clone` 一份到 `${SLOT_DIR}/project`。优点：slot 完全独立；缺点：每次 deploy 慢（网络拉），4 个 slot 占 4 倍磁盘。
- **B. 一份 bare clone + git worktree**：`~/.flywheel/qa-sandbox-clone/` 是 bare repo，所有 slot 从它 `git worktree add` 到 `${SLOT_DIR}/project`。优点：fetch 一次共用，worktree 秒级；缺点：teardown 必须 `git worktree remove` 否则 bare repo 状态污染。

→ **B 推荐**。teardown 加 `git -C ~/.flywheel/qa-sandbox-clone worktree remove --force ${SLOT_DIR}/project` + `git -C ~/.flywheel/qa-sandbox-clone branch -D qa-slot-${SLOT}-*`。先 worktree remove 再 `rm -rf SLOT_DIR`，顺序很重要。

> 注：git bare repo 也能持有 worktree（验过）。如果 bare 不行就用 regular clone + `main` checked out。

---

## 2. 现有 `test-teardown.sh` 改动锚点

| 行号 | 现状 | 改动 |
|------|------|------|
| 98-101 | `rm -rf $SLOT_DIR` 直接干掉整个目录 | 之前加：`git -C ${SANDBOX_CLONE} worktree remove --force ${SLOT_DIR}/project 2>/dev/null \|\| true`，再 `rm -rf $SLOT_DIR` |
| 全新 | 无 temp branch 清理 | 加：`git -C ${SANDBOX_CLONE} branch -D qa-slot-${SLOT}-* 2>/dev/null \|\| true`（用 glob 匹配本 slot 所有残留 temp branch） |
| 104-108 | `rm -rf ~/.flywheel/comm/${PROJECT_NAME}` | 保留（CommDB 清理已有） |
| 全新 | 无 teamlead.db 单独清理 | `$SLOT_DIR` 被 rm 时已覆盖 `${SLOT_DIR}/teamlead.db`，无需额外一行。但若 SLOT_DIR 已不存在，不影响 teardown 其他步骤 |
| 全新 | 无 sandbox remote branch 清理 | **刻意不删**。那是 QA/worker push 上去的（可能对应 live PR） |

---

## 3. CommDB 消息注入路径（验证过）

### 3.1 实际路径（不是猜）

- CommDB 文件：`~/.flywheel/comm/<project-name>/comm.db`（对 slot N 就是 `~/.flywheel/comm/test-slot-N/comm.db`，**已在 deploy 时隐式创建**——`~/.flywheel/comm/${PROJECT_NAME}/.inbox-ready-${AGENT_ID}` 的父目录已经在 Lead supervisor 启动时被建出来，见 test-deploy.sh:307）
- Schema（已 `sqlite3 .schema messages` 验过）：
  - `id / from_agent / to_agent / type / content / parent_id / read_at / created_at / expires_at / checkpoint / content_ref / content_type / resolved_at / delivered_at`
  - `type ∈ ('question','response','instruction','progress')`
- CLI：`flywheel-comm send --db <path> --from <a> --to <b> "content"` → 调用 `CommDB.insertInstruction(from, to, content)`（`packages/flywheel-comm/src/commands/send.ts:13`），直接 INSERT，**type 固定是 `instruction`**。
- Env：`FLYWHEEL_COMM_DB` 覆盖 `--db`（`packages/flywheel-comm/src/resolve-db-path.ts:7`）

### 3.2 inject-linear-issue.sh 设计（两条路线）

**路线 I — 发 instruction 让 Lead 自己决定调 /api/runs/start**
```bash
FLYWHEEL_COMM_DB=${HOME}/.flywheel/comm/test-slot-${SLOT}/comm.db \
  flywheel-comm send --from bridge --to ${AGENT_ID} \
    "Linear issue ${ISSUE_ID} assigned to you. Title: ${TITLE}. Description: ${DESC}. URL: ${URL}. Please start the spin workflow."
```
- 优点：模拟真实 Bridge → Lead 链路；验证 Lead spin.md 的 parsing + decision。
- 风险：Lead spin.md 当前是否能从 prose 提取 issueId 并调 `/api/runs/start`？**未验**，需 implement 阶段读 spin.md 确认。如果不行，降级到路线 II。

**路线 II — inject 直接 POST /api/runs/start，绕过 Lead 解析**
```bash
curl -sf -XPOST http://localhost:${SLOT_PORT}/api/runs/start \
  -H 'content-type: application/json' \
  -d "{\"issueId\":\"${ISSUE_ID}\",\"projectName\":\"test-slot-${SLOT}\",\"sessionRole\":\"main\"}"
```
- 优点：一行；确定性高；无 Lead-side parsing 风险。
- 缺点：跳过 Lead 决策步骤。但对 FLY-108 Round 2 的验证目标（Runner 真跑 + session 状态 + ship 流）是够的。

→ **plan 默认路线 II**（工具链短、确定性高）。保留路线 I 作为 optional flag `--via-lead`（Codex review 时再定）。**inject 脚本把 issueId / projectName / role 暴露成参数；发送 Linear prose 只是补充通告给 Lead（用 `flywheel-comm send`），不强制 Lead 调 API。**

### 3.3 Linear-shape JSON schema（简化结论）

Bridge `/api/runs/start` 只需要 `{issueId, projectName, sessionRole?, leadId?}`（runs-route.ts:40）。issue metadata 是 **Bridge 通过 LINEAR_API_KEY 调 Linear API 自取**（PreHydrator，runs-route.ts:31）。→ inject 不用塞完整 Linear shape。issueId 必须是真 Linear issue（FLY-115 / FLY-108 等），否则 PreHydrator 返回 404。

**对 A1+W1 的影响**：W1 不是"写假 Linear payload"，是"用真 Linear issueId + 不走 webhook 直接触发 runs/start"。W1 的价值在于**不依赖 Linear webhook 路由**，不在 payload 造假。

---

## 4. Env 依赖审计

`~/.flywheel/.env`（35 行）**不含** `LINEAR_API_KEY` / `GITHUB_TOKEN` / `GH_TOKEN`。production Bridge 从 shell env 继承（已确认 `LINEAR_API_KEY` 在 `~/.zshrc`）。

**test-deploy 必须验证的 env**：
- `LINEAR_API_KEY` — /api/runs/start 必需；不设直接 fail-fast
- `TEST_BOT_TOKEN_N` — 现有校验（OK）
- `FLYWHEEL_SANDBOX_REMOTE_URL` — 新增；缺省 `git@github.com:xrliAnnie/flywheel-qa-sandbox.git`
- `gh` CLI 已认证（Runner 开 PR 需要）；test-deploy 加 `gh auth status` 预检

→ plan 里明示 deploy 前置条件清单，teardown 不碰 shell env。

---

## 5. better-sqlite3 native build 问题

- `packages/flywheel-comm/package.json` 和 `packages/inbox-mcp/package.json` 都依赖 `better-sqlite3`
- `pnpm rebuild better-sqlite3`（repo 根目录跑）会重编所有依赖 better-sqlite3 的 workspace 包的 native binding
- 现有 test-deploy 不跑 rebuild，若 fresh checkout / Node 版本变动 → Bridge 启动时报 `Error: The module was compiled against a different Node.js version`
- → deploy 在 Bridge 启动前无条件 `pnpm rebuild better-sqlite3 > ${SLOT_DIR}/rebuild.log 2>&1 || true`（失败不阻塞，但记录）。成本一次几秒，可接受

> 不用 flock：4 slot 各自 deploy 时 `pnpm rebuild` 目标是全局 node_modules，**存在竞争但幂等**；最坏情况是多次做了同样的事，不会破坏 state。如 Codex 质疑，加 `flock /tmp/flywheel-qa-rebuild.lock`。

---

## 6. `--from-branch` 行为矩阵

| 场景 | `--from-branch` 值 | 行为 |
|------|-----|------|
| smoke test framework 自己 | 缺省 (`main`) | bare clone fetch → `git worktree add -B qa-slot-${SLOT}-${ts} ${SLOT_DIR}/project main` |
| 测 FLY-108 | `feat/v1.23.0-FLY-108-session-status-flip` | QA 先 `git push sandbox <branch>:<branch>`；deploy 用该 branch 起点 |
| branch 不存在于 sandbox | 任意 | deploy fail：`fatal: invalid reference` → 改提示 QA push |

**open：是否 auto-fetch + auto-push from flywheel?** 不做（OQ1 结论：手工 push 更明确，失败信号更早）。

---

## 7. 4-slot 并发风险再检

| 竞争点 | 处理 |
|--------|------|
| 共享 bare clone worktree | worktree path 按 slot（`${SLOT_DIR}/project`）天然隔离；temp branch 名带 `${SLOT}` + timestamp |
| 共享 `pnpm rebuild` | 幂等，不加锁 |
| Bridge port | 已按 slot 配 19871-19874（test-slots.json） |
| CommDB | 每 slot 独立 `~/.flywheel/comm/test-slot-N/comm.db` |
| tmux window | 已按 slot 命名 |
| GitHub API（gh pr create）| 共享 token，有 GitHub rate-limit 但 4 slot 并发不会踩 |

结论：并发安全，不需额外锁。

---

## 8. FLY-108 Round 2 流程 sanity check（走一遍设想）

1. QA agent 手工：`git push sandbox feat/v1.23.0-FLY-108-session-status-flip:feat/v1.23.0-FLY-108-session-status-flip`
2. `scripts/test-deploy.sh --from-branch feat/v1.23.0-FLY-108-session-status-flip 2` → slot 2 ready
3. `scripts/inject-linear-issue.sh 2 FLY-108 main`（或带 `--via-lead`）
   - 路线 II：POST /api/runs/start → Bridge PreHydrator → Runner spawn，worktree 已是 FLY-108 branch
4. Runner 在 `${SLOT_DIR}/project` 下做改动（真改 spin.md / Bridge 代码？不用 — 这里是**跑 spin 本身**而不是改它），commit，push 到 sandbox，开 PR
5. QA 观察：
   - Chrome Discord：Lead 在 lead-test-1 channel 发 session_started / session_completed / ship 通告
   - `sqlite3 ${SLOT_DIR}/teamlead.db "SELECT ... FROM sessions"` 黑盒查状态（原 S4 CIPHER backfill 能验）
   - sandbox repo PR 列表出现新 PR
6. `scripts/test-teardown.sh 2` → worktree remove + branch delete + SLOT_DIR rm + CommDB rm
7. QA agent 清 sandbox：`git push sandbox :<branch>`（optional）

**潜在 blocker**：Runner spin.md 默认 push 到 `origin`，origin 在 worktree 里指向 sandbox（因为 bare clone 的 origin 是 sandbox）。OK。但如果 spin 逻辑里 hardcode `xrliAnnie/flywheel` 的 slug（而非动态取 remote），就挂。→ implement 阶段读 spin.md 确认；不 OK 就加配置。

---

## 9. 与 explore 中 open questions 的回收

| OQ | 结论 |
|----|------|
| OQ1 `--from-branch` 来源 | 手工 push（文档明示），deploy 不自动化 |
| OQ2 synthetic mode 兼容 | 不保留，统一 real。synthetic QA agent 仍可 POST payload，不受影响 |
| OQ3 Linear payload 最小 schema | 不需要完整 shape。`/api/runs/start` 只要 `issueId / projectName` + env 里 `LINEAR_API_KEY`。PreHydrator 自取 |
| OQ4 4-slot 并发 branch 冲突 | worktree temp branch 名带 `${SLOT}` + timestamp，天然隔离 |
| OQ5 缺省 branch | `main` |
| OQ6 teardown 删 branch | 只删 local temp branch (`qa-slot-${SLOT}-*`)，不动 sandbox remote branch |

---

## 10. 新增文档清单

| 路径 | 内容 |
|------|------|
| `doc/qa/framework/sandbox-sync-guide.md` | Annie 如何 `gh repo fork` 建 sandbox；如何 `git push sandbox main`（sync）；drift 检查命令 |
| `doc/qa/framework/real-runner-e2e-guide.md` | QA agent 操作手册：push 待测 branch、deploy with `--from-branch`、inject、观察、teardown |
| `packages/qa-framework/README.md`（update） | real mode vs synthetic mode 对照表；何时用哪个 |

---

## 11. Residual risks 盘点（plan 必须覆盖）

1. **sandbox repo 未 fork** — deploy fail-fast，错误信息明确指令 Annie 手工 `gh repo fork xrliAnnie/flywheel --fork-name flywheel-qa-sandbox`
2. **LINEAR_API_KEY 未 export** — deploy fail-fast
3. **sandbox main drift from flywheel main** — guide 提示 sync 频率；deploy 时加 warn（stretch，不 MVP）
4. **spin.md 依赖 `xrliAnnie/flywheel` hardcode** — implement 阶段 grep 确认；若有，open 新 FLY- 修复
5. **Runner 跑 gh pr create 需要 gh auth** — deploy `gh auth status` 预检
6. **better-sqlite3 native build 差异** — 无条件 `pnpm rebuild` 前置
7. **bare clone 被人删** — deploy 自动 ensure（首次 clone；后续 fetch）

---

## 12. 进入 plan 阶段

→ `doc/engineer/plan/draft/v1.24.0-FLY-115-qa-real-runner-support.md`

plan 必须覆盖：
- 详细的 test-deploy.sh 改动（含 diff hunks）
- test-teardown.sh 改动（含顺序）
- inject-linear-issue.sh 完整脚本
- sandbox clone ensure 逻辑
- 预检清单（LINEAR_API_KEY / gh auth / sandbox repo / node_modules）
- 文档（2 篇 guide + 1 README update）
- Annie 的 **pre-deploy 手工步骤清单**（⚠️ 高亮）
- `.env` 新增 key
- 测试：smoke deploy + smoke inject + smoke teardown；不要求本 issue 自己过 FLY-108 Round 2（那是 FLY-108 QA 的活）
