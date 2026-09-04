# FLY-2324 投递告警风暴收敛 — 实施证据
Issue: FLY-2324 (https://linear.app/geoforge3d/issue/FLY-2324/引擎告警-部署后-bridge-启动-baseline-全量铸-796-条陈年投递契约-episode35min-内-362)
日期: 2026-09-04
基于: plan.md

## 实现结果

- `DeliveryProjector` 与 `DeliveryContractWatch` 共用按 pass 缓存的 legacy reachability guard。
- attempt/episode 已绑定的 active/held run 优先保护；terminal run 在没有 active/held successor 时直接收口。
  未绑定时，current active/held run 也优先保护。
- 没有 run 归属的投递在 recipient 进入 wake-terminal 状态，或 source age 达到
  `LEGACY_UNREACHABLE_AFTER_MS`（7 天）时不铸新 attempt，并把已有 attempt/episode 原子写成
  `legacy_unreachable`。经授权的 Linear 终态跃迁也不得绕过 7 天边界；缺失 recipient 与仅有首次终态观测
  都 fail-open 到 7 天边界；
  `approved`/`rejected`/`deferred`/`shelved` 等非 wake-terminal 状态不会触发关闭。
- 收口不修改 `alerted_at` / `severe_alerted_at`，同一存量重放为零新 episode、零新 alert。
- `workflow_run_issue_alias` 持久化 run 的 UUID/identifier/root alias；一次性 migration marker 保证历史
  backfill 仅执行一遍。alias 查询只接入 FLY-2324 reachability guard，不改变 patrol、resume 或 dispatch
  的共享 issue identity 语义；三条 workflow run 创建路径都在创建事务内捕获 alias。若已按
  `legacy_unreachable` 收口的 source 后来被 active/held run 重新认领，会以新 generation 重新铸造；原
  recipient 即使已终结也会恢复 FLY-2278 的 undeliverable/reroute 路径。新 generation 的 `minted_at` 使用
  恢复时刻，旧 sent/received/consumed clocks 也以恢复时刻为下界；未 re-arm 的 settled generation 不再
  吸收 source clocks，旧 generation 通过 `superseded_by_attempt_id` 留下完整历史。
- watch 可收口没有 version selector 的 legacy rework/carrier attempt；若收口竞态未成功，会继续正常观测而
  不是静默跳过。
- divergence candidate SQL 只枚举 active/held run；event UID 加 lifecycle revision。若数据库中已有真实
  冲突 UID，同一事务写入确定性的 `workflow_node_session_divergence_conflict` 事件并推进
  `workflow_divergence_check`；若该 fallback UID 也被冲突污染，则有界停止追加并仍推进 checkpoint。因此
  重放无候选、dispatcher 不会每 tick 重复输出 conflict。普通 stale race 保持无副作用。

## TDD 证据

每个行为缺口均先用公开 seam 写失败测试，再写最小实现：

| Slice | RED 证据 | GREEN 结果 |
|---|---|---|
| unbound terminal mailbox | `minted` 预期 0、实际 1 | 不铸 attempt/episode |
| active-run FLY-2278 阳性对照 | guard 过宽时 `minted` 预期 1、实际 0 | 仍开 undeliverable 并 reroute successor |
| severe 存量收口 | settlement 为 NULL、episode 被改成 undeliverable | exact `legacy_unreachable`，alert 时间戳不变 |
| phase wake / turn wake | 各自 `minted` 预期 0、实际 1 | 两类均在 projector 前置 guard |
| 7 天边界 | 两条均铸（预期仅 7d-1ms） | 7d 收口、7d-1ms 保留 |
| issue UUID/identifier alias | 未授权首次 Done 观测错误收口 | 授权终态也不能绕过 7 天 age gate |
| held-run alias 保护 | 清理唯一 alias session 后错误收口 | durable alias ledger 下 held run 仍保留 |
| alias 隔离与幂等 backfill | shared run readers 被 alias 语义扩大，重启重复扫描 | 仅 delivery reader 读 alias，migration marker 只认领一次 |
| missing / 非终态 recipient | 新近 missing、`approved` source 被立即关闭 | missing fail-open 至 7d；只认 wake-terminal 状态 |
| terminal source 恢复 | settled generation 吸收旧 clock、dead recipient 永不恢复 | settled generation 不推进；active/held run 可 re-arm 到 FLY-2278 |
| legacy source 恢复可达 | g2 继承陈年 sent clock 并立即告警 | g2/g3 的 minted/stage clocks 以恢复时刻为下界并 supersede 旧代 |
| terminal-bound run | settlement / closed_reason 均为 NULL | 首 pass 收口 1，重放 0 |
| 独立 watch 防线 | episode 变 undeliverable、attempt 仍 live | 无 projector 前序也直接收口且不重发 alert |
| versionless rework watch | legacy attempt 无 selector 时无法收口 | `legacy_unreachable` 原子关闭 attempt/episode |
| terminal divergence query | completed/terminated run 仍被列出 | 只剩 active/held |
| lifecycle revision | 第二次 commit 抛 `workflow_event_uid_conflict` | 每个 revision 一条 event，第三次无候选 |
| 真实冲突 UID | 每 tick 可重复抛 conflict | durable conflict event + check 同事务记账，后续无候选 |
| fallback 冲突 UID | 第二次 identity conflict 仍回滚 checkpoint | 有界停止 append、checkpoint 前移、后续无候选 |
| shadow run alias | session 清理后 identifier 不再保护 shadow run | 第三条 run 创建路径同事务持久 alias |
| stale divergence race | 错报 “checkpointed once” | stale race 静默交给下轮收敛 |

隔离 fixture 的最终结果：

- R3 修复后 FLY-2324 聚焦测试：2 files、27 passed。
- FLY-2278 / dead-execution / workflow-ledger / retention 邻接回归：7 files、111 passed、1 skipped。
- FLY-2006 retention registry：22 passed；新增 alias authority table 已显式登记。
- `flywheel-teamlead` typecheck 与 build：passed。
- R3 修复复验使用 `VITEST_MAX_THREADS=1 VITEST_MIN_THREADS=1`；此前所有 vitest 使用
  `VITEST_MAX_THREADS<=4`，遵守 Lead 给出的单包与并发红线。全包覆盖运行两次均为 818/818 files、
  10,747 passed、6 skipped；Vitest 在全部断言完成后
  两次都因 runner 的 `Timeout calling "onTaskUpdate"` 以 1 退出（4 threads 与 1 thread 结果相同）。首轮
  未排除运行暴露的三个 timeout/mock 隔离复验全部 green；`patrol-orphan-sweeper` 唯一失败来自当前 tmux
  拒绝包含 literal tab 的 host fixture。以上均与改动文件无关，聚焦、邻接与 retention 套件均 clean exit。

## 生产存量只读分类

查询时间：2026-09-04 01:40 PDT 左右。仅以 SQLite read-only 打开 live StateStore/CommDB；没有运行新代码
写生产库、没有重启 Bridge。两库合计超过 1.2 GB 且 WAL 活跃，因此没有做全库复制，避免增加 I/O 压力。

07:30:48.286Z 批次当前统计（Bridge 持续运行，数字相对最初 796 条已发生正常变化）：

- batch 795；仍 open 782；run_id NULL 总计 747。
- 仍 open 且 unbound：mailbox 694（其中 severe 278）、phase_wake 41（其中 severe 41），合计 735。
- 这 735 条 recipient 全部是 operational-terminal 或双库 absent：
  - mailbox：completed 503、failed 101、terminated 58、blocked 20、absent 12；
  - phase wake：terminated 27、completed 8、absent 4、failed 1、blocked 1。
- bound active/held 48 条受保护（25 active、23 held）；其中 47 仍 open。
- divergence 旧查询形状仍会列出 terminated run 3 条；新查询形状排除这 3 条，只留下 held run 4 条。

### 受保护的 active/held request/root IDs

以下 48 条不会被 legacy guard 截断，继续走现有 FLY-2278 路径：

```text
active mailbox flywheel:FLY-1560:mailbox:366347ae-1d4d-46b1-b519-a4252ed2355a
active mailbox flywheel:FLY-1560:mailbox:46c6136e-f072-4949-8d49-d0e6914c3a03
active mailbox flywheel:FLY-1560:mailbox:design-review-manifest:3c7703c8-3cf7-4a7a-9844-95523a754465:1
active mailbox flywheel:FLY-1560:mailbox:design-review-manifest:3c7703c8-3cf7-4a7a-9844-95523a754465:2
active mailbox flywheel:FLY-1688:mailbox:bb6b3517-ae3a-4256-b720-617c8b3f5d44
active mailbox flywheel:FLY-1759:mailbox:30183d71-977c-454e-a34d-b8cd2214ed74
active mailbox flywheel:FLY-1759:mailbox:96bb295c-6850-4fab-a5e5-0c33cbdcbcb4
active mailbox flywheel:FLY-1765:mailbox:08b73a55-fee6-4a54-aae3-46077dd232b5
active mailbox flywheel:FLY-1765:mailbox:29c2f5b4-c4dc-4e92-9b00-97da91b22c56
active mailbox flywheel:FLY-1765:mailbox:2af2f8ae-97ef-44e7-865c-9f63e4c0226b
active mailbox flywheel:FLY-1765:mailbox:38562e48-3fb5-4af3-b776-dc1e6f3dc8c2
active mailbox flywheel:FLY-1765:mailbox:3b70929b-3769-40b4-b947-5339b9b8a68e
active mailbox flywheel:FLY-1765:mailbox:52bbdc43-9ce1-469e-817a-0886f562c90d
active mailbox flywheel:FLY-1765:mailbox:5a435ecd-67f5-4e77-a471-eef3d6f2d476
active mailbox flywheel:FLY-1765:mailbox:702fd5d7-4a9e-4e21-b564-15cc54271627
active mailbox flywheel:FLY-1765:mailbox:8b9ec935-6c97-40c2-bc5c-2a70aa116c91
active mailbox flywheel:FLY-1765:mailbox:8f87e69e-3c4a-4cc3-8282-1e9ff40f2065
active mailbox flywheel:FLY-1765:mailbox:91328ec6-bb04-4067-adbf-1b4a90a8b814
active mailbox flywheel:FLY-1765:mailbox:a418d0be-d917-4552-9cd0-82850ef0057f
active mailbox flywheel:FLY-1765:mailbox:d44325d0-811a-4cf2-821e-5923bf78e013
active mailbox flywheel:FLY-1765:mailbox:design-review-manifest:9117f44d-f81b-41d5-b2f8-2462c54ee6d5:1
active mailbox flywheel:FLY-1765:mailbox:design-review-manifest:9117f44d-f81b-41d5-b2f8-2462c54ee6d5:2
active mailbox flywheel:FLY-1765:mailbox:f929f2d7-1f7b-488b-b9b7-1c8317a0661e
active mailbox flywheel:FLY-1766:mailbox:c78b2e98-5bb9-48b2-bd2d-c113007d8c42
active mailbox flywheel:FLY-2268:mailbox:8fd40601-24b4-481f-b9a1-ee5354006c04
held mailbox flywheel:FLY-2115:mailbox:land-cleanup-instruction:land:b9146625a21d6446bb28bb62175530666dca20f73b0d8c507aa7647a60bdce44:2b6392c0-a024-45ef-9697-227aa2176ebe
held mailbox flywheel:FLY-2125:mailbox:land-cleanup-instruction:land:ff7d00dae0f730b7907465b114287dc20f629678348861f921e4ea9021be22d9:87efb0c4-a3a5-4d40-9fb7-a414a86f2020
held mailbox flywheel:FLY-2259:mailbox:04d1def6-2b68-403f-bed6-e84739444a10
held mailbox flywheel:FLY-2259:mailbox:220e837a-0518-4974-b344-c7ba28e51e87
held mailbox flywheel:FLY-2259:mailbox:47402bca-f8b9-43ca-8d66-6cfe34aeb096
held mailbox flywheel:FLY-2259:mailbox:4f45a571-3249-4b93-a50f-ec2251dcb1e3
held mailbox flywheel:FLY-2259:mailbox:5cbc0f62-4daf-44dc-babb-835c92053dea
held mailbox flywheel:FLY-2259:mailbox:753a7472-dab7-446a-b658-faaa7dcacb09
held mailbox flywheel:FLY-2259:mailbox:7b1cb652-ebef-4ef5-b450-b0cfcd25125a
held mailbox flywheel:FLY-2259:mailbox:866c81bc-f8f7-43ed-9a18-fcd5321df652
held mailbox flywheel:FLY-2259:mailbox:988d4cbe-da8a-4d75-ac17-252ef655d662
held mailbox flywheel:FLY-2259:mailbox:b9867a9b-cc38-4b82-aa0f-dc40c496d937
held mailbox flywheel:FLY-2259:mailbox:c07b70b9-2f76-4208-96ed-87a42f6434f2
held mailbox flywheel:FLY-2259:mailbox:c3e652e9-a776-4b75-b281-20c955b26639
held mailbox flywheel:FLY-2259:mailbox:de10329d-e76a-47d1-ab59-1ffe1a02bbdb
held mailbox flywheel:FLY-2259:mailbox:e070d096-6216-4b7b-89e7-b61d9f300069
held mailbox flywheel:FLY-2301:mailbox:5276eae7-1882-4b3d-8335-c015e65947d7
held mailbox flywheel:FLY-2301:mailbox:707f8df1-109f-4e10-9540-329109225e1b
held mailbox flywheel:FLY-2301:mailbox:8f61cc56-a476-4843-9df4-0fb3c2c5c51e
held rework flywheel:FLY-2301:rework:rework:47886620325b50a45eef6b600cf49a905c5b74ea213592840c0c63c9fd26b727
held rework flywheel:FLY-2301:rework:rework:7010bbf67fe6fb517c0072008b8dc9800b366242089a8e54f664ec1511bc92de
held rework flywheel:FLY-2301:rework:rework:868852185368099bcb88ff803f664ce313c86e65102db1513633a30e144b274e
held rework flywheel:FLY-2301:rework:rework:ba9122d3cd45705264e60d57bff6e687882e4f139949526b2f00d05b593b2267
```

## 验收边界

本 implement node 已证明同形数据首次收口与同库存量重放；按职责不重启生产 Bridge。部署后的
“同一存量新铸 episode = 0、divergence 重复日志 = 0、8 月死信不再升级”由独立 QA/部署观察完成。
