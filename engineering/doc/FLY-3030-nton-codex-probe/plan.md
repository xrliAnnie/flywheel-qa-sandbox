# FLY-3030 N-to-N 活体探针 — 实施计划

Issue: FLY-3030 (https://linear.app/geoforge3d/issue/FLY-3030/529-合成单勿派-fly-2919-真房-n-to-n-codex-体)
日期: 2026-09-28
基于: research.md（+ exploration.md 方案 A）

## 1. 目标与非目标

**目标**（= issue 的两步，逐字）：

1. 前台 `sleep 780`，自然结束后再进入下一步。
2. 在沙箱仓 README.md 末尾追加一行 `FLY-2919 N-to-N claude-body probe`，commit、push、建 PR、按正常流程交卷。

**非目标**：
- 不改任何 packages 代码、不写测试代码（无可测逻辑，见 §5 豁免）。
- 不做验收：死体终结/换体/续干/回 thread 由 FLY-2919 QA 按 driver receipt 判定。
- 不 merge、不请求 ship 批准、不 force push、不建新分支。

## 2. 前提与身份

| 项 | 值 |
|----|----|
| 工作目录 | 本 worktree（origin = `xrliAnnie/flywheel-qa-sandbox`） |
| 分支 | `project-slot-1-FLY-3030`（已存在，不新建） |
| 目标文件 | `README.md`（仓根） |
| 目标行（逐字） | `FLY-2919 N-to-N claude-body probe` |
| 执行者 | implement 节点（拿到 TURN=yours 后才动仓） |

## 3. 实施步骤

### 步骤 0 — TURN 与 inbox（≈1 分钟）

```bash
node "$FLYWHEEL_COMM_CLI" turn --exec-id "$FLYWHEEL_EXEC_ID"      # 必须 yours
node "$FLYWHEEL_COMM_CLI" inbox --exec-id "$FLYWHEEL_EXEC_ID"     # 有 [lead-instruction] 先处理
git branch --show-current                                        # 期望 project-slot-1-FLY-3030
```

### 步骤 1 — 前台 sleep 780（13 分钟，硬约束）

**单独一次** Bash 调用，参数 `timeout: 900000`，`run_in_background: false`：

```bash
START=$(date +%s); sleep 780; END=$(date +%s); echo "slept=$((END-START))s"
```

- 只允许 sleep 结束后打印这一行自证（`slept≥780`）；sleep 期间零输出、零其他工具调用。
- 禁止：分段 sleep、`&`、`nohup`、`run_in_background`、缩短秒数、跳过。
- 若调用被工具层超时打断（`slept<780` 或无输出）：**重跑整段 780 秒**并在 PR 里如实写明；不要拿剩余时间凑。

### 步骤 2 — 幂等追加 README 行

```bash
LINE='FLY-2919 N-to-N claude-body probe'
grep -qxF "$LINE" README.md || printf '%s\n' "$LINE" >> README.md
tail -1 README.md          # 期望逐字 = $LINE
git diff --stat            # 期望只有 README.md，+1 行
```

### 步骤 3 — commit / push / PR

```bash
git add README.md          # 只 add 这一个文件
git commit -m "chore(FLY-3030): append FLY-2919 N-to-N claude-body probe line to README"
git push -u origin HEAD
gh pr create --title "chore: FLY-2919 N-to-N claude-body probe line (FLY-3030)" --body "<摘要 + 测试计划 + ## Linear Issue FLY-3030>"
```

### 步骤 4 — 交卷

- 用 implement 节点注入提示词指定的阶段完成路由（正常三阶段路径）；**不用** `pr_handoff`。
- 交卷前更新 progress.md 游标；交卷后 DONE 报告走 `flywheel-comm ask --report`。

## 4. 验证（本机具体命令；无 CI 套件可跑）

| 检查 | 命令 | 期望 |
|------|------|------|
| sleep 时长 | 步骤 1 自证行 | `slept=780s`（±1） |
| 目标行 | `tail -1 README.md` | `FLY-2919 N-to-N claude-body probe` |
| 幂等 | 再跑一次步骤 2 | README 不再变化 |
| 变更面 | `git diff --stat origin/main..HEAD -- . ':!engineering/doc'` | 仅 README.md |
| PR | `gh pr view --json title,body` | 含 `FLY-3030` |

## 5. 测试豁免声明

改动为 markdown 单行追加，不存在可单测/集成测的逻辑；`pnpm lint`（biome）不覆盖 markdown。
DoD 第 2 条以 §4 的逐字校验替代，PR 测试计划中注明「waiver: doc-only change」。

## 6. 负向守卫（negative guards）

- 不得在 sleep 期间产生任何 pane 输出（污染 660 秒安静窗口）。
- 不得 `git add -A`、不得提交 progress.md 之外的非 README 文件到本 PR（设计文档已由 design 节点提交）。
- 不得建新分支、不得 force push、不得 merge、不得请求 ship 批准。
- 不得把 `FLYWHEEL_*` token 写进 commit / PR 正文。

## 7. 回滚边界

- README 单行：`git revert <sha>` 即可；无数据、无配置、无迁移。
- PR 未 merge 前关闭即回滚，生产零影响。

## 8. 交付物清单

| 节点 | 产物 |
|------|------|
| eng_design（本节点） | exploration.md / research.md / plan.md / design.html（+ mmd/svg）/ progress.md，已 commit+push；HTML 已 publish 并报 Lead |
| implement | README +1 行 commit、PR、阶段完成交卷 |
| qa（若有） | 按注入提示词；FLY-2919 验收在 driver 侧 |
