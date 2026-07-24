# FLY-1441 Gate 到达发射 — 探索(design epoch 4)
Issue: FLY-1441 (https://linear.app/geoforge3d/issue/FLY-1441/规则回迁-qa-绿了才发-ship-gate-把-fly-579-定过的规矩在-dag-引擎上重新落地-加防丢测试)
日期: 2026-07-23
基于: rework-research-notes.md(前任只读调查交接)

---

## 1. 前提:两轮否决把问题钉在哪里

**Founder 否决 #1(QA 谓词设计,PR #688 已整体 revert)**,原话:

> 「通知器不看 QA,现在的发射条件是只看流程是否走到了 Gate 节点,这个逻辑是对的。我们并不是所有情况都需要看 QA,比如 Generic 产品的模板没有 QA Gate 直接开,which is fine……我们的要法就是:你这个东西一定要 generic,一定要简单,不要在上面打补丁。」

**Codex 否决 #2(HIGH `ship-approval-carrier-removed`,中间稿)**:「压掉 runner 自建 approve question + 只发非权威 ship-ready notice」会断掉真实审批链 —— founder 的批准、`verify-approval`、self-ship 全都依赖一个真实的、绑定 execution/head 的 approval carrier;砍掉 runner question 而不补引擎载体 = 流程停在 Gate,founder 无处批准。

两轮否决合起来给出本单的真命题:

> **engine-owned run 的 founder ship 呈现与批准载体,唯一依据 = 流程真正抵达模板声明的 terminal Gate;载体由引擎在 Gate 到达时权威物化,runner 永不自建。零 QA 特判、零模板特判。**

「QA 完才发」是 eng 模板拓扑(design→implement→qa→gate)的自然结果;`tpl_generic` 无 QA 直达 Gate 照样开门 —— 行为不变且必须有正向测试。

## 2. 生产事故的真实因果链(生产 DB 已核,两轮独立核验一致)

- **DAG 引擎没有错**:FLY-1364 run(`9aff8b01`,tpl_eng_heavy)账本:implement/1→qa/1(fail)→implement/2→qa/2(pass, 08:10:36)→ gate_opened 同秒 → canonical ship_ready 08:10:47-48。拓扑与时序全对。
- **提前的 ship gate 是 implement runner 自建的 out-of-band `approve_to_ship` question**:implement exec `8fee109c` 在 05:07:30(QA 未跑)已进 `stage=approve` 写入 CommDB question,06:26:40 还发生 `ship_gate_superseded` 换新 question —— founder 看到的早到 ship gate 来自这条 DAG 之外的 CommDB 路径。
- **泄漏源 = prompt 合同冲突**:`Blueprint.ts` 的 generalized 主合同写明「DAG owns advancement / 不得 request ship approval」,但 FLY-887 legacy keep-alive epilogue(`Blueprint.ts:1771`,只看 `shareParentBranch+sessionRole=implement`,未排除 generalized)又追加「ran the APPROVE GATE flow / repeat the APPROVE GATE flow」。同一份 prompt 同时下两道相反命令。现有 `Blueprint.generalized-workflow.test.ts` 从未构造生产组合(全文件无 `shareParentBranch`/`sessionRole`),所以测试绿着放走了冲突。
- **即使修了 prompt,越权 question 仍有 5 个呈现/复活入口**(admission / relay / founder-fallback / ✅-reaction pass / bootstrap)+ 2 个 delivery sink(event-route always-deliver / DirectEventSink parity)。`flywheel-comm gate` 是直写 sqlite,无任何 Bridge API 中介 —— 所以 authority fence 只能建在呈现消费侧。

## 3. 载体缺口:为什么必须泛化 gate holder

当前唯一的引擎权威载体是 `workflow_gate_holder → gate-materializer`,**只服务 land_v1**(创建守卫 `StateStore.ts:22138-22142`)。其余两类 engine terminal gate 今天都没有真实批准载体:

| gate 形态 | 今天的「批准」现实 |
|---|---|
| v1 land_v1 | ✅ holder→materializer→approve_to_ship 卡;批准→引擎推 land(整链健康) |
| v1 non-land eng(tpl_eng*) | ❌ 靠 implement runner 自建 question(= 本次事故源);canonical ship_ready 卡明文「不是批准载体」;**merge 后 run 永远停在 gate(无 completion 投影,已核:pr_merged 观察只压告警不收口)** |
| v2 generic/product | ❌ 完全无载体:引擎有「批准 claim → run completed」分支,但没有任何 question 可供 founder 落笔(FLY-1434-⑤ 实测「founder thread 批准无处落笔」同源) |

## 4. 新增 scope(founder 直令,三处引擎去特化)

1. **发射器服从模板 terminal_gate 拓扑**(主修):删 schema/模板白名单/qa_passed claim 条件与 QA 文案。
2. **`current_qa_attempt` → 通用语义**:审计发现它不是 loop 计数器 —— 通用 per-loop 计数**已存在**(`loop_iteration` 事件按 `edge_id=loop.id` COUNT,max_iterations 执法即用它);该列只是「最新已 admit 的 qa 节点 attempt」的 QA 特化冗余指针,4 个消费者(stale-attempt 闸、decision-binding currency、ship-eligibility join、/re-qa 幂等)全部可改为按节点通用查询。
3. **`/api/workflow/qa-retest` → 通用 loop 重入**:⚠️ 溯源翻案 —— 该路由**从未进过源码**(git log -S 零命中;只存在于 stale `dist/`,是第一轮被 revert 的原型)。源码真实存在的是 `/re-qa`(语义不同:legacy durable QA session 收编进 claims 引擎)。故「兼容别名」无对象;应新设通用 loop 重入操作,`/re-qa` 原样保留并文档区分。
4. **grep 硬验收**:引擎源码 grep 不到按节点名写死的行为;node type 只许做模板绑定(executor/decision family),不许驱动 transition/计数/批准资格/重入。审计已产出完整 hit 清单及四类分级(条件词汇表/executor 绑定/引擎控制流特化=要改/迁移兼容字面量=允许留+删除条件)。

## 5. 设计选项

### 方向 A(推荐)— gate holder 泛化为一切 engine terminal Gate 的权威载体 + capability 推导批准后模式

- Gate 到达(`commitWorkflowTransitionTx` gate 分支)= 唯一载体创建时机,引擎权威物化,runner 永不自建;
- 批准后行为按 **manifest/capability 推导的 authority mode** 分三种:`land`(land 变体,现链不动)/ `runner_ship`(图中存在 creates_pr 的 ship-capable 节点:批准→flip 已 park 的 implement session→approval wake→verify-approval→self-ship→merge 证据→run 收口)/ `engine_terminal`(无 code 产出:批准 claim 直接完成 run,v2 现有分支归位);
- founder feedback 走模板声明的 `founder_feedback_kickback` loop(非 land eng 模板补声明该 loop = 纯拓扑改动,复用现有 kickback 分支去掉 land 门);
- 5+2 呈现面统一 Gate ownership fence;canonical ship_ready 通知对 holder-backed gate 让位(exactly-once)。

### 方向 B(否决)— Gate 到达唤醒 runner、由 runner 自建 question

载体创建依赖 runner 存活/prompt 正确/wake 不丢,crash/duplicate wake 下无法证明不提前/不漏/不双发 —— 无法形成引擎不变量(rework-research-notes 五)。

### 已否决形态(不再回头)

通知器查 QA claim;模板名白名单;只修 prompt 不建 server-side fence;只发非权威 notice 不补载体(Codex HIGH);默认全量扩面 + 首 tick 回填历史 gate(惊动 founder,无细粒度回滚)。

## 6. 非目标

- 不改 eng 模板 `design→implement→qa→gate` 主拓扑(补 founder_feedback loop 是声明性追加);
- 不新增 `qa_required`/`no_qa_reason` 类字段;通知器不遍历 QA 节点、不查 QA claim;
- 不恢复/依赖 auto-QA(FLY-1261 照删);
- 不动 legacy 非 engine 流程(无 typed engine binding 一律 byte-compatible);
- 不做历史 gate 回填(no backfill;在途 run 过渡语义显式定义)。
