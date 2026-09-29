# Design Review — plan.md (Round 5)

Date: 2026-09-29
Author: Codex
Status: CHANGES REQUESTED

## Summary

本轮固定在 HEAD `bab9a277a41c276ac3878454296d5e2117ff510b`，plan blob 为 `1a8da51718468f0632030eaad7746622e8e60178`。已从磁盘完整读取 351 行 v6、根目录 CLAUDE.md、exploration/research、Round 1–4 反馈，并核对相关配置加载、两条 ingest、StateStore 同步事务、消费者、启动恢复、CLI 和 prompt 源码及相邻调用。以下 `plan.md` 均指 `engineering/doc/FLY-3055-qa-one-round-criteria/plan.md`。

**Round 4 闭环结论：**

| 项目 | v5/v6 结论 | 依据 |
|---|---|---|
| #1 消费边界终结回执 | **部分解决，尚不能关闭** | `plan.md:183` 已把 HTTP 与 sweep 的消费结果统一持久化，解决“实际消费后仍 pending”；但顺序到达的 A、B 两条 pending 中，旧 A 不会再进入所写的终结分支，见本轮 #1。 |
| #2 接受事实优先于副作用异常 | **设计层面已解决** | `plan.md:20,183,288` 明确首次响应、catch、重放、sweep 均先查 ledger；接受后 O2/fail-flow 抛错仍返回同一 accepted ref，并有提交前/后的对照测试设计。与实际先写状态/intent、再 await 副作用的顺序一致。 |

新增 529 范围总体可行，四类豁免、QA 判断 flow、拒绝空/Discord 理由、主线配置取值和无记录存储时诚实标注均可保留。阻塞点是保留条目的跨轮次转换，以及 C6 引入后的回滚依赖遗漏。共 **HIGH=0 / MED=3** 阻塞项；另有 **LOW=2** 非阻塞建议。

这是静态设计评审：未运行测试、build、lint 或真房验证；未修改源码。HEAD 相对 Round 4 的提交只变更四份设计/进度文档。工作树干净，工作树 `git diff --check` 通过；历史范围 `ba0efd2af9c68e215970d099c3e4837ddda7b4e6..HEAD` 的 `git diff --check` 报 exploration.md:103 多余 EOF 空行，单列为非阻塞项。

## What's Good (Keep)

- `resolveQaResultReceipt` 的 ledger-first 顺序正确。源码确实存在接受后才失败的窗口：`auto-qa-coordinator.ts:1300-1311` 先持久化 awaiting_retest 再调用反馈；`auto-qa-effects.ts:403-424` 打开/关闭 CommDB 可抛错；三阶段也在 `phase-orchestrator.ts:1161-1193` 先写 intent 再驱动流程。v5 的分类不再错误否认这些已接受事实。
- 继续使用三个窄接受事务、已接受重放优先和现有恢复机制，范围合理；不需要借本轮扩展新的调度器，也不需要重开已接受的 O2 best-effort 边界。
- 主线配置来源有真实代码支撑：`packages/teamlead/src/bridge/auto-qa-config-source.ts:40-54` 按 `ProjectEntry.projectRoot` 加载配置，以 `projectName` 建 map；`ConfigLoader.ts:349-378` 是现有 QA 类型校验位置。服务端按持久 reporter 的项目取值，避免依赖请求体或 PR 内的角色标记授权。
- 529 形状校验与项目 PASS 门分开，CLI 不猜项目配置，服务端继续权威检查；四个豁免类别和理由是否充分由 QA 判断，符合本轮明确的 founder 裁定，不建议增加关键词推断 flow 或机器裁判理由充分性。
- 已核对 commands 目录及 packages/scripts/.flywheel 源码：没有 room 子命令，也没有 `e2e_529` / `evidence-run` / `room drill` / `generalized flow` 接口。保留可选记录核对接口、将本仓库结果记为 `e2e_529_verified=0` 是合适的范围控制；本轮不要求引入房间 CLI 或证据存储。它提供的是结构化申报门，不能把未核对 UUID 宣称为真机证据已验证。
- §7.5b 对角色文件的改动是新增：当前 `.flywheel/agents/engineering/qa-executor.md:19` 只有一般 Real-machine E2E 规则。`Blueprint.ts:661,1866-1869` 也证实角色读取晚于 session_started，改用项目配置避免了 spawn 标记的时序问题。

## Issues & Recommendations

1. **[MED][BLOCKING] Round 4 #1 仍有残余：旧 pending 的 superseded 更新没有可达的调用时机。**

   **位置：** `plan.md:180,183,288`。

   **触发与影响：** 同一 QA 在 holder 缺失期间先提交 A，收到 pending；随后提交 B，亦收到 pending。写 A 的 pending 时还没有 B，写 B 的 pending 时也没有比 B 更新的事件，因此“写入 pending 时若已有更新事件”的条件两次都不成立。启动后只消费 B；新增的消费后 receipt 调用只能终结 B。A 的精确重放则按 §5.3 步骤 2 直接读取既有 pending，CLI 继续 exit 0 并承诺启动消费，尽管 A 已没有消费机会。

   **源码证据：** `packages/teamlead/src/StateStore.ts:3376-3382` 的查询是 `ORDER BY id DESC LIMIT 1`；`packages/teamlead/src/bridge/phase-orchestrator.ts:914-933` 每个候选 execution 只获取、消费这一个事件，没有遍历旧 pending 的路径；在线 holder 缺失分支在 `event-route.ts:590-595`。这与前一轮指出的 latest-only 场景相同，v5 修订轨迹和 §8 的预期断言尚未由正文的步骤实现。

   **建议：** 在明确的可达边界终结旧事件。例如新 qa_result B 持久化时，对同 execution 的旧 pending 且无 ledger 行的事件追加 `not_accepted/superseded_by_newer_verdict`；或在读取 pending 回执时比较当前 latest，并在 sweep 中处理旧 pending。保留 ledger-first，不能把已有 accepted A 覆盖成未接受。无需新增调度器。已有 §8 用例应使用“A 的 pending 响应已完成 → 再提交 B → startup → 原样重放 A”的顺序，而不是先插入 B 再调用 A 的 receipt helper。

2. **[MED][BLOCKING] 豁免条目无法退役，合法的“上一轮豁免、本轮实跑”会被清单规则永久卡住。**

   **位置：** `plan.md:57,61,71,87,99-103,279`。

   **触发与影响：** A 轮按 `no_flow_change` 提交 `e2e_529_exempt/not_run`，同时另一判据 FAIL；修复或后续 founder feedback 改动了 flow，B 轮真实跑完 drill，需要提交 `e2e_529/pass`。覆盖规则要求保留上一轮的 `e2e_529_exempt`，但它只能是 not_run；与新 `e2e_529` 同时保留又违反两个活动保留 id 的互斥规则。删除旧项会触发 prior_uncovered，改 carried/pass/merged 会违反 exemption 的形状规则。即使仅放宽 exemption 可 merged，通用规则仍禁止把旧 not_run 合并进本轮 pass，所以还没有合法转换。

   **源码与接线证据：** 这不是假设永不发生的跨 run 更换：当前 auto-QA 在 FAIL 后保持同一 QA 等复验（`packages/teamlead/src/bridge/auto-qa-coordinator.ts:1294-1307`）；三阶段同 execution 的后续轮次及 PASS 后 founder kickback 均可进入新一轮（`phase-orchestrator.ts:1052-1071,1101-1127`），Blueprint 对应命令在 `packages/edge-worker/src/Blueprint.ts:1175-1188`。新 evaluator 会在这些路径检查同一份覆盖义务。

   **建议：** 明确定义两个保留 id 之间的合法转换。可给“exempt → 实跑结果”增加窄的退役/替代规则，让合法的 `e2e_529/pass` 解除旧 exemption 的 not_run 义务，并允许保留 exemption 的 merged 历史项；形状规则和引用/合并规则必须一起修改。不要放宽普通 fail/not_run 合并进 pass 的限制。测试应覆盖 exempt→ran、ran→exempt、连续 exempt、ran→carried，以及一次正常 FAIL→fix→PASS 的完整提交路线，而非仅单份清单真值表。

3. **[MED][BLOCKING] C6 未纳入分阶段回滚；直接补一个“先撤 C6”也会过早撤掉活体 QA 需要的解析能力。**

   **位置：** `plan.md:308-312,326`。

   **问题与影响：** §10 仍只在第一步撤 C3/C4/C5，最后撤 C2b/C2a/C1；新增 C6 明确依赖 C1/C3/C5，却从未被撤回。它还同时拥有共享 schema 的 `e2e`/`exempt_category`、拒收常量、服务端检查和角色规则，不能按原依赖顺序留下来再删除其基础模块。若将整个 C6 简单提前撤回，保留的 C2a/C2b 又会回到只识别旧条目键的 parser：已接收 §7.5b 协议的活体 QA 提交 e2e/exempt 文件，会在网络请求之前被本地拒绝，无法完成 §10 所要求的排空。

   **源码证据：** 当前 CLI 的实际参数入口在 `packages/flywheel-comm/src/index.ts:928-947`；计划 §4 把新增文件解析放在此处、任何 HTTP 之前，并且 §2:58 明确拒绝未知条目键。因此仅保留 `--criteria-file` 参数声明不足以兼容 v6 已产生的输入；必须保留 v6 parser 能力。这是 C6 对已批准回滚设计引入的新依赖。

   **建议：** 将 C6 的服务端 enforcement/配置开启/协议 producer 与共享 schema、CLI 输入兼容拆清楚：前者随第一阶段停止，后者与 C2a/C2b/C1 一起保留至受影响执行集合为空，再按依赖顺序撤回。不需要新的运行时开关。补“已载入 v6 的 QA，尚未提交 e2e/exempt 文件 → 服务端回滚 → 保留 CLI 仍可解析并发送 → 退出后撤语法”的验证设计，并同步 §11 chunk 依赖。

**非阻塞建议 / Nits**

- **[LOW][ADVISORY] 补一句配置 map 的生命周期和类型接线。** `plan.md:105,154,326` 指向的 `loadQaConfigByProject(projects, readFile?)` 实际返回 `Promise<Map<string, QaConfigResult>>`（`auto-qa-config-source.ts:40-43`），其 `AutoQaConfigShape` 当前只有 auto/skip_labels（`:29-38`）。现有 map 又局限在 `plugin.ts:6218-6261` 的 auto-QA 初始化块，晚于 `app.listen`（`:4325`），不是 StateStore 可直接同步读取的全局配置。实现时应显式扩展返回类型，并把完成加载的项目配置快照/同步查询依赖传给两条 route 和接受事务；不要在 `StateStore.ts:142-143,10517` 的同步事务内 await loader，也不要把“尚未加载”当作 absent 放行。建议写明加载在监听之前完成，或未就绪时明确拒绝新提交。这是小幅接线澄清，不要求改变主线配置方案。
- **[LOW][NON-BLOCKING] 两处机械校正。** `plan.md:156` 的 auto-QA PASS 首次 `setAutoQaStatus` 实际在 `packages/teamlead/src/bridge/auto-qa-coordinator.ts:1270`，不是 :1277（后者已在通知后的阶段注释附近）；实施应替换 :1270 的写入，以符合正文“首次调用”的正确要求。历史 diff 的 `exploration.md:103` 多余 EOF 空行也可一并清理。本轮未修改这些文件。

## Verdict

CHANGES REQUESTED

Blocking findings: HIGH=0, MED=3. Non-blocking findings: LOW=2.

Round 4 #2 可关闭；#1 的消费后终结部分可保留，但顺序到达的旧 pending 仍须补齐。修订保留 id 转换与 C6 回滚顺序后，现有共享规则、accepted ledger、主线配置来源和可选证据核对边界无需重做。
