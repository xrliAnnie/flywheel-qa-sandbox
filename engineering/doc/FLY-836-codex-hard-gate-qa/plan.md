# FLY-836 Codex 硬门真机验证 — 实施计划

Issue: FLY-836 (https://linear.app/geoforge3d/issue/FLY-836/qa-fly-827-codex-code-review-硬门真机验证529-room无-codex-pr-被拦-过-codex-pr)
日期: 2026-07-03
基于: research.md
Status: brainstorm gate 已获 Tadashi 批准（"理解对、计划稳、批准开跑"），进入 design review

## 0. 目标

用 PR #433（分支 `flywheel-FLY-827`, head `4ed4762657174602258e04a4b5692dc28cf7b32b`）的真实二进制，在 529 QA Room 隔离测试 Bridge 上证明 4 个硬门行为 + head 变 + restart reconcile，产出 PASS/FAIL 结论 + 一份关于共享 `.env` kill-switch 风险的 finding，交给 Tadashi 做 founder-gated ship 决策。

## 1. 步骤

### Step 1 — 部署隔离 slot

```bash
git push git@github.com:xrliAnnie/flywheel-qa-sandbox.git flywheel-FLY-827:flywheel-FLY-827
export BRIDGE_DEPT_SCOPE_REJECT=off   # sandbox issue 没有 dept label，绕开 FLY-127 拒绝
export TEST_REPLY_BY_ISSUE=1
export TEST_API_TOKEN=fly-836-qa-$(date +%s)   # 固定值，注入时复用
scripts/test-deploy.sh --from-branch flywheel-FLY-827 --alerts 2   # 或 3，看哪个先到手
```

记录输出 JSON 里的 `dbPath` / `bridgeLog` / `branchSha`（= PR #433 的真实 head）。

### Step 2 — inject 一个真 Linear issue，拿真 Runner + 真 PR

- 用标准 sandbox 目标（`reference_qa_529_runner_injection_gotchas` 记忆里的 FLY-202 / FLY-124 / FLY-136 之一，PreHydrator 可见、不会误触生产 triage）。
- `TEST_REPLY_BY_ISSUE=1` 下 `inject-linear-issue.sh` 不带 auth 会 401 —— 自己 POST：
  ```bash
  curl -s -X POST http://localhost:<slotPort>/api/runs/start \
    -H "Authorization: Bearer ${TEST_API_TOKEN}" -H "Content-Type: application/json" \
    -d '{"issueId":"FLY-202","projectName":"test-slot-<N>","sessionRole":"main"}'
  ```
- 等 Runner 真的 `git push` + `gh pr create` 到 sandbox，拿到一个真实 PR number + head SHA（记为 `HEAD_A`）。这一步不需要 Runner 真的走完 Codex review —— 只需要它到达"有 PR、有 head"这个状态即可（后续场景全靠我直接驱动 CLI 精确控制,不依赖 Runner 自己是否记得跑 codex）。

### Step 2.5 — 找到 `execId`

```bash
sqlite3 <dbPath> "SELECT execution_id, status, pr_head_sha FROM sessions ORDER BY created_at DESC LIMIT 3;"
```

### Step 3 — 场景 (a)：无 Codex 的 PR 被拦

1. 确认没有 `code-review.json`（不跑 `/codex-code-review`）。
2. 在 Runner worktree 里：`flywheel-comm complete --route needs_review --pr <N>`（如果 Runner 还没自己 complete）。
3. 观察：
   - `sqlite3 <dbPath> "SELECT status FROM auto_qa_record WHERE parent_execution_id='<execId>';"` → 应该**没有行**（QA 未 claim/spawn）。
   - `sessions.status` = `awaiting_review`。
   - `bridge.log` grep `codex-gate` / `codex_gate_blocked` → 应该看到 codex-hold 分支触发 + 重发指令日志。
   - Discord `#test-flywheel-alerts` 频道（Claude-in-Chrome 截图）→ 应该收到 `codex_gate_blocked` 告警。
   - CommDB：`flywheel-comm inbox --exec-id <execId>`（或直接查 CommDB）→ 应该看到重发的 `/codex-code-review` 指令。
   - `flywheel-comm verify-approval --exec-id <execId> --pr-head <HEAD_A>` → 期望 `{"approved":false,"reason":"codex_review_not_approved",...}`。

### Step 4 — 场景 (b)：有 Codex approved 不误拦

1. 在 Runner worktree 手写 `.flywheel/runs/<execId>/codex/code-review.json`：
   ```json
   {"executionId":"<execId>","reviewType":"code","status":"APPROVED",
    "reviewedTarget":"<PR URL>","reviewedHeadSha":"<HEAD_A>",
    "timestamp":"<now ISO>","rounds":1,"codexThreadId":"fly836-qa"}
   ```
   （`reviewedHeadSha` 必须等于 worktree 当前 `git rev-parse HEAD`，否则 `await-codex-gate` 会 fatal。）
2. 跑 `flywheel-comm await-codex-gate code --exec-id <execId>`（验证它真的上报 `codex_review_result` 给 Bridge，不只是本地校验过）。
3. 观察：
   - `sqlite3 <dbPath> "SELECT status,target_pr_head_sha FROM codex_review_record WHERE execution_id='<execId>';"` → `approved` + `HEAD_A`。
   - `auto_qa_record` 出现 claim（QA 正常 spawn，如果场景 (a) 已经先卡过、这里应该是"重驱动首次 spawn"路径 —— `bridge.log` 应该能看到 `codexReleased` 相关日志）。
   - `flywheel-comm verify-approval --exec-id <execId> --pr-head <HEAD_A>` → codex 分支不再拦（如果 founder approval 也没做，reason 会是别的，只要不是 `codex_review_not_approved` 就说明 codex 分支已经放行）。

### Step 5 — 场景 (c)：kill-switch 放行

**5.1 纯逻辑验证（不碰共享文件，优先做）**：

```bash
mkdir -p /tmp/fly836-qa-env
echo "FLYWHEEL_CODEX_HARD_GATE=0" > /tmp/fly836-qa-env/.env
node packages/flywheel-comm/dist/index.js verify-approval --exec-id <execId-无codex的那个> \
  --pr-head <HEAD> --codex-dotenv-path /tmp/fly836-qa-env/.env
# 期望 approved 分支不再因为 codex 被拦（即便该 exec 没有 approved record）
rm -f /tmp/fly836-qa-env/.env   # 缺 key = 默认 ON，验证「删行 = 恢复」
node packages/flywheel-comm/dist/index.js verify-approval --exec-id <execId> \
  --pr-head <HEAD> --codex-dotenv-path /tmp/fly836-qa-env/.env
# 期望重新变回 codex_review_not_approved（re-arm 有效，不被旧继承值 bypass）
```

**5.2 Bridge 端到端直接生效（谨慎，碰共享文件）**：

```bash
cp ~/.flywheel/.env ~/.flywheel/.env.fly836-qa-backup   # 备份
node packages/flywheel-comm/dist/index.js feature-flags apply \
  --name codex_hard_gate_killswitch --to off --bridge-url http://localhost:<slotPort>
# 立刻(不重启 slot Bridge)重跑场景(a)的 awaiting_review session 检查：
#   - 手动触发一次 onMainAwaitingReview 的路径(如 complete 一个新 session 或用现有 API 重新评估)
#   - verify-approval 不再要求 codex
node packages/flywheel-comm/dist/index.js feature-flags apply \
  --name codex_hard_gate_killswitch --to on --bridge-url http://localhost:<slotPort>
diff ~/.flywheel/.env ~/.flywheel/.env.fly836-qa-backup   # 必须为空
rm -f ~/.flywheel/.env.fly836-qa-backup
```

若 diff 不为空，手动删除 `FLYWHEEL_CODEX_HARD_GATE` 那一行直到文件与备份一致，再删备份。

### Step 6 — 场景 (d)：head 变

1. 在场景 (b) approved 的基础上，往 sandbox PR 分支 push 一个新的空提交（`git commit --allow-empty` + push），产生新 head `HEAD_B`。
2. `flywheel-comm verify-approval --exec-id <execId> --pr-head <HEAD_B>` → 期望 `codex_review_not_approved`（旧 `HEAD_A` 的 approved 记录对不上）。
3. 用旧的 `code-review.json`（`reviewedHeadSha=HEAD_A`）但 worktree 已经在 `HEAD_B`，跑 `await-codex-gate code` → 期望 **fatal exit 1**（不误上报）。

### Step 7（附加）— restart reconcile

1. 回到场景 (a) 的挂起状态（一个 awaiting_review 但 codex 未过的 session）。
2. 重启 slot Bridge（`kill <bridgePid>` 然后按 test-deploy.sh Step 3 的同款 `env ... npx tsx run-bridge.ts` 命令重新起，复用同一个 `dbPath`）。
3. 观察 `bridge.log` 里 `reconcileCodexHolds` 补发的 thread/alert/重发指令（应该幂等，不重复刷屏——多起一次不应该让 alert 计数翻倍）。

### Step 8 — 清理

```bash
scripts/test-teardown.sh <N>
git push git@github.com:xrliAnnie/flywheel-qa-sandbox.git :flywheel-FLY-827   # 可选,清理 sandbox 分支
gh pr close <sandbox PR number> -R xrliAnnie/flywheel-qa-sandbox              # 可选
```
确认 `~/.flywheel/.env` 与测试前一致（Step 5.2 已处理，这里再兜底确认一次）。

### Step 9 — 写报告 + 报 Lead

- 报告写在 `doc/qa/FLY-836-codex-hard-gate-report.md`（跟随现有 `doc/qa/*` 惯例），含每个场景的 PASS/FAIL + 证据截图/DB 查询结果 + 共享 `.env` 风险 finding。
- `git mv` 本文件夹三份文档保持原样（doc-flow 惯例：full tier 的过程文档随 PR 一起 merge，不需要额外 archive 动作，因为这本身就是最终态）。
- commit + push + `gh pr create`（docs-only PR，走正常 Codex code review + 我自己的 approve/ship 流程，因为这条 PR 本身低风险）。
- 用 `flywheel-comm ask` 把 PASS/FAIL 结论 + 风险 finding 发给 Tadashi，他 relay Annie 做 PR #433 的 ship 决策。

## 2. 风险与缓解

- **共享 `~/.flywheel/.env` 被测试污染**：见 research.md §2，Step 5 严格执行备份/恢复 + diff 确认。
- **sandbox PreHydrator 目标选错误触生产 triage**：只用标准伪目标（FLY-202/124/136），不用真实业务 issue。
- **529 slot 冲突**：部署前查 `/tmp/flywheel-test-slot-*.lock` 存活状态，避开 slot 1（roundtable 占用）。
- **529 Room 隔离测试本身不能影响正在跑的其它 QA（FLY-535/FLY-368 等）**：只用空闲 slot，不碰 slot 1。

## 3. 出范围

同 research.md §5：不重新评估 FLY-827 设计合理性、不测 Codex review 内容质量、不碰生产 Bridge。
