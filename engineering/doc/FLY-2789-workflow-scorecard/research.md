# FLY-2789 节点成绩记录 — 调研
Issue: FLY-2789 (https://linear.app/geoforge3d/issue/FLY-2789/2787-b成绩记录-每张单每个节点记下用的模型组别并记-qa-是否一次过founder-打回次数额度花费耗时按组汇总每张一次过-qa)
日期: 2026-09-22
基于: exploration.md

## 结论
最小完整方案是复用工作流的不可变身份与结果回执，补一份按 activation 关联的用量明细，再提供本机只读 CLI。不能只给已有日报加 GROUP BY：日报已丢失节点/执行身份，且只有 Claude 来源。本阶段没有写实现、跑生产探针或声称功能已能用。

## 当前源码证据（基线 32df6c2ee）
| 位置 | 已确认事实 | 对设计的影响 |
|---|---|---|
| `packages/teamlead/src/StateStore.ts:30730` | workflow_run 包含项目、issue、run；别名独立表 | 单数不能数 run 行 |
| `StateStore.ts:30925,41887,64419` | node attempt 行的 execution_id 在换体时可被覆盖 | 必须查全部 immutable activation |
| `StateStore.ts:8074,32510,44139` | workflow_execution_binding 的 activation_id 主键与 (execution,run,node,attempt) 唯一约束；spawn/wake/replacement | 作为每次节点执行的身份来源 |
| `StateStore.ts:32733,44162` | workflow_execution_runtime 按 execution 写一次，存 vendor/model/effort | wake 不能借原始 attempt 推当前归属；启动模型不等于供应商实际返回模型 |
| `workflow-dispatch-resolution.ts:23,110` | 从 design_model_arm_assigned 找已冻结 assignment，支持 parity/percentage | 旧分组可读；不复制分流算法 |
| `workflow-menu.ts:50` | WorkflowModelAssignmentReceipt 含 arm/modelAlias/model/basis.ruleVersion | 组稳定身份复用版本+arm，显示标签另列 |
| `StateStore.ts:44185,44266` | dispatch_vendor_resolved 与 execution_admitted 记录分配和 activation | audit 缺行不能当作确认未分流 |
| `StateStore.ts:32376,62092,62361` | QA claim 有 server_seq；提交、消费凭据、状态转换同事务 | 成绩读已提交 claim，不读事后通知 |
| `StateStore.ts:62160` | 相同 request+digest 重放复用 claim；冲突拒绝 | 不自建 QA 计数器 |
| `StateStore.ts:6050,65677` | founder verdict 不可变、source_event_id 唯一、含 founder_authored | 真实打回独立于路由 authority |
| `StateStore.ts:49396,63363,66395` | Lead 可转真实 founder 意见；engine 可继承 founder authority；历史 founder lane 可能无作者证明 | 只数 verdict=rework 且 founder_authored=1 |
| `packages/token-usage/src/scanner.ts:39,64,89` | Claude jsonl 按 requestId 去重、cwd 分类 | 保留现有日报；新节点账需要原始 session/时间/请求身份 |
| `packages/token-usage/src/types.ts:28,47` | UsageRecord 无 execution/session；daily 表为 day/scope/dimKey | 无法从日汇总反推节点用量 |
| `packages/token-usage/src/store/local-sqlite-store.ts:47` | 构造会设 WAL 并迁移 | 禁止只读查询复用此构造器 |
| `packages/claude-runner/src/TmuxAdapter.ts:499,1152,1218` | 启动前生成 Claude sessionId，结果回传 session，duration 为进程存活 | 可在启动时持久绑定，不能等结束才留关联 |
| `packages/claude-runner/src/CodexTmuxAdapter.ts:1535,1993,2160` | thread ready 即持久 session；返回没有 token 总数 | 复用 ready seam，新增独立用量记录，不能只补 return 字段 |
| `packages/claude-runner/src/codex-daemon-client.ts:990,1009,1752` | thread/turn 通知可观察；goal token 是累计值 | 不能每次通知相加，也不能当每次 activation 消耗 |
| `packages/teamlead/src/lead-backends/codex/context-usage-recorder.ts:32` | 已有 thread/tokenUsage/updated 解析及 append 模式 | 仅参考边界校验；上下文占用不是计费明细 |
| `packages/claude-runner/src/codex-rollout-probe.ts:12` | 精确 execution → home → thread 的只读定位 | 不全盘猜日志路径 |
| `packages/teamlead/src/patrol-continuity-collector.ts:199` | better-sqlite3 readonly/fileMustExist 直接读 | 采用轻量 CLI，不启动 StateStore/迁移 |

## 必须保护的反例
1. 同一个 QA attempt 换 execution：node 行只剩新 execution，但旧用量不能消失。
2. 同一个 execution wake 到 attempt 2：直接按 execution JOIN 两次会翻倍。
3. founder 重测后首次通过仍是原始事实；不能靠 current_qa_attempt 推首过。
4. QA 输出 pass 但事务回滚：不能计 pass；旧 claim 失效不应抹掉历史失败事实。
5. founder authority 被 engine 沿验证链复制：不能每条 request 算一次 founder 打回。
6. Claude 输入 token 不含 cache read/write；Codex input 可能已含 cached 部分：未经归一化会重复加缓存。
7. 启动模型是别名：只有 runtime.model 不能宣称 exact observed model。
8. 同 origin 的 HTML localStorage 共享：意见 key 必须包含 pathname。

## 实现约束
- 现有工作流 dispatch/read-only/receipt 模式均来自本地源码；不涉及购买服务或引入外部产品，不需要外部技术替代研究。
- 现有 better-sqlite3、zod、Node readline/fs 足够；不加依赖、不加服务、后台汇总表或额外 outcome ledger。
- 新观测信息不授予工作流权限；不把 runner 提交的 activation/model/group 当服务器裁决。
- 可靠采集要保留原始来源定位、幂等键和消费游标；崩溃后补读，不能靠一次 best-effort 回调。
- phase 完成可能发生在模型 turn 中间：请求/turn 开始时冻结归属，结束后迟到用量仍归原 activation。
- 常驻 phase 间等待不算下一次执行；本期明确提供服务端墙钟占用时间，不宣称模型推理时间。

## 待决与落实方式
非阻塞问题 b73345b0-9966-4203-ab26-113e4fe3b657 等待 Lead。设计按注入范围直接推进，最终必须通过显式 design review；通用 skill 的额外 brainstorm/research 人工 gate 不覆盖本任务的 bounded node 指令。A 未落地前支持已存在的旧 assignment 和确认无分流，未来消费 A 的真实 receipt，不在 B 硬编码三组/两组模型映射。

## Lead 已答复
问题 b73345b0-9966-4203-ab26-113e4fe3b657 已确认全部指标口径，并要求 B 冻结 A 的读接口（runId/nodeId/policyVersion/arm/resolvedModel/assignedAt），A 按该形状写；完整来源内没有 receipt 记 unassigned。08c2bc2e-4e88-4728-a758-a194a90a8cd8 确认复用旧 receipt 与真实判决方向。具体合同见 plan.md §2.2a。

## 新范围的证据边界
后到 Lead 指令 fa066f60-0a86-46f4-99a0-1a14c956fe79 与答复 b4105797-3065-4798-b529-344d588bec94 冻结 implement 维度及 model_arm_degraded reader 契约。它们是 A 将实现的契约，不是当前基线已经具有的能力。实现阶段必须检查 A 的真实产物与三维 fixture；详见 plan §2.2b/7。
