# FLY-2399 自动审批判断与学习 — 调研
Issue: FLY-2399 (https://linear.app/geoforge3d/issue/FLY-2399/2309b5-自动合并放手前要改的三条规矩提案交-founder-拍p2-文档单-依赖-b4-结果)
日期: 2026-09-10
基于: plan.md

## R1 → R2

R1请求 `89615cf9-2155-491f-a696-b73af4b00e92`，gate `98c1a0e0-5c1b-4333-ad63-53bf9a4eeeb8`：有效CHANGES_REQUESTED，3 HIGH、6 MEDIUM、1 LOW。本轮逐项采纳，其中消息归属采用“不认领旧消息”的更简单方案。所有改动仅为设计文档及页面，没有产品实现或权限变更。

| findingKey | 处理与验证要求 |
|---|---|
| input-version-key-overinvalidation | §3–6拆semantic_digest与mechanical_digest，新增只追加evaluation表。一份语义结果可组合多版机械意见；10次机械变化只spawn1次，3次硬帽仅算真正模型材料变化。预算等待不铸evaluation，次日可评同input。 |
| fly2396-authorship-allowlist-unaddressed | §7.2明确只读outcomes.ts为唯一新增B2消费者，FLY-2396精确白名单从5到6，其余负向约束保留；新测试放__tests__，回归显式收录原门。 |
| epic-page-byte-budget-unaccounted | §8主HTML每child≤256B，20卡预览/入口≤16KiB；完整30天历史独立普通报告分页，每页≤64KiB。原60-child≤480KiB、发布前后≤512KiB与cap重测为硬验收，历史子页失败不阻断主进度发布。 |
| dry-run-precision-sample-starvation | §7.1拆snapshot capture-only与legacy delivery，dry_run仍积累旧三闸快照/样本，次级区标清旧三闸统计，不喂新can。 |
| clarification-id-pk-contradiction | §3/6根id含question前缀，答复id含reply前缀/root/source/revision；同事件幂等，不同答复不撞主键。 |
| retention-classification-test-updates-missing | 七表同步registry、生产fixture、retention sweep硬计数和真实schema；本基线143/204/201→150/211/208；receipt沿用旧表。 |
| new-queue-project-scope-and-default-on | §2固定仅Flywheel，与现旧窄口项目范围一致；其它项目默认dry_run仍零新模型/消息；不引入全项目默认开启。 |
| adopted-message-ownership-on-mode-flip | §7.1不共享message_id，两个sender各只编辑自身消息；原消息由原sender标历史，新消息有独立marker，双向mode翻转验不争抢。 |
| no-negative-case-card-approval-still-routes | §7.3精确reply.message_id匹配澄清；U7新增pending澄清期间原卡approve/rework仍落B2的反向测试。 |
| prospective-pairing-lacks-read-gap | §7.2保存可重算的两时间并报告read_gap_ms，明确投递在先不等于已读或因果正确。 |

产品规格与互动HTML同步项目范围、机械配额、保留旧样本及独立历史页。页面评论逻辑重新验证PASS；本地Mermaid渲染权限限制仍存在，保留明确占位。R2评审在推送新头后新gate注册，未把本次修订视作已批准。

## R2 → R3

R2请求 `20bb10b3-2aec-4647-8f24-4be32d733de8`，gate `dc570ade-5cba-43d7-8a21-cf5bc4f5acdf`：有效CHANGES_REQUESTED，1 HIGH、2 MEDIUM，全部采纳。

| findingKey | 修订与反向验收 |
|---|---|
| mechanical-refresh-mints-unbounded-opinions | §3–6排除fetched_at/updatedAt，独立presentation_digest仅实质变化才铸意见；每卡6意见/6 PATCH尝试每滚动小时、至少间隔10分钟，额外候选只留最新；共享project快照60秒/120请求每小时。10次无关刷新仅1意见/1POST/0PATCH，真实翻转≤6/6，重启不重置；待刷新旧可不算当前预测。 |
| history-page-regeneration-cadence-unspecified | §8独立后台30分钟最小间隔，内容不变零发布并复用URL，12天续期是明确例外；冻结轮次/manifest持久化，慢网络不在Epic刷新链，失败保留旧入口；U9覆盖零调用与节流。 |
| legacy-delivery-stop-state-missing | §6/7/T1/T4明确旧delivery增两nullable时间列，不改CHECK/FK；请求历史标记与成功冻结分开，row/claim/CAS全覆盖；dry_run冻结后零PATCH，auto原子解冻后显式原capture+delivery；旧程序忽略列，再升级重新核模式。 |

新增第八张项目状态表是缓存与限频状态，不是新批准事实；同步retention精确表集/计数与产品说明。页面同步意见限频与历史更新间隔，评论脚本不变。

## R3最终有效裁决与交接建议

- request `81a5ee8e-3dd7-4231-9504-5aed3e0173e2`，gate `ce8d7838-01f4-49ad-bbe5-a497f0c12f22`；reviewed head `c39b45176`。
- effective reviewVerdict=**APPROVED**，reviewerVerdict=APPROVED，round=3，settled=[]；无HIGH。裁决之后仅追加本回执/验证/进度及计划状态，未重写获批技术设计或HTML。
- 三条非阻塞建议已通过ask --report回报Lead（回执`e52cd3be-32bb-451f-8dc5-608d211e473e`）。它们仍未实施，不能说已修复：
  1. `mechanical-budget-vs-refresh-rhythm-has-no-headroom`（MEDIUM）：120请求/小时无法冷启动读取200张PR；实现规划应校准调用成本、节律/预算，并补活跃规模正向证据。当前预算不足明确不可判定，影响可用性。
  2. `project-state-hot-row-holds-4mib-cache`（MEDIUM）：把可重建大缓存与热调度列分离并明确清理，避免主库写放大；当前设计仍同表行。
  3. `auto-narrow-schema-test-not-in-regression-list`（LOW）：补`src/__tests__/StateStore.auto-narrow-schema.test.ts`，明确增列后重开库sqlite_master逐字不变。

这些建议由Lead选择后续处置；有效门已通过，本节点继续规定的HTML发布/设计交接，不自派后续工程。
