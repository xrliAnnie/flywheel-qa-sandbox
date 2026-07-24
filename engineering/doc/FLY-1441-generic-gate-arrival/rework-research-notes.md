# FLY-1441 Gate 到达发射 — 重做调研交接
Issue: FLY-1441 (https://linear.app/geoforge3d/issue/FLY-1441/规则回迁-qa-绿了才发-ship-gate-把-fly-579-定过的规矩在-dag-引擎上重新落地-加防丢测试)
日期: 2026-07-23
基于: exploration.md、research.md、plan.md（均为 Founder 打回后的中间稿，不能直接实施）

## 交接状态

本文件只交接只读调查事实，不是已批准的设计。

- 旧 PR #688 的 QA-specific 设计、实现和测试已经全部从分支撤销。
- 当前分支相对 main 只有设计文档和 progress，没有实现代码。
- Founder 要求重新设计成通用 DAG 语义：模板 topology 到了 Gate 才呈现 ship approval；引擎不能按 `QA` 节点名、`qa_passed` claim 或特定模板名决定发射。
- Lead 已停止本 implement runner 的设计工作；后续 design runner 必须从这些证据重新产出 exploration / research / plan，并重新走设计审查和 Founder 确认。
- 同目录现有 `research.md` / `plan.md` 是设计审查前的中间方案。Codex 设计审查发现其中“禁掉 runner approval、改用非权威 ship-ready notice”的方案会让真实审批链断掉，因此不可直接实现。

## 一、生产事故的真实因果链

### 1. DAG 没有跳过 QA

对 `/Users/xiaorongli/.flywheel/teamlead.db` 的只读核验显示，FLY-1364 的 engine run 为：

```text
run_id:   9aff8b01-3091-4406-a86c-5ab54c2988df
template: tpl_eng_heavy

implement attempt 1 done
  → QA attempt 1
QA attempt 1 fail
  → implement attempt 2
implement attempt 2 done
  → QA attempt 2
QA attempt 2 pass
  → terminal Gate/review
```

第二轮 QA 在 2026-07-23 08:10:36 通过，engine 的 canonical `ship_ready_*` event 在 08:10:47–08:10:48 才出现。也就是说，engine topology 和 Gate transition 的时序本身是正确的。

### 2. 提前 Gate 是 implement runner 自建的 out-of-band question

第二轮 implement 在 QA 开始前已经进入 `stage=approve`，并向 CommDB 写入 `approve_to_ship` question。后续账本出现 `ship_gate_superseded`，把早期 question 换成新的 question；这不是 engine 抵达 Gate 的 transition。

生产 dispatcher 会同时给 implement runner：

```text
generalizedExecutionContext
sessionRole=implement
shareParentBranch=true
phaseKeepAlive
```

`packages/edge-worker/src/Blueprint.ts` 的 generalized 主 contract 正确写了：

- DAG orchestrator owns graph advancement；
- node capability 不允许时不得创建 ship approval；
- generalized checkpoint block 不注入 `approve_to_ship`。

但 legacy FLY-887 implement epilogue 只看 `shareParentBranch + sessionRole=implement`，又追加：

```text
ran the APPROVE GATE flow
repeat the APPROVE GATE flow
```

同一 prompt 因而同时要求“不要创建 ship Gate”和“完成后跑 APPROVE GATE”。现有 `Blueprint.generalized-workflow.test.ts` 没有构造生产的 `shareParentBranch + sessionRole + generalizedExecutionContext` 组合，所以没有抓到冲突。

另一个同类泄漏是 `canLand` 尾声：generalized implement 仍可能收到 `ready_to_merge` / exit / landing signal 相关文案。修复 prompt 时必须同时覆盖它，且保留 three-stage TURN / park keep-alive；不能靠关闭 phase controller 绕过。

### 3. 越权 question 有多个恢复/呈现入口

`flywheel-comm gate approve_to_ship` 当前只做 CI precondition 后写 CommDB，不校验 caller 是否为 engine-owned execution、run 当前是否在 Gate。

即使修掉 prompt，错误 question 仍可能经以下路径被呈现或复活：

1. `packages/teamlead/src/bridge/question-admission.ts`
2. `packages/teamlead/src/bridge/gate-poller.ts`
3. `packages/teamlead/src/bridge/bootstrap-generator.ts`

因此生产 prompt 修复是必要条件，但不是完整系统不变量。设计应有一个共用的 engine Gate ownership / authority 判定，禁止 engine node 的 out-of-band ship question 绕过 DAG。

## 二、设计审查暴露的关键缺口：必须保留真实 approval carrier

第一轮重做计划提出“屏蔽 runner 的 approve question，然后把非-land `ship_ready` scanner 改成纯 Gate-arrival 通知”。Codex 设计审查以 HIGH finding 拒绝：

```text
findingKey: ship-approval-carrier-removed
```

原因：

- `ship_ready` card 明确只是提示，不是 `approve_to_ship` question；
- Founder 的批准、`verify-approval`、PR head 校验和后续 self-ship 都依赖一个真实且绑定 execution/session/head 的 approval carrier；
- 当前 engine 只为 `land_v1` 在 Gate arrival 时创建 `workflow_gate_holder`，再由 `gate-materializer.ts` 物化真实 question；
- schema v1 non-land engineering 和 schema v2 generic/product 没有等价的 engine-materialized carrier；
- 如果先屏蔽 runner question、又没有补上 engine carrier，流程会停在 Gate，Founder 无处批准，runner 也无法通过 `verify-approval`。

因此新的设计不能只做“通知器改条件”。它必须回答：

1. 每种 engine-owned terminal Gate 到达时，谁创建唯一、幂等、可审计的真实 approval carrier？
2. carrier 绑定哪个 execution/session/head/PR？
3. Founder 批准后，哪种流程由 engine 投影完成，哪种流程唤醒具备 ship capability 的 runner？
4. Founder 要求修改时，Gate 如何按 snapshot 声明的 loop 回到可执行节点？
5. 旧的 `ship_ready` notice 与新 carrier 如何避免双发？

## 三、现有 approval authority 的代码事实

### 1. `workflow_gate_holder` 目前只服务 `land_v1`

相关 seam：

- `packages/teamlead/src/StateStore.ts`
  - `commitWorkflowTransitionTx`
  - `workflow_gate_holder`
  - Gate attempt / `gate_opened`
- `packages/teamlead/src/workflow/gate-materializer.ts`
- `packages/teamlead/src/workflow/GateAuthorityView.ts`
- `packages/teamlead/src/workflow/source-event-projector.ts`

当前行为：

- `land_v1` 到 Gate 时会原子创建 holder；
- materializer 根据 holder 创建 CommDB `approve_to_ship` question；
- holder 记录 source execution、question id、head 和 materialization state；
- `GateAuthorityView` 只承认 `land_v1` 当前 Gate holder；
- Founder 批准后 engine 投影 claim 并推进 Gate → land。

这个机制证明“Gate arrival 物化权威 approval carrier”已有可复用骨架，但不能假设直接去掉 `land_v1` 限制就完成了，因为不同模板的批准后动作不同。

### 2. `verify-approval` 仍是 session-scoped

CLI 校验要求：

- session 有真实 `review_question_id`；
- question 来自同一 execution；
- Founder 的结构化回答为 approved；
- session status 为 `approved_to_ship`；
- PR head 匹配；
- code review 和 CI 前置满足。

因此 v1 non-land engineering 如果仍由 implement runner self-ship，设计必须说明：

- Gate holder 如何选择此前已 complete/park 的 ship-capable execution；
- 如何幂等绑定 question/head；
- Founder 批准后如何合法把该 session 变成 `approved_to_ship` 并 wake；
- runner 如何只在“approval wake”分支运行 verify + ship，而不是在初始 implement completion 时创建 Gate。

仅把 holder 的 `source_execution_id` 指向 QA execution 不够：QA session 通常没有 ship capability，也不满足 implement runner 的 self-ship contract。

### 3. schema v2 terminal Gate 已有 engine completion 投影

`applyWorkflowSourceEvent` 对 schema v2 terminal Gate 可以在 Founder approval claim 合法后完成 run；这种模板不一定需要唤醒 implement runner self-ship。

这提示新的通用 carrier 至少需要区分批准后的 authority mode，例如：

- engine-terminal completion；
- runner self-ship；
- 既有 `land_v1` Gate → land。

模式应由 snapshot/capability/transition contract 推导，而不是由节点名或模板 id 硬编码。

### 4. schema v1 non-land 的完成/反馈路径必须明确

当前非-land engineering 依赖 runner question → Founder approval → runner verify/self-ship。若改由 engine holder，设计还必须说明：

- merge/land 后 engine run 如何从 Gate 变成 completed；
- Founder feedback 如何令 Gate 沿模板声明的 loop 回到 implement（而不是继续使用 `QA` 专名或 out-of-band session 状态）；
- 在途 runner question、旧 Gate attempt 和新 holder 如何去重/迁移。

这是第一轮计划没有覆盖的架构缺口。

## 四、通知与 delivery 的真实生产路径

第一轮计划把 `formatNotification` 当作主要修改点，但设计审查指出它不是生产关键路径。

应核对并覆盖：

- `packages/teamlead/src/bridge/event-route.ts` 中 FLY-47 的 always-deliver 路径；
- `packages/teamlead/src/DirectEventSink.ts` 的 `pushNotification` parity 路径；
- QuestionAdmission / GatePoller / bootstrap 三条 question surface；
- gate holder materializer 的真实 approval card。

DirectEventSink 更像 parity / prevention；生产 engine transition 的主要 delivery 是 event-route。测试不能只覆盖 dead formatter。

共用 helper 最好接受已解析的 execution/session context；CommDB message 的发送者字段可能是 `from_agent`，如果每个 consumer 自己重新解析，很容易再次产生不同判定。

## 五、建议 design runner 重新比较的架构方向

以下只是研究输入，不是已批准方案。

### 方向 A：把 Gate holder 泛化成所有 engine terminal Gate 的权威 carrier

优点：

- approval 的创建时机天然等于 engine Gate arrival；
- holder + materializer 已有幂等、head 绑定和恢复骨架；
- 可以统一拒绝 runner out-of-band question；
- generic 无 QA 模板照样能在直达 Gate 后得到真实审批；
- 发射器不需要理解 QA。

必须补齐：

- 由 snapshot/capability 推导的 approval authority mode；
- v1 runner self-ship 的 execution 选择、session 绑定、approval wake 和 merge completion；
- schema v2 engine-terminal completion；
- Founder feedback 的通用 loop 重入；
- land_v1 零回归；
- 不与 legacy `ship_ready` surface 双发。

### 方向 B：Gate arrival 唤醒 runner，再由 runner 创建 question

实现可能较小，但仍把权威 carrier 的创建依赖 runner 存活、prompt 正确和 wake 不丢，无法形成强 engine invariant。若考虑此方向，必须证明 crash/retry/duplicate wake 下不会提前发、漏发或双发。

### 不应继续的方向

- 通知器直接检查 `qa_passed`；
- 按 template id whitelist 决定谁能发；
- 只修 prompt、不做 server-side authority fence；
- 只发非权威 notice、不提供真实 approval carrier；
- 默认开启 schema v2 全量 scanner 扩面并在首 tick 回填所有旧 Gate。

## 六、迁移与 rollout 风险

设计审查的另一个 MEDIUM finding 是：把 scanner 默认扩到所有 schema/template 会在首次 tick 对历史 Gate run 回填，可能批量惊动 Founder，且没有细粒度回滚。

新的方案应明确：

- 新 holder 机制是否默认关闭，用独立 rollout flag 只作用于未来 Gate arrival；
- 当前已经在 Gate 的 runs 是否不 backfill；
- 旧 runner-created question 如何继续完成而不被新 fence 误杀；
- holder-backed run 如何排除旧 `ship_ready` notice，确保 exactly-once surface；
- 回滚时能否只停新 materialization，而不破坏已发 holder 的回答投影；
- 何时、按什么证据删除旧 scanner/fallback。

不要用 template whitelist 作为永久 policy；rollout flag 只能是迁移控制。

## 七、Founder 新追加 scope：去掉引擎层 QA 专名

Lead 于本次换手前传达 Founder 追加的同单 scope。design runner 必须在新设计稿中分三节覆盖：

1. ship approval 发射服从模板 topology；
2. `workflow_run.current_qa_attempt` 改为通用 loop 迭代计数；
3. `/api/workflow/qa-retest` 改为通用 loop 重入操作。

### 1. 通用 loop 计数

目标不是把列简单改名成 `current_loop_attempt`，而是支持 snapshot 声明的任意 loop：

- 计数按 template loop 的稳定 id 保存；
- 同一 run 可存在多个 loop，不能只有一个全局数字；
- transition 根据被遍历的 loop edge/id 更新对应计数；
- 旧 `current_qa_attempt` 数据必须兼容迁移且不丢；
- 读旧 run、升级 snapshot/manifest、重试和 crash replay 都要定义；
- 节点 type 可以用于绑定执行者，但不能驱动计数语义。

设计应先盘点所有 `current_qa_attempt` 读写、schema migration、API/serializer/metrics 依赖，再决定新存储形状。候选可以是按 loop id 的 JSON map 或独立 relation，但必须比较原子更新、查询、迁移和约束。

### 2. 通用 loop 重入 API

`/api/workflow/qa-retest` 的真正语义是“触发模板声明的某条 loop 重入”。新的设计应定义：

- 通用 operation/path/name；
- 输入至少包含 run 和 loop id，必要时带 expected attempt/current node 防并发；
- 只允许 snapshot 中声明、且当前状态可走的 loop；
- engine 选择 edge/target，不允许 caller 直接伪造下一节点；
- idempotency、重复请求、stale attempt 和 audit receipt；
- 旧路径保留兼容 alias 还是显式迁移，兼容窗口和移除条件；
- legacy alias 内部必须调用同一个通用 operation，不能继续保留 QA-specific engine branch。

### 3. grep 验收

Founder 的验收要求是：引擎源码中 grep 不到任何按节点名写死的行为。节点 `type` 只可用于模板声明的 executor binding，不可驱动 engine transition、loop counter、approval eligibility 或 retry/re-entry。

设计稿应给出：

- 搜索范围（StateStore、workflow engine、dispatcher、API、projector、tests）；
- 允许保留的 compatibility alias / migration literal 清单及删除条件；
- 禁止的 control-flow 示例；
- 正向集成测试：使用不叫 QA 的 verdict/loop node，证明 loop fail → re-entry → pass → Gate；
- generic 无 QA 直达 Gate 的正向测试。

## 八、建议的新设计测试矩阵

至少覆盖：

1. `start → intermediate → Gate`：未到 Gate 时零 approval；到 Gate 时恰好一个真实 question/card。
2. bundled generic 无 QA template：直达 Gate 后能得到同一种真实 approval carrier。
3. engineering loop：implement complete 后进入 verdict/loop node，不发；loop pass 到 Gate 才发。
4. 不叫 QA 的自定义 loop：fail 后按 loop id 重入、对应 counter +1；pass 后到 Gate。
5. Founder approval：
   - engine-terminal mode 完成 run；
   - runner-ship mode 绑定并 wake 正确 execution；
   - land mode 保持既有 Gate → land。
6. Founder feedback：按 snapshot loop 重入，不按节点 type/name 分支。
7. prompt 生产形状：
   - 初始 generalized implement completion 不含 `APPROVE GATE`；
   - 不含 `ready_to_merge` / exit / landing signal；
   - 保留 complete + park + phase keep-alive；
   - 只有 engine approval wake 才出现 verify/self-ship contract。
8. authority fence：engine node out-of-band question 在 admission、fallback、bootstrap 都被拒绝；engine holder 与 legacy question 分别放行。
9. exactly once：retry、restart、materializer crash、duplicate tick 不重复发。
10. migration：旧 `current_qa_attempt` 无损转成 loop-id counter；旧 `/qa-retest` alias 与新 operation 产生同一 receipt。
11. rollout：启用前后的新 Gate run 行为、在途 Gate 不 backfill、holder-backed run 不再收到旧 notice。

## 九、建议的下一步调查清单

design runner 在收敛 plan 前还应只读确认：

- `workflow_gate_holder` schema、materializer stage 和 `GateAuthorityView` 的 land-only assumptions；
- session review binding/status FSM 是否允许 Gate arrival 后幂等绑定已 park 的 implement execution；
- approval response hook 在 holder-backed runner-ship mode 下如何 wake，而 land/schema2 mode 为什么应跳过 wake；
- v1 non-land merge/finalization如何投影到 workflow run；
- snapshot 当前如何表达 loops，以及是否已有稳定 loop id；
- `current_qa_attempt` 的全部 SQL/TypeScript/API/telemetry consumers；
- `/api/workflow/qa-retest` 的 route、caller、auth、idempotency 和 tests；
- FLY-1261 删除 auto-QA 后仍需保留哪些 compatibility seams。

先解决真实 approval carrier 和通用 loop model，再决定 scanner 是否还需要扩面。不要从现有中间 `plan.md` 直接进入实现。
