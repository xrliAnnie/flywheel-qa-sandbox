# FLY-1707 DAG 断点继续 — 验收报告
Issue: FLY-1707 (https://linear.app/geoforge3d/issue/FLY-1707/epic-重跑与恢复dag-断点继续fly-1699-prd-已定稿-建设)
日期: 2026-08-15
基于: plan.md

## 结论

PASS。A1–A18 的聚焦矩阵共 341 个 Vitest 断言通过，事故重放在生产库的只读 `VACUUM INTO` 副本上由当前分支的真实 `WorkflowEngineDispatcher` 完成：4 个 resume admission 全部启动，首个 running 节点依次为 `qa / implement / implement / implement`，四单 design attempt 均保持 `1 → 1`。

本改动没有 UI 或 Discord 交互面；不需要视觉验证或 529 N-to-N。验证对象是 SQLite/git 跨存储合同、HTTP admission、dispatcher 和 runner launch context。

## A1–A18 对照

| 验收 | 证据 | 结果 |
|---|---|---|
| A1–A2 半成品隔离 | `WorktreeManager.resume.test.ts`: staged/worktree 双态、删除/重建、rename/copy/mode/symlink/untracked/clean-filter/submodule；`worktree-quarantine.test.ts` restore smoke | PASS |
| A3 删除 worktree/branch | `rebuilds a missing worktree and branch from the checkpoint anchor` | PASS |
| A4 未 push 且原仓删除 | `workflow-resume-checkpoint.test.ts`: private store create-only；删除 source repo 后仅凭 store 恢复 ref | PASS |
| A5 外部推进 hold | external divergence、remote branch advance、anchor missing 均 typed hold 且原 worktree 不动 | PASS |
| A6 S1/S2/S3 信封 | issue body fresh drift/unavailable、runtime semantics drift、receipt/snapshot/authority 精确核验 | PASS |
| A7 live template 改版 | `runs-route.dag-entry.test.ts`: active run 在选中模板退休后仍从 pinned snapshot 恢复 | PASS |
| A8 probe 中断 | 新增 `fails closed when the anchor probe is interrupted`，异常被压成 `anchor_unreachable` | PASS |
| A9 QA fail | `StateStore.workflow-engine-transition.test.ts`: `qa_fail` 只回到 `implement` 新 attempt；`qa_pass` 才到 Gate | PASS |
| A10 gate state-only | resolver/admission 证明零新 execution、零新 attempt；durable redrive request + exact ack 后出队 | PASS |
| A11 stale writer 五路 | `StateStore.generalized-execution.test.ts`: superseded writer 的所有 execution mutations 被拒；admission late verdict、land effect-time fence 为独立阴性 | PASS |
| A12 并发 CAS/unknown | checkpoint/quarantine create-only race typed hold；ledger unknown row fail-closed；attachment state revision CAS | PASS |
| A13 crash 重放 | marker-after/DB-before、response-loss、checkpoint ref/store 各阶段 exact replay；整批事务故障零 orphan | PASS |
| A14 同 key 异 payload | resume admission 相同 digest 幂等；不同 digest=`admission_conflict`；response 写入 append-only | PASS |
| A15 旧 schema/NULL/unknown | schema-v1 engine run 不泄漏到 legacy；缺 attachment、unknown carrier、NULL/invalid stamp 均 typed refuse | PASS |
| A16 gate/land effect 不复用 | superseded Gate authority、founder proof missing、land head mismatch 均在 external effect 前拒绝 | PASS |
| A17 三态 | compile-time union 固定为 `legacy_passthrough / enforced_attachment_missing / enforced_resume`；route 分别有关闭、缺附件、成功 admission 对照 | PASS |
| A18 现役 menu/retired | `workflow-menu.test.ts` 固定 `tpl_prd`、`tpl_generic_menu` 等当前绑定；`workflow-template.retirement.test.ts` 覆盖旧模板 migration | PASS |

附加 E5 验收也在此前切片通过：C1–C3 force-cancel、D1–D3 close 级联、R1–R2 rework rescue、O1 shadow 隔离和 W mutation-time fence。

## 聚焦测试

```text
teamlead: 12 files, 295 tests passed
edge-worker: 4 files, 46 tests passed
shell replay fixture: PASS
```

关键命令：

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/StateStore.workflow-resume-schema.test.ts \
  src/__tests__/workflow-resume-checkpoint.test.ts \
  src/__tests__/workflow-resume-resolver.test.ts \
  src/__tests__/StateStore.workflow-resume-shadow.test.ts \
  src/__tests__/StateStore.workflow-admission.test.ts \
  src/__tests__/StateStore.workflow-ledger.test.ts \
  src/__tests__/StateStore.workflow-engine-transition.test.ts \
  src/__tests__/workflow-engine-dispatcher.test.ts \
  src/bridge/__tests__/runs-route.dag-entry.test.ts \
  src/bridge/__tests__/land-executor.test.ts \
  src/__tests__/workflow-menu.test.ts \
  src/__tests__/workflow-template.retirement.test.ts

pnpm --filter flywheel-edge-worker exec vitest run \
  src/__tests__/WorktreeManager.resume.test.ts \
  src/__tests__/Blueprint.generalized-workflow.test.ts \
  src/__tests__/Blueprint.fly887-worktree-takeover.test.ts \
  src/__tests__/PreHydrator.test.ts

bash scripts/__tests__/qa-fly-1707-incident-replay.test.sh
```

## 全仓门禁

```text
pnpm lint: PASS
pnpm -r build: PASS (22/23 workspace projects; root has no build script)
pnpm test:packages:run: 仅 2 个 Terminal.app 真 GUI 测试受当前会话限制
core（排除上述真 GUI 文件）: 19 files, 219 tests passed
其余 packages: 无功能失败
```

`packages/core/test/tmux-viewer.macos.test.ts` 的 2 项失败来自当前非 GUI 会话无法连接 Terminal.app（`Connection Invalid` / AppleScript syntax error）；单独复跑结果一致。非 core 全包高并发时另有 4 项 5 秒 timeout（Teamlead 3 项 preflight、1 项 archive scheduler），对应两个文件以单 worker 隔离复跑为 26/26 PASS，因此判定为并发负载 timeout，不是功能回归。没有修改门禁、删测或提高 timeout 来掩盖结果。

代码审查 R1 后新增回归为 Teamlead 150/150、Edge 47/47：residue note 的 UID 绑定 `receiptKey`，collector 与 residue 单项失败不再截断后续 reconcile；quarantine 证据读取/合成统一加 Git 安全配置；旧 fetcher 默认 fail-closed 为 `fallback`；delivery 与 admission 同为 256 KiB；founder feedback 恢复 implement-only 且 4,000 字符上限；resolver 只读取一次事件日志。append-only trigger finding 经核对为误报：T1/T3/T4/T7b 已在同一 trigger loop，并由 schema 测试验证更新/删除均被拒。

## 事故重放

### 隔离

1. 原库只用 `sqlite3 -readonly ~/.flywheel/teamlead.db` 打开，先得 `PRAGMA quick_check=ok`。
2. 用 `VACUUM INTO` 生成 `/private/tmp` 副本；两支 replay 工具都硬拒绝 canonical `~/.flywheel/teamlead.db`。
3. 只读审计脚本只从副本取 `workflow_run_node`、`workflow_node_pr_binding`、`codex_review_record`。
4. dispatcher 脚本只改副本：先隔离其他 active run 和遗留 intent，再重建四份附件；external launcher 仅记录 request 并提交副本里的 launch receipt，不创建真实 runner。

### 凭据重建

| Issue | 历史目标 | materialized head | approved review head | 判定 |
|---|---|---|---|---|
| FLY-1645 | `qa#1` | `d2b41ba4` | `d2b41ba4` | exact |
| FLY-1680 | `implement#2` | `98e0e4b6` | `98e0e4b6` | exact |
| FLY-1614 | `implement#2` | `253b283f` | `69dc8697` | forward ancestor |
| FLY-1686 | `implement#2` | `cba1446b` | `f942a4fa` | forward ancestor |

这证明比对必须是“批准 head 是否为 materialized head 的祖先”，不能做完全相等。人为把 FLY-1614 的 materialized head 改一位后，Git object/ancestry probe 返回拒绝，resolver 给出 `anchor_unreachable`。

### 真 dispatcher 结果

```json
{
  "result": { "started": 4, "held": 0 },
  "launches": [
    { "issueId": "FLY-1645", "nodeId": "qa", "attempt": 2, "startPoint": "d2b41ba4..." },
    { "issueId": "FLY-1680", "nodeId": "implement", "attempt": 3, "startPoint": "98e0e4b6..." },
    { "issueId": "FLY-1614", "nodeId": "implement", "attempt": 3, "startPoint": "253b283f..." },
    { "issueId": "FLY-1686", "nodeId": "implement", "attempt": 3, "startPoint": "cba1446b..." }
  ],
  "designAttempts": ["1→1", "1→1", "1→1", "1→1"],
  "mutationRefused": true
}
```

每个 launch request 都显式包含 `startPoint`、`workflowResume.sourceAttachmentId` 和冻结 body；没有从模板头重建分支。

## Rollout 与回滚

1. 默认保持 `FLYWHEEL_WORKFLOW_RESUME=0`，shadow rider 常开，只写 T5 probe。
2. 观察 `enforced_attachment_missing`、`anchor_unreachable`、`runtime_mismatch` 和 admission failure episode；先处理证据缺口，不允许静默从模板头重跑。
3. 开启 flag 后只接受显式 `resume:true`；普通 `/runs/start` 和旧 idempotency namespace 不变。
4. 回滚只把 flag 置 `0`；已冻结 attachment/admission 保留审计，不删除、不改写为 fresh start。

## 诚实边界

**8-11 历史 run 依赖凭据重建才能重放；4.1 小时是可避免墙钟上限，不代表当时机制已经运行。** 本次重放证明的是当前判据用当时落库的 PR binding/review 证据可以做出正确决定。墙钟不是 token，且重跑中有少量真实新增工作。
