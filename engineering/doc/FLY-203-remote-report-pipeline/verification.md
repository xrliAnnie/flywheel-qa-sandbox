# FLY-203 远程报告管线 — 实施验证
Issue: FLY-203 (https://linear.app/geoforge3d/issue/FLY-203/remote-report-pipeline-html-报告自动发布托管-discord-截图链接送达)
日期: 2026-08-30
基于: plan.md

## 验证范围

当前 sandbox `origin/main` 已包含 FLY-203 生产实现。本分支没有改动 CLI、Bridge、registry、Vercel 或 Discord 代码；实际功能 delta 仅修复 `doc/reference/remote-report-pipeline.md` 的归档 plan 链接，并补齐后来加入的 nonce-enabled CSP 安全模型说明。

```text
git diff --name-only origin/main...HEAD
  FLY-2182-drill.md
  doc/reference/remote-report-pipeline.md
  engineering/doc/FLY-203-remote-report-pipeline/exploration.md
  engineering/doc/FLY-203-remote-report-pipeline/plan.md
  engineering/doc/FLY-203-remote-report-pipeline/progress.md
  engineering/doc/FLY-203-remote-report-pipeline/research.md
  engineering/doc/FLY-203-remote-report-pipeline/verification.md
  engineering/doc/milestones/FLY-203.md
```

其中 `FLY-2182-drill.md` 是控制器在 replacement drill 中注入并已推送的单行工具标记，不属于 FLY-203 产品实现；本节点没有未经 Lead 明示删除外部提交。其去留问题 `28985b7a-27e9-4c02-850a-64841e1d7c00` 在 implement handoff 时仍未答复，代码评审将其列为非阻塞 advisory。

## RED / GREEN

修改前运行：

```bash
rg -q 'doc/engineer/plan/archive/v1\.32\.0-FLY-203-remote-report-pipeline\.md' doc/reference/remote-report-pipeline.md
rg -q '__CSP_NONCE__|script-src.*nonce|交互报告' doc/reference/remote-report-pipeline.md
```

两条命令均 exit 1。最小文档修复后，归档路径检查、目标文件存在检查、`__CSP_NONCE__`、实现侧 `script-src ... nonce` 和文档侧 `addEventListener` 检查均 exit 0。

## FLY-203 聚焦套件

工作区先执行 `pnpm install --frozen-lockfile` 和 `pnpm -r build`，避免把 fresh worktree 缺少 workspace `dist/` 当产品失败。

| 命令 | 结果 |
|---|---|
| teamlead: registry、Vercel、Discord multipart、reports route、mount | 5 files / 89 tests PASS |
| flywheel-comm: publish-report orchestration | 1 file / 23 tests PASS |

112 个测试覆盖：128-bit token、随机域名、retention、stage/deploy/commit 事务、CSP/noindex、Vercel reverse compatibility、单条 Discord multipart、preview-root attack matrix、双侧 kill switch、fail-closed auth、截图 2x→1x→纯链接降级、ProofShot stop-finally 和单行 JSON envelope。

## 精确全仓 gates

| Gate | 当前结果 |
|---|---|
| `pnpm lint` | exit 0；Biome 检查 1894 files，0 errors，14 个基线 warning |
| `pnpm -r build` | exit 0；22/23 workspace projects build 完成 |
| `pnpm test:packages:run` | exit 1；fail-fast 在 `flywheel-core` 停止，17 files / 206 tests PASS，real Terminal.app `osascript` fixture 2 tests FAIL（managed sandbox 无 macOS UI service） |
| core fallback（排除 real-GUI fixture） | 17 files / 206 tests PASS |
| no-bail package sweep | 13 packages PASS；`core`、`edge-worker`、`teamlead` FAIL |
| new `scripts/__tests__/*.test.sh` | branch delta 为零，无新增 shell test 要运行 |

No-bail 失败明细：

- `core`：同一 real Terminal.app AppleScript 环境失败；本分支不改 core。
- `edge-worker`：90 files / 1124 tests PASS，1 test FAIL；runner 注入的 `FLYWHEEL_STATE_DB_PATH=/tmp/flywheel-test-slot-2/teamlead.db` 按生产优先级覆盖测试局部设置的 `TEAMLEAD_DB_PATH=/tmp/fly191-statedb-test/teamlead.db`。本分支不改 edge-worker。
- `teamlead`：485 files PASS / 11 files FAIL，7033 tests PASS / 25 tests FAIL，另 1 worker timeout。失败含 sandbox 禁止 Terminal/LaunchAgents、shell fixture 在 HOME 缺失时落到根路径、npm cache 权限和既有 merge-reconcile expectation；本分支不改 teamlead。

以上失败不能记为全仓 PASS，也不属于 FLY-203 delta。已向 Lead 提交 gate disposition 问题 `0b790f08-182c-4f30-a603-8a6e3b900adc`；在 Lead 给出明确 waiver 前，本报告不宣称 full package gate 通过。

## Acceptance Criteria 结论

| AC | Implement 证据 |
|---|---|
| AC1–AC3 托管/不可猜/retention | registry + route real-fs tests PASS；原归档 research 记录真实 Vercel spike |
| AC4–AC5 一条消息/截图降级 | Discord multipart route + CLI tests PASS |
| AC6–AC7 开关/缺配置 | CLI、router、plugin mount tests PASS |
| AC8 失败不伤旧报告 | stage/abort/commit failure-injection tests PASS |
| AC9 preview 安全 | traversal、sibling、symlink、FIFO、fake PNG、oversize、missing attack matrix PASS |
| AC10 byte compatibility | Vercel reverse-compat sentinel PASS；publish-html 未改 |
| AC11 真 Discord 手机验收 | 未执行，属于独立 QA 节点硬门；implement mock/focused tests 不可替代此项 |

## 渲染与视觉边界

本分支没有新增或修改 HTML rendered surface，因此没有新的 markup 截图可验。现有 CLI 测试锁定对已发布 URL 的全页截图、viewport width、2x/1x 降级和 PNG handoff；真托管页面与 Discord 手机预览必须由 QA 使用受控 Vercel/Discord 凭据验证。

## 已知状态差异

`CLAUDE.md` 的里程碑表仍写 FLY-203 Held PR (#221)，但此 sandbox 的 `origin/main` 已包含 `publish-report`、reports route 和测试。动态任务明确禁止修改 `CLAUDE.md`，因此本分支只在 milestone/handoff 中显式记录这项 sandbox 状态差异。
