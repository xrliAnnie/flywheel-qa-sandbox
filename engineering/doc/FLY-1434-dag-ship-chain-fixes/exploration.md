# FLY-1434 DAG ship 链小修族批 — 探索

Issue: FLY-1434 (https://linear.app/geoforge3d/issue/FLY-1434/engine族批-dag-ship-链小修-3-统一重启改造-pr-回写绑定-runs-start-假成功-闭-run-rework-入口)
日期: 2026-07-23
基于: 无

## 1. 任务边界

2026-07-22 深夜 DAG ship 链真机实测（1373/1375/1380/1407/1423/1426 等首批 DAG 单）暴露的引擎缺陷，按 Annie 口径合批修（小修并族单）。Issue 正文含 ①-⑥；派单前 Tadashi 增补评论（2026-07-23 05:37Z）追加 ⑦-⑩，与本族同批设计。

**明确不做**：
- QA-issue 递归 auto-QA 豁免 → 归 FLY-1261
- bridge-only 补通告 → 模式整体删除（④ 覆盖）

## 2. 缺陷清单与实证

| # | 缺陷 | 实证 | 危害 |
|---|------|------|------|
| ① | DAG implement 开 PR 后不回写 sessions.pr_number / pr_head_sha | 2026-07-22 全部 DAG 单 pr_number 全空；1423 靠 Lead 手动 SQL 应急绑定 | workflow_ship_ready 全部显示「PR 未绑定」，ship 链断在最后一环 |
| ② | /api/runs/start 对不可入 run 返回 success:true + 旧 executionId、零 spawn | 802（completed run）、1418（dispatch 指向旧 design 节点） | Lead 误报 founder「已启动」，假成功 |
| ③ | completed / blocked run 无返工入口 | 802 无返工入口；1418 blocked 节点 retry 被 admission 拒 `successor_not_reserved`；都只能开接替新单（1435/1436） | 返工只能靠旁路开新单，run 语义失真 |
| ④ | 分档重启（--bridge-only 等）造成部署不一致 + 重启不通告 | Annie 直令：删除一切分档重启入口 | 半部署、通告靠人记 |
| ⑤ | founder thread 回 ship 对 DAG 单无处落笔 | 2026-07-23 03:18 Annie 在 1423 thread 回 ship，消息摄取 ✓ 但零批准写入，引擎停在 founder_gate | self-ship 断链最后一环：FLY-945 批准识别只写三段式 CommDB approve_to_ship gate，DAG founder_gate 只认 workflow decision API |
| ⑥ | 多 PR 单 PR-1 合入即判「完成」 | 1426 两 PR（跨仓），PR-1 合入即收口、PR-2 无人接（1437 补），PR-1 单独部署净负（receipt storm） | 半 ship：部分部署上线 + 剩余交付无人认领 |
| ⑦ | wake_failed 假阳风暴（反向激励） | 一晚 ~17 条 wake_failed 全部来自 Lead 与健康 running runner 的正常对话（1435/1436/1437/1364），30min 无人处置即 auto-page founder | Lead 越尽责、误报越多；page 疲劳 |
| ⑧ | 结构化 review verdict 投递卡 open | FLY-1364 gate b7ce78bf reviewer response 05:07:46Z 写入 CommDB 但 delivered_at=NULL / relay_state=open 挂 15+ 分钟，runner 空轮询「No reviewer output yet」，最后 Lead 手动 send | review 闭环靠人肉递送 |
| ⑨ | 跨仓（plugin fork）review 绑定缺失 | FLY-1437：真代码在 nested worktree plugin fork（cd7f0a6d），request-review 冻结的是 Flywheel session HEAD | 结构化 review 绑不到真被审对象，只能 legacy codex lane workaround |
| ⑩ | codex_review_record 绑 exec 错位（FLY-1255 复发） | FLY-1435：approved 记录绑在 implement exec（36bbe2a9），ship 时 verify-approval 按持 TURN/QA 的 exec 查 → 查无行卡死 | executor-merge 已退役（FLY-945），此账无人工兜底 |

优先级：⑦⑧ 一晚内高频实证，与 ① 同优先（Tadashi 口径）。

## 3. 核心问题（探索目标）

1. ①：DAG implement 节点完成时引擎手里有什么（PR URL/号从哪来）？三段式路径在哪写 pr_number，DAG 路径缺在哪一跳？
2. ②：/api/runs/start 的 admission 判定在哪，为什么 completed run 会拿到 success + 旧 executionId？现有原因码有哪些？
3. ③：6b42de3f 的 rework coordinator 究竟覆盖什么（completed run？blocked 节点？触发面是谁）？
4. ④：现存重启入口全景（脚本、flag、调用方、文档引用），现有通告机制（FLY-1081）接在哪。
5. ⑤：FLY-945 批准识别的落笔点，workflow decision API 的入参/授权/consent 语义，thread→run 映射怎么解析。
6. ⑥：单的 Done/ship 判定在哪做，「计划声明的全部 PR」这一概念是否已有承载。
7. ⑦：wake pointer 何时建、started 收据谁发、running runner 为何也建 pointer。
8. ⑧：reviewer response 行谁写、谁递、runner 轮询面读哪张表。
9. ⑨：request-review 冻结 HEAD 的位置，被审对象的标识结构。
10. ⑩：codex_review_record 的键结构与 verify-approval 的查询键为何错位。

## 4. 探索结论（代码盘点摘要）

4 路并行代码探索完成（细节全部在 research.md，含 file:line）：

- **①** DAG 完成走 enrolled 路径在 `event-route.ts:769-808` 提前 return，绕过全部 legacy PR 写入器；`commitEnrolledCompletion` 把 runner 已上报的 `landingStatus.prNumber` 丢弃。读侧（ship_ready 组装 + land 节点）都靠 `getWorkflowRunPrNumber` 反查 sessions → DAG 必「PR 未绑定」，land 会抛 `engine_land_authority_unavailable`（①⑤ 强耦合）。
- **②** 假成功 = `/api/runs/start` 的 idempotency 缓存回放（`runs-route.ts:1711-1718`）不校验 run 存活、无 TTL；dedup 有两个豁免口把请求漏进回放。
- **③** rework coordinator（6b42de3f）只做 active run 上已预留节点的 re-entry；completed run（802）与未预留 blocked 节点（1418）都在盲区；且全自动触发、无 operator 入口。表结构（authority 含 'founder'）已备。
- **④** `--bridge-only` 有活体调用方（setup-quota-monitor.sh ×2）+ restart-guard hook 文案 + config 注释多处引用；通告 `notify_routine()` 已存在（FLY-1081 claw-infra-bot → #flywheel-notify），bridge-only 是唯一静默分支。
- **⑤** CommDB gate 物化链（holder→materializer→GateAuthorityView）三处 land_v1 guard 卡死非 land DAG 单；issue 说的「调 workflow decision API」结构不通（decision API 能力族无 founder_approved），正确落笔面 = `workflow_source_event(founder_approval)` → claim；FLY-945 识别 + consent 语义可整链复用。
- **⑥** 三条完成机制全单 PR 假设，多 PR 处处被当 error；「声明 PR 集」无承载结构。
- **⑦** wake pointer 在 send 时无条件建（`admitReceiptWakeIntent` 无状态检查），started 收据只有 `inbox` 一个来源，T2 nudge 又拒 running 非 parked → 结构性假阳。
- **⑧** review verdict 写入后只有一次裸 mailbox wake（无收据无重推），response 无 delivered 标记语义；codex lane 不轮询 → 丢一次即永挂。
- **⑨** request-review payload 无 repo/sha 字段，head 只从 session worktree rev-parse —— 嵌套 fork 场景绑错对象是结构必然。
- **⑩** `codex_review_record` PK=(execution_id, head)，写方绑 implement exec、查方绑 ship exec → 必 miss；issue 引 FLY-1255 是勘误（真血缘 FLY-827/1188/945）。

## 5. 方向性共识

- 族批 = 一单多修，但每一修必须独立可验收（issue 验收标准逐项列了真机复现→修→复验）。
- ④ 是运维契约改造（删入口 + 通告内置），与 ①②③⑤⑥⑦⑧⑨⑩ 的引擎修互相独立，可并行实现。
- ⑤ 是 self-ship 打通的最后一环：修完 + consent enforce 后 DAG 单才真 self-ship —— 设计必须保 consent audit_only/enforce 语义不变。
- ⑩ 的方向 issue 已给：review record 键按 issue+head（或 ship 验证方切到按 head 查），不按单一 exec。
