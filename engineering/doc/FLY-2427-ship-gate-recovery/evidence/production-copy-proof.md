# FLY-2427 Ship gate 死卡收敛 — 生产副本验收证据
Issue: FLY-2427 (https://linear.app/geoforge3d/issue/FLY-2427/批准通路-lead-对-approve-to-ship-gate-的非批准回复被接受并消耗掉这道门却不铸-source-event)
日期: 2026-09-07
基于: plan.md

## 边界与命令

生产库只以 SQLite readonly 模式打开；所有 mutation 都发生在新建的临时副本
`/private/tmp/fly2427-prod-copy3.2e0EGK/`。Discord `postCard` 使用本地 fake，
没有发送、编辑或删除真实 Discord 消息；PR origin inspection 使用生产同源的
真实 `gh pr view` 只读 probe。

```bash
sqlite3 -readonly /Users/xiaorongli/.flywheel/teamlead.db \
  ".backup '/private/tmp/fly2427-prod-copy3.2e0EGK/teamlead.db'"
sqlite3 -readonly /Users/xiaorongli/.flywheel/comm/flywheel/comm.db \
  ".backup '/private/tmp/fly2427-prod-copy3.2e0EGK/comm.db'"
pnpm exec tsx \
  engineering/doc/FLY-2427-ship-gate-recovery/evidence/run-production-copy-proof.ts \
  /private/tmp/fly2427-prod-copy3.2e0EGK/teamlead.db \
  /private/tmp/fly2427-prod-copy3.2e0EGK/comm.db
```

副本大小：`teamlead.db=834M`，`comm.db=884M`。验收执行时间约
`2026-09-07T19:32:40Z`。

## 首轮结果

`candidateIssues` 当场列出 7 个 active/current/awaiting holder：
`FLY-2394, FLY-2397, FLY-2383, FLY-2379, FLY-2381, FLY-2403,
FLY-2408`。

| issue | CommDB 现场形状 | 结果 | current holder / node |
|---|---|---|---|
| FLY-2394 | terminal_disposed + superseded + resolved；无 response/source event | recovered | 新 question `210379d8…`，attempt 2，awaiting_review；node attempt 2=review |
| FLY-2381 | terminal_disposed + superseded + resolved；无 response/source event | recovered | 新 question `e107ef14…`，attempt 2，awaiting_review；node attempt 2=review |
| FLY-2408 | terminal_disposed + response；无 source event | recovered | 新 question `bfcb3673…`，attempt 2，awaiting_review；node attempt 2=review |
| FLY-2379 | protected、无 response、未 resolved/superseded | unchanged | holder 与 gate-node 数组逐字段相同 |
| FLY-2383 | protected、无 response、未 resolved/superseded | unchanged | holder 与 gate-node 数组逐字段相同 |
| FLY-2397 | protected、无 response、未 resolved/superseded | unchanged | holder 与 gate-node 数组逐字段相同 |
| FLY-2403 | protected、无 response、未 resolved/superseded | unchanged | holder 与 gate-node 数组逐字段相同 |

首轮计数原文：

```text
examined=7 recovered=3 skipped=4 failed=0
recoveredIssues=[FLY-2394,FLY-2381,FLY-2408]
firstPosts=3
firstMaterialization=3 x {ok:true,state:awaiting_review}
healthyHolderUnchanged={FLY-2379:true,FLY-2383:true,FLY-2397:true,FLY-2403:true}
healthyGateNodesUnchanged={FLY-2379:true,FLY-2383:true,FLY-2397:true,FLY-2403:true}
runUnchanged=7 x true
sessionUnchanged=7 x true
recoveryCounts={FLY-2394:1,FLY-2381:1,FLY-2408:1}
```

真实 GitHub probe 对三个 PR 在 admission 与正常 materializer preflight 各执行
一次，六次均为 `OPEN`, `isDraft=false`，且 head 精确为：

- FLY-2394 / PR #1103: `750cd9bd8a053f29fd8a19c8fc7afc8a74e776fe`
- FLY-2381 / PR #1109: `297b715c999e2fa563c99138848242de9a8e49bb`
- FLY-2408 / PR #1118: `36fd5aad08feafd4682c06f36d6bc5a092c71889`

旧卡只在 successor materialization `completed` 后进入 void reader；输出恰好是
上述三个旧 question id，没有健康卡。

## 重放结果

时钟推进 31 秒越过 pass throttle 后，用同一副本第二次执行：

```text
examined=7 recovered=0 skipped=7 failed=0 newQuestionIds=[]
secondPosts=[]
```

所以第二轮为 0 新卡、0 holder mutation。

## 禁止写面 checksum

以下 `.sha3sum <table>` 在同一 copy 上于 harness 前后分别执行，所有 digest
逐字节相同；这证明没有补写 approval / claim / authority / consent、没有改
session（含 `pr_head_sha`）、没有终结 run，也没有铸造 CommDB source event。

| table | before = after |
|---|---|
| founder_deferred_approval | `3e7bb0c9fb9deceaea9ab21967db51d3558ace027ab77ec688b4094e` |
| lifecycle_apply_claims | `4ba14d17781d1bb48b02aaa73a4301196c01e77b6fad3e419498de04` |
| lifecycle_launch_claims | `8720042f27e5e115de8ae7d189cc876cdf7cffed5a5aa75bd893b3a3` |
| recovery_claim | `d72fcafba6f0b6df9924c7f63afd1c3ee69d37e249592a3d83a4a162` |
| sessions | `46f9afb6f6f2dd2cc1234c47dace7494cc1a14746936624c3512817d` |
| ship_approval_requests | `47ab8d0b164e28e20d4ff823d97b3de258d436a96470a5266c5783c8` |
| workflow_binding_cutover_claim | `50753858dfc7ac18735fe3525ca5d13e8d76d5ef692fff4736d4237f` |
| workflow_claim_revocation | `f2ac5d008565cd721f6c439dc688ddd03da46938e8c62967bb0cd6cb` |
| workflow_claims | `a2d90e6ca2c2f1a020575314f26d7870ed6979deff3019f08019af81` |
| workflow_run | `22f4976f1afbaa6c432a009ada4c457943963503dacc5a888b7b3074` |
| workflow_wake_send_claim | `f134c8749d9d6a2074e08e891816344e1b27ade55dcbfcd9e3ecf932` |
| CommDB.workflow_source_event | `31b5c83cd840f2b05dd6554c641d2659c50be77f2d8711ca45acb9aa` |
