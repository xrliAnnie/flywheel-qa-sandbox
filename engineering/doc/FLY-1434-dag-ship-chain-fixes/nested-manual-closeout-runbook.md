# FLY-1434 Nested PR 人工收尾 Runbook — 操作手册

Issue: FLY-1434 (https://linear.app/geoforge3d/issue/FLY-1434/engine族批-dag-ship-链小修-3-统一重启改造-pr-回写绑定-runs-start-假成功-闭-run-rework-入口)
日期: 2026-07-23
基于: plan.md（§10「nested 终态写实」；§3.4 diagnostic DTO）

## 适用场景

DAG run 的 land 激活因 `target_repo_identity !== '__main__'` 被 `holdWorkflowLandNode(reason='nested_land_unsupported')` 置为 held。该 PR 属 nested/外部 repo，本单范围内没有自动 ship verify、land、merge 或 Linear Done；Lead/founder 手工 merge 后，按本手册人工收尾。

本流程不得用于普通 held run、仍有 live execution、存在 finalization/land operation、存在 out-of-set receipt、诊断列表被截断，或目标 PR 尚未全部精确合入的 run。

可用性前提：`GET /api/runs/:runId/diagnostic` 已部署。端点返回 503 `DIAGNOSTIC_SCHEMA_UNAVAILABLE` 时不得用 SQL、旧日志、Discord 文本或本地 checkout HEAD 补猜，必须等部署齐再执行。

## 唯一执行路径

先由 Lead/founder 在目标 repo 手工 merge PR，然后完整运行仓内脚本。脚本顺序固定为 diagnostic 前置门 → 每个 PR 的 exact merged/head 证明 → invariant-bound terminate → diagnostic 复核。任何失败都会在 terminate 前退出，或令服务端事务零 mutation。

```bash
export TEAMLEAD_API_TOKEN='<master token>'
export FLYWHEEL_BRIDGE_URL='http://127.0.0.1:9876'
scripts/nested-manual-closeout.sh '<workflow-run-id>'
```

脚本使用的唯一状态源是：

```text
GET /api/runs/:runId/diagnostic
```

端点要求 loopback 请求和 exact master token。脚本把 token 通过 curl config stdin 传递，避免放入 curl argv。

## 前置门

held 路径和 lost-response recovery 路径都会完整验证：

- `schema_version == 1`。
- run 状态分别为 `held` 或 `terminated`，且 `latest_hold.reason == nested_land_unsupported`。
- `quiescence.quiescent == true`。
- `receipts.attributed_out_of_set == 0`。
- `finalization.state == null` 且 `land_operation.present == false`。
- 所有 `truncated` 标记均为 false。
- declared 模式：manifest sealed、当前 revision 声明数等于 expected count、至少一个 PR，且全部 state 为 `merged`。
- single 模式：只消费唯一的 `single_closeout_target`，且 identity 不是 `__main__`；绝不遍历历史 PR ledger 猜目标。

`closeout_invariant_digest` 绑定 run 状态、hold reason、quiescence、PR authority、ship target、receipt、finalization 与 land operation。服务端在 held→terminated 的同一事务里重读并 exact compare；并发 rework、manifest reopen、新 receipt、finalization、land operation 或 ship-target supersede 会返回 409，run 不变。

## Merge 证明

脚本对当前 declared 集的每一行，或 single target 的唯一一行执行：

```text
gh pr view <pr> --repo <probe_repo_slug> --json state,headRefOid
```

只有 `state=MERGED` 且 `headRefOid` 与 DTO 的 `frozen_head_sha` 逐字节一致才继续，并输出可粘贴到 Linear 的 `PROOF <slug>#<pr> @ <head> MERGED`。

这些是操作员可见证明，不是服务端授权的替代品。single nested terminate 时，Bridge 会独立重做 `gh` probe，并在事务内确认 proof tuple 仍与当前 invariant 的唯一 target 完全一致。declared 模式的服务端 merged 权威来自 exact-head reconciler 写入的当前 revision rows。

## 幂等与断线恢复

`clientRequestId` 采用内容寻址：

```text
nested-closeout-<runId>-<closeout_invariant_digest>
```

因此同一 invariant 的重试稳定幂等。若服务端已提交 terminate 但客户端在收到响应前断线，重跑完整脚本会：

1. 读到 `run.status=terminated`。
2. 重新执行全部 gate-critical snapshot 与 GitHub proof。
3. 仅当 `latest_termination.closeout_kind=nested_manual`、持久化 digest 为规范 64-hex，且 request id 能由 run id + digest 精确重建时进入 recovery。
4. 跳过重复 POST，再读 diagnostic 完成三元复核。

run-only 旧式 request id、null/不同 digest、错误 closeout kind 或旧 binary event 都 fail-closed，不得当作成功。

## 错误处理

403、409、503、断连、非 JSON、`gh` 不可用、PR 未 merge、head mismatch、任一 jq 校验失败都会非零退出。

- 409 `CLOSEOUT_INVARIANT_CHANGED`：preflight 后状态漂移；解决原因后从头重跑。
- 409 `CLOSEOUT_INVARIANT_REQUIRED`：请求未携带诊断 digest；不得手写绕过。
- 409 `NESTED_CLOSEOUT_MERGE_UNPROVEN`：服务端 exact merge proof 不成立。
- 503：依赖或 schema 不可用；不得强杀或直接 UPDATE run。

## 脚本成功后的人工两步

1. Lead 检查脚本输出的全部 PROOF 行与最终 diagnostic，再将 Linear issue 手工标为 Done。
2. 归档对应 thread，并在 issue comment 留下当前 revision 全部 `<slug>#<pr> @ <head>`、run id、diagnostic digest 和 terminate request id。

脚本成功只代表 workflow run 已以可审计证据终止。自动 Linear Done/归档仍然禁用；不得伪造 land operation 或把手工 merge 描述成自动闭环。

## QA drill

必须实际运行脚本覆盖：

- 2-PR declared run：只合 1 个时脚本非零退出，并由访问日志证明从未发出 terminate；两个全齐后完整通过。
- single nested run：伪 head 退出；exact merged/head 对照通过。
- 409/503、curl 断连、非 JSON 响应全部非零退出。
- 并发两个 run 的 mktemp 目录互不干扰。
- 同 digest 重试幂等。
- 服务端提交后客户端断线，重跑走 typed lost-response recovery，仍输出全量 PROOF。
- terminate 后若 diagnostic 出现 manifest drift、late out-of-set receipt 或错误 schema，复核 fail-closed，不输出 Linear Done 提示。

自动 closeout（manual-land acknowledgment / convergence 补 land）属于 follow-up，不得通过弱化本手册的门来实现。
