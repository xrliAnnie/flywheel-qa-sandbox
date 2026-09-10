# FLY-2453 自动合并窄口开关 — 调研
Issue: FLY-2453 (https://linear.app/geoforge3d/issue/FLY-2453/2309b45-自动合并窄口开关founder-一句现在放开-现在停止切换开着时同时过三道闸机器判纯文档-人声明-pure-docs)
日期: 2026-09-08
基于: exploration.md

## 结论

现有数据足以判三闸，现有 CommDB 源事件足以保证「答卡与审计一起提交」。缺的是 founder-only 开关入口、带证据的自动批准来源，以及对自动样本诚实分组的报表。不能只给 `feature-flags` 注册一个三态值，也不能把新 actor 塞进通用 founder 白名单。

代码基线 `d7b75c755`（FLY-2398 / #1130）。本次证据来自工作树源码、已合入设计与测试；issue 描述来自本次派发及 `.claude/skills/linear-issue-context/SKILL.md`。未修改生产开关、数据库或服务。未重新测量生产强度二行数；旧文档中的「0 行」不当作当前事实。

## 1. 开关路径

- `packages/flywheel-comm/src/commands/feature-flags.ts:115`：set / apply / clear 统一通过 `/api/fleet/flag/stage` 与 `/apply`。项目默认 `*`；reason 是自由文字；没有 Lead 身份校验。
- `packages/teamlead/src/bridge/plugin.ts:2716`：组合 `FlagRouteDeps`。路由目前同步，仅 loopback host + Origin。
- `packages/teamlead/src/bridge/flag-routes.ts:266`：项目路径允许通配符及 clear，actor 固定 `bridge-local-operator`。因此新窄口必须在 generic 路径前分流，stage/apply 都验证，通用 helper 也拒绝它。
- `packages/teamlead/src/StateStore.ts:6325`：`applyScopedFlagValueChange` 在事务里更新 `flag_values`、追加 `flag_value_changelog`，以 `expectedChangeSeq` 防止 delete/recreate 后的陈旧写。可复用私有写核；不能靠 caller 传 `actor` 授权。
- `packages/teamlead/src/bridge/flag-store-runtime.ts:90`：当前 reader 回退 `*`。窄口只能读显式命名项目的行与有效授权记录，不能继承通配符。
- `packages/config/src/feature-flags/registry.ts:24`、`store-policy.ts:273`：项目 flag 目前必须伪装成 `project_config + configKey`。需要显式新增 founder 控制元数据的窄分支，使用现有 `source=code_default`，不引入环境变量或 YAML seed。
- `packages/teamlead/src/bridge/feature-flag-render.ts:245`：项目控制会忽略 toggleable 元数据，因此必须显式禁止该 flag 的通用按钮 / clear 命令。展示可用，展示不能创建授权。

## 2. Founder 与 Lead 身份

- `flywheel-comm/lead-lease.ts` 的 `authorizeLeadWrite`、`postCarrierClaim` 与 `commands/respond.ts:62` 提供现有 Lead 租约 / carrier 凭据通路。租约是进程身份凭据，不是 founder 授权。新 CLI 复用，服务端再次验证当前 Lead 身份与项目归属，不能接受 body 的 leadId 当事实。
- `bridge/runs-route.ts:266` 的 `parseFounderMessageRef`、同文件 founder-message 路径会从 Discord 取回原消息并核作者。`bridge/auto-merge-shadow-route.ts:188` 展示严格频道、作者、未编辑、时间与内容验证。
- 对本单只识别配置的工程 Lead 频道（按Lead裁定不接受子thread），内容仅剥离首尾空白/有限标点后与 `现在放开` / `现在停止` 两个常量全等；不增加自然语言分类器，不从聊天自动调用切换。完整引用由 `--founder-message-ref <channel>/<message>` 提供，reason 仍为 `founder <message>`。此选择已向 Lead 发非阻塞问题，最终答复收于 plan。
- 当前官方威胁模型是可信本机 Flywheel 进程间的角色隔离。`verify-approval.ts:37` 已说明可直接改本机库的人能伪造本地来源；本单不宣称实现同 OS 用户间的安全隔离。

## 3. 现有答卡与合并

1. `bridge/gate-materializer.ts` 铸造 `workflow_gate_holder`、CommDB question 与 Discord 卡。只有 `authority_mode=land`、`subject_kind=git_head`、当前 `awaiting_review` 且卡已投递的 holder 可进入窄口。
2. `bridge/approval-signal/write-gate-response.ts` 是现有人工可信答卡入口。
3. `packages/flywheel-comm/src/db.ts:2398` 的 `insertFounderApprovalResponseWithSource` 在 **CommDB IMMEDIATE 事务**中检查 question 未回答 / 未 supersede，写 response 和 `workflow_source_event`。任一 INSERT 失败全部回滚。
4. `bridge/founder-approval-projector.ts` 按 durable rowid cursor 导入源事件；StateStore receipt 使重放幂等。源事件格式错误进入 deadletter，临时失败保留重试。
5. `StateStore.ts:54859` 的 `applyWorkflowSourceEvent` 在 StateStore 事务里校验 head / 当前门权、写 `workflow_claims`、判决、holder approved、land 激活与 receipt。后续 engine land 仍检查自己的条件。

必须保留这条恢复路径，不能先裸写 `approved:true` 再另记审计，也不新造直接 `gh pr merge`。

## 4. 跨库停止顺序

- StateStore 的 `CompatDb` 已使用 native better-sqlite3（`StateStore.ts:560`）；可用 `this.db.raw.transaction(fn).immediate()`。现有 `this.db.transaction(fn)` 默认 DEFERRED，不能承诺先锁后读。
- 新窄口使用固定顺序 **StateStore IMMEDIATE → CommDB IMMEDIATE**。StateStore 外层只读，锁住 flag / holder / 声明 / 证据；CommDB 内层只做同步最终重验、response + source 提交；外层释放。所有网络请求在锁外，无 await。
- 停止到dry_run通过同一个 StateStore 写库串行化；因此dry_run先提交则窄口不批准，窄口 response 先提交则属于已批。CommDB 提交后 StateStore 锁释放失败或进程崩溃，不丢批准来源，因为外层没有待提交的权威写。
- 审计过的 flag、人工答卡、source projector 路径未发现反向持锁。实现须补同进程入口测试及两个 SQLite 连接的锁序测试；不得把该观察夸大为全仓任何数据库调用都已审过。
- 未处理的 founder 拒绝不只在判决账本：CommDB 待投影 `founder_feedback`、已接收未分类的 `founder_decision_convergence`、延迟拒绝也可能先到。最终检查必须覆盖这些未结输入，无法绑定到 head 的同 issue 输入也先阻止自动批。

## 5. 三道闸的事实源

- `StateStore.ts:54681` 的 `recordAutoMergeShadowObservationTx` 读取 B1 `resolveRunShipRelevance`、当前全部声明仓候选和 nested reviews。机器分类是整个 run 的 PR 集合，不能只检查主仓。
- `StateStore.ts:54711` 读取 exact `(run, repo identity, head)` 且不晚于观察时间的强度二行，再调用 `strength-two/judge.ts:evaluateStrengthTwo`。该函数优先选最新 satisfied 行，否则最新 unsatisfied 行；不得改成简单「最后一条」，不得拼接两条不同记录的两半。
- `StateStore.ts:51047` 的 `recordAutoMergeShadowDeclaration` 按 question 追加序号。B4 的声明由 Lead bot 身份确认（代理声明，不是人类逐卡批准）；复用它，不另造第二套 `pure_docs` 输入。自动批只用此刻该卡最大 sequence，冻结 declaration_id / sequence。
- B4 观察是**判决之后**写的历史证据；不能查它来判未批准卡。抽取现有事实构造函数供 B4 与窄口共用，判定核仍只有一份。
- `StateStore.ts:54830` 故意 catch 观察失败，让人工批准继续。本单必须增加自动分支的严格插入：观察 / 自动审计 / 判决 / claim / receipt 任一失败，整个投影回滚，不放行 land；人工 best-effort 分支不改。

## 6. 批准身份的消费者陷阱

- `packages/flywheel-comm/src/founder-attribution.ts` 的通用可信集合同时用于 ship 和 founder_review；把 `bridge-auto-narrow-gate` 加进去会扩权到别的门。
- 窄口 actor 只加到 **reserved** 检查，保持 `isTrustedApprovalAttribution` 对它为 false。独立的 ship-only 证据校验核验证绑定的源事件与自动审计；仅 `land` holder 可以用。
- 必须审 `commands/verify-approval.ts`、`bridge/external-merge-reconcile.ts`、`bridge/approval-signal/write-gate-response.ts`、`bridge/founder-consent/gate-response-router.ts`、`founder-review.ts`，分别新增窄读或明确保留拒绝，不整体放宽。
- 定向 producer sweep 未发现 HTTP/CLI 的任意 workflow_source_event append 接口；当前生产批准来源均来自可信 writer，其它固定 producer 为 turn_grant / land_departure_cutoff。原始 SQLite/module 写权不在本单防伪承诺内。

## 7. 影子报表与 retention

- `engineering/doc/FLY-2398-auto-merge-shadow-run/shadow-table.sql:26` 的全集由真实 claims/rework/deadletter 独立构造，四线覆盖率不能用观察表自己当分母。
- 当前 SQL `:139` 用窗口结束之前最新声明。自动分组要改用批准时冻结的 declaration_id，后来修正不能改写当时「过闸」的证据。
- `:381` 的 N1/N2 是人工评估指标。自动批准没有人工判断，不能算成「她没有打回，因此正确」。人工指标单列；自动组显示总批准数、独立人工复核数、打回/复核数及未复核数。零复核必须报不可判。
- `scripts/fly-2398-shadow-table.mjs` 的 required tables / renderer 和 `scripts/__tests__/fly-2398-shadow-table.test.mjs` 同改。旧版 `FLY-2396.../retro-bind.sql` 的 cohort 显式排除新自动源，防止误归因。
- `fly2398-no-gating-readers.test.ts`、`fly2396-no-gating-readers.test.ts` 的冻结 allowlist 只增新窄口读者；其余 land / review-hold 不读影子结果。
- 新增控制授权、自动审计表须进入 `scripts/lib/fly-2006-retention-registry.mjs`、生产表 fixture、StateStore sweep 计数与 consumer gate。append-only 权威记录归 protectedCurrentOrReference，不按普通 TTL 清掉被拒绝 head 或开启证据。

## 8. 设计输出与工具

本地 `mmdc` 存在，最终流程与模型用 Mermaid 源码生成独立 SVG ID。未找到独立 html-report-style 文件，采用已合入 FLY-2398 HTML 的 Apple-light 外观，不继承它的表格或外部依赖。报告用结论、流程、结构、取舍、边界、验证、下一步的零表格骨架。

后续只需要针对这个授权例外的明确测试与交接，不需要浏览外部技术建议，也不需要部署或打开生产开关来证明设计。

## 9. 新增范围与最终口径

Lead指令65835c4e修正默认模式为dry_run，只展示意见；auto才自动批准；off完全静默。配置schema必须支持enum，不再使用布尔enabled或on/off解析。三态同一DB flag控制意见及批准，不新增第二个开关。Lead问答c63827c4确定200人工卡窗口、eligible子集precision主指标、Wilson95%下界（b<5样本不足）、动作一致次指标、98%纯展示。每卡意见与emoji新增投递消费者、历史opinion快照和恢复状态；详见plan §5/8/9。

## R1 评审后的审计补充

- `auto-merge-shadow-route.ts:207` 强制 Lead bot 作者，故所有交付统一叫代理声明。Lead c231bc31 确认这就是提交侧声明，无新增人类入口。
- `store-policy.ts` project-scope 与 enum-codec 是两个独立 authoring gate，需受保护spec的两个窄分支；严格写入与读取损坏值时降级分开。
- `StateStore.ts:3210` 已有幂等迁移收据；本轮以开启消息十分钟时效和snowflake单调顺序防历史授权；停止无墙钟年龄限制，不拿部署时间或重启清空历史。
- `approval-signal/founder-ack.ts` 已有 bot PUT @me reaction，复用低层能力并补 DELETE，保留原行为。
- 根 `pnpm test` 会递归触达真实 Terminal.app 测试；本单只执行目标包与明确排除桌面副作用的回归。

- R2审计确认 `fly2396-no-gating-readers.test.ts` 的“每个授权读者都不可读authorship”也需重述：FLY-2453增加人工rework的负向否决，authorship仍不能独立提供正向批准。与B4一样重命名/改文案/钉精确读者及负例。
- Lead b19c5f83覆盖旧双向时效：auto限十分钟并容忍5秒未来时钟偏差；dry_run不受消息年龄限制，顺序仍阻止旧stop覆盖更新auto。
