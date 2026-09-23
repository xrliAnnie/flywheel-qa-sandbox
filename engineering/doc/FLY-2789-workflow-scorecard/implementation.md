# FLY-2789 节点成绩记录 — 实施记录
Issue: FLY-2789 (https://linear.app/geoforge3d/issue/FLY-2789/2787-b成绩记录-每张单每个节点记下用的模型组别并记-qa-是否一次过founder-打回次数额度花费耗时按组汇总每张一次过-qa)
日期: 2026-09-23
基于: plan.md

## 落地范围

- 新增四张窄表，分别记录 activation、原生 turn、usage source record 与 source cursor；写入以稳定原生身份和 event UID 幂等，冲突失败可见，不修改 workflow 的权威状态。
- admission、accepted close、proven-dead replacement 与 legacy activation 迁移接入记账。legacy binding 重建时同步重绑成绩表外键，避免保留旧 activation id 造成迁移失败。
- Claude 与 Codex 均从已绑定的原生来源读取精确模型和累计 token；turn-start 先冻结执行归属，terminal/recovery 再补读尾部。runner 只提交认证后的来源边界，不自报模型、组别或 token。
- 复用并严格读取 `model_arm_assigned`、旧 `design_model_arm_assigned` 与 `model_arm_degraded`；不枚举或实现分流比例。设计、实现、QA 三个 axis 按 opaque arm + policyVersion 分开汇总。当前测试覆盖实现 `impl_opus` / `impl_sol56` / `impl_sol6`，QA `qa_sol56` / `qa_sol6` / `qa_opus`；完整来源没有回执时为 `unassigned`。
- 查询直接以 readonly SQLite 连接生成逐单明细和分组汇总：QA 首过、founder 打回、每节点 token/耗时、降级移出率、coverage、跨供应商不可等价提示、分页与 `--qa all|eligible`。没有写入、回填、网络发布或自动迁移入口。
- 同一 project 内先用既有 `workflow_run_issue_alias` 做 run 连通分量，UUID 作为 canonical issue id、`FLY-xxx` 作为可读 id；UUID/identifier 混用的重派仍只算一张单，查询任一 alias 都返回完整 run 集合。
- 四张表加入现有 FLY-2006 retention registry，跟随父工作流保留闭包，不新增独立清理服务。

没有改分流算法、生产配置、QA/ship 判决、部署或重启路径。

## 可手算 fixture 与幂等证据

隔离 SQLite fixture 通过真实 `StateStore` admission/close、Claude/Codex importer、QA claim、founder verdict 与只读 report 查询串起 A-E 五张模拟单。覆盖一次实现返工、一次 founder 打回、一次设计换体、跨 run quota recovery 与一次实现降级。

- A-D 的设计/实现/QA 分组、QA 首过分子分母、founder 打回、总 token 与两种时间口径均逐项断言。
- E 在两个 run 中仍只计一张单：`120` token、`1300ms` node work、`2300ms` elapsed；`model_arm_degraded` 重放后仍只计一次，并从原组移入独立 degraded bucket。
- admission、usage、close、QA、founder 与 degradation 事件重复执行不增加数字；同键改 payload 明确拒绝。
- assignment 与 runtime/observed model 不一致时进入 `assignment_not_honored` 或 invalid bucket，不污染原组；有效降级仍保留 original groups 和实际 activation。
- provider pool 容量全部由外部 JSON 指定；仅当所选单全部终态且 usage 完整时计算 Claude/Codex 各自已消耗百分比，否则为 `null`，不硬编码账号数或账号级别。

## Lead 查询入口

```sh
node packages/teamlead/dist/workflow-scorecard-cli.js report \
  --db /path/teamlead.db --project flywheel \
  --from 2026-09-01T00:00:00Z --to 2026-10-01T00:00:00Z \
  --as-of 2026-09-30T23:59:59Z --format json --dry-run

node packages/teamlead/dist/workflow-scorecard-cli.js issue \
  --db /path/teamlead.db --project flywheel --issue FLY-2789 \
  --format text --limit 100 --offset 0 --dry-run
```

可选 `--capacity-config <json>` 只读加载 provider pool 容量；config 指定单位、每 capacity unit 的周 token 与账号 capacity units。报告不会从当前账号清单猜历史容量。

生产文件 `/Users/xiaorongli/.flywheel/teamlead.db`（探针时约 3.3GB）的实际只读命令于 2026-09-23 执行，退出码 `1`、stdout `unavailable_schema`。这证明未部署 schema 时 CLI 可只读打开活库、诚实拒绝且不迁移；不是生产功能验收。隔离 CLI 测试另以 readonly 文件模式、缺库/缺 schema、参数错误、分页和查询结果证明命令自身没有写路径。

## 消费者发现与取舍

对每个改动的 TypeScript 文件均实际执行三类 `git grep -lF`：完整路径、文件名、父目录。代码依赖命中由 owning-package 聚焦测试及 `vitest related <changed files> --run` 保留；以下仅为文字路径、库存或部署脚本命中，不执行其外部/主机行为：

- `CodexTmuxAdapter.ts` / `TmuxAdapter.ts`：`child-process-census.json`、kill-path inventory、`codex-guard.test.sh`、`flywheel-cmux-sync.sh` 是文件路径/进程库存检查；适配器行为由两个 adapter test 与 related 覆盖。
- `Blueprint.ts`：kill-path inventory、child-process census、runtime-role retirement 与 deploy 脚本只引用文件路径或部署清单；Blueprint、WorktreeManager、DirectEventSink、run-dispatcher 的代码消费者由 edge/teamlead related 覆盖。
- `StateStore.ts`：retention/residue/QA fleet/rollback/update 脚本命中均为源文件路径或 SQL 审计清单；StateStore 的 import 消费者由 teamlead related 覆盖，FLY-2006 retention sweep 也在该集合通过。
- `plugin.ts`、`run-dispatcher.ts`、`run-infra.ts`：drift/feature-flag registry、child-process census、部署与 QA 脚本只做结构/路径检查；Bridge 路由、dispatcher、infra 的实际 import 消费者由 teamlead related 覆盖。
- `index.ts`：`audit-discord-mailbox-ingest`、`qa-codex-lead-parity`、restart 脚本是对通用 CLI 入口的路径引用；本变更的唯一新 subcommand 由 `workflow-usage-source.test.ts` 直接覆盖。
- 新 `workflow-scorecard*.ts` / `workflow-usage-source.ts` 在 tracked tree 尚无旧文件名命中；它们的显式新测试及 Bridge E2E 全部保留。父目录命中是整个 package 的通用路径引用，不是这些新文件的消费者，已由 package build/typecheck 与 related 做边界覆盖。

文档命中（`doc/**`、`engineering/doc/**`、`product/doc/**`）全部排除：它们是历史路径叙述，不是可执行消费者。没有因 grep 命中而运行生产脚本、部署脚本或真实 QA。

## 本地验证

当前完成的本地证据：

- `pnpm lint`：exit 0；25 条既有 warning。
- `pnpm --filter "flywheel-teamlead..." --filter "flywheel-claude-runner..." --filter "flywheel-edge-worker..." --filter "flywheel-comm..." build`：13 个受影响 workspace project 通过。
- `pnpm --filter "...flywheel-core" typecheck`：9 个 dependents 通过。
- TeamLead 8 个直接测试文件：74 passed / 1 skipped；runner 5 个直接测试文件：315 passed；flywheel-comm 新命令：1 passed。
- grep 保留的 runner 结构消费者：kill-path inventory + Codex sync contract 7/7；`codex-guard.test.sh` 46/46。
- legacy binding 迁移回归：1 passed / 66 skipped；证明旧 activation id 可安全重绑到新不可变 activation。
- `vitest related`：TeamLead 567 files、7893 passed / 4 skipped；core 23 passed / 2 skipped；edge-worker 345 passed；claude-runner 434 passed / 2 skipped；flywheel-comm 1 passed。
- 生产只读探针：exit 1、stdout `unavailable_schema`，与未部署 schema 的预期失败形状一致，且没有迁移或写入。
- `git diff --check`：exit 0。

这些是聚焦/受影响本地证据，不是全量测试或 exact-head CI。按 implement 协议没有请求 full CI；冻结 HEAD 的 exact-head CI 由 QA 节点负责。

## 已知边界与 PR Follow-ups

- **既有 global StopFailure 未触发**：Claude 2.1.280 隔离真实CLI baseline和候选均复现；当前变更没有造成新的丢失。失败轮次额度可能漏采；若 terminal/recovery 补读不能证明完整，则该轮/节点/单用量标 missing，整组成本按coverage规则null，不能把已收到部分token或0伪称总量。本单不修该hook，正常成功轮次与其他有完整证据的失败轮次仍需逐条可追溯。该问题不另建单。
- provider token 是 `provider_total_tokens_v1` 计数，不是账单金额；跨供应商显示不可等价警告，不据此排序赢家。
- production 当前尚无新 schema，故生产探针只能证明只读失败形状；部署、生产记录生成和真实数据报表由后续正常发布/QA 证明。

## 代码评审 R1 修正

精确 HEAD `b68ac0384` 的代码评审指出两项阻塞 importer 边界，均按失败用例→最小修复完成：

- Codex `event_msg/token_count` 的 `payload.info=null` 只携带 rate limit、没有 token；现在跳过该原生记录，cursor 继续前进，后续有效累计 usage 仍入账。缺字段但声称携带 counter 的其他形状仍返回 `unsupported_counter`。
- Claude 中断/API error 产生的 `requestId=null`、`model=<synthetic>` 且四类 token 均为零的 assistant 行现在跳过；后续真实 request 仍入账。任何非零或不完整的 assistant usage 继续 fail closed。

两种真实形状加入同一个端到端 importer fixture，分别放在后续有效 usage 之前；测试同时断言 importer 完成、有效 usage 只计一次及原 malformed counter 阴性不变。

修正后的本地证据：scorecard focused 4 文件 23/23；`pnpm lint` exit 0（25 条既有 warning）；TeamLead + 12 个依赖项目 build 通过；TeamLead `vitest related` 为 564/565 文件通过、7883 passed / 4 skipped / 1 failed，唯一失败是无关 `chat-thread-routes` 在大集合中收到纯文本 404，随后精确文件独立重跑 68/68 通过。该 related 运行不记作全绿，也不是 exact-head CI。

## 代码评审 R2 修正

精确 HEAD `6057ae8e1` 的复审验证了 Codex `info=null` 修正，同时指出两个剩余阻塞边界；均按真实形状补失败用例后作最小修复：

- Claude synthetic assistant 的生产形状会完全省略 `requestId`，而不只是写成 `null`。跳过条件现在同时接受缺省与 `null`，但仍要求 `model=<synthetic>` 且四类 token 全为零；测试 fixture 改为真实的缺省键形状。
- Codex `total_token_usage` 只在单个 turn 内累计，跨 turn 会从较小值重新开始。delta 基线现在按 `native_turn_id` 隔离；同一 turn 内的 counter 倒退仍返回 `usage_counter_regressed`，而两个 turn 的合法重置分别计入 `60` 与 `35` token。

R2 修正后的当前本地证据：三个直接测试文件 22/22；scorecard 单文件 13/13；`pnpm lint` exit 0（25 条既有 warning）；TeamLead + 12 个依赖项目 build 通过；两份改动 TypeScript 的 Biome check 与 `git diff --check` 通过；TeamLead `vitest related` 565/565 文件全绿，7884 passed / 4 skipped。以上仍是本地受影响证据，不是 exact-head CI。

## 代码评审 R3 修正

精确 HEAD `f13a1e7ae` 的复审验证了 Claude production synthetic 修正，同时指出 Codex rollout 存在两种真实累计形状：部分 session 跨 turn 延续累计值，部分 session 跨 turn 重置。R2 按 turn 隔离 baseline 会把前一种形状的累计总数重复计入。

修正后 Codex baseline 恢复为 session + source generation 级：跨 turn 且计数继续上升时取前后差值；跨 turn 且任一计数下降时判定为新 turn 重置并取当前原值；同一 turn 内下降仍返回 `usage_counter_regressed`。新增 fixture 同时保留跨 turn reset 的 `60 + 35` 断言，并加入跨 turn continue 的 `60 + 35` 断言；后者在修正前实际得到 `60 + 95`，证明回归用例先红后绿。

R3 修正后的本地证据：scorecard 单文件 13/13；三个直接测试文件 22/22；`pnpm lint` exit 0（25 条既有 warning）；TeamLead + 12 个依赖项目 build 通过；两份改动 TypeScript 的 Biome check 与 `git diff --check` 通过；TeamLead `vitest related` 565/565 文件全绿，7884 passed / 4 skipped。以上仍是本地受影响证据，不是 exact-head CI。

## 代码评审 R4 修正

精确 HEAD `bb873aba4` 的复审验证了 R3 的 Codex counter normalization，同时指出 Codex 会在同一原生 turn 中重复发出 `turn_context`。真实 rollout
`rollout-2026-09-03T23-03-12-01a06b03-9672-7a90-a263-116092618f3c.jsonl`
的 turn `01a06b15-344b-7671-834e-886e42c7b84a` 分别在
`2026-09-04T06:22:28.522Z` 和 `2026-09-04T06:24:59.255Z` 出现两次；后一次有新的 source offset 和时间，但仍是同一 execution、activation 与 source generation。旧逻辑把这些非身份字段也当成 immutable，返回 `turn_replay_conflict`，继而让整个 session import 回滚。

修正只缩窄已有 turn 的幂等比较：稳定键已固定 vendor/session/turn，额外只核对 execution、activation 和 source generation。相同身份的 context refresh 返回 deduped，并保留首次开始时间与 offset；任何真实归属或 source generation 不一致仍返回 `turn_replay_conflict`。回归 fixture 在同一 turn 的 usage 中间重放 context，修正前 importer 明确失败、修正后完成且用量不重复；另一个直接断言证明 source generation 冲突仍 fail closed。

R4 修正后的当前本地证据：scorecard 单文件 13/13；三个直接测试文件 22/22；`pnpm lint` exit 0（25 条既有 warning）；TeamLead + 12 个依赖项目 build 通过；两份改动 TypeScript 的 Biome check 与 `git diff --check` 通过；TeamLead `vitest related` 565/565 文件全绿，7884 passed / 4 skipped。以上仍是本地受影响证据，不是 exact-head CI。
